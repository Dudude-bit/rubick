//! Pod-specific commands

use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

use futures::future::join_all;

use k8s_openapi::api::core::v1::Pod;
use kube::api::ListParams;
use tauri::State;
use tokio::sync::oneshot;

use crate::commands::filters::PodFilters;
use crate::commands::helpers::{
    api_in, gathered, get_resource_info, reaches, scope_of, ResourceContext, UnreadNamespace,
};
use crate::error::Result;
use crate::resources::{PodInfo, PodRow};
use crate::state::perf::{chunks_within, IPC_TARGET_BYTES};
use crate::state::streams::SUBSCRIBE_TIMEOUT;
use crate::state::{AppEvent, AppState};
use crate::utils::{elapsed_ms, generate_id};

/// Rows per API page: one round trip's worth, converted and sent on before
/// the next is asked for, so the first rows land before the last are read.
const PAGE: u32 = 500;

/// List pods, narrowed by the terms `PodFilters` names.
#[tauri::command]
pub async fn list_pods(
    filters: Option<PodFilters>,
    state: State<'_, AppState>,
) -> Result<Vec<PodInfo>> {
    let filters = filters.unwrap_or_default();
    let ctx = ResourceContext::for_list(&state, filters.base.namespace.clone())?;
    let api: kube::Api<Pod> = ctx.namespaced_or_cluster_api();

    let mut lp = ListParams::default();
    if let Some(label_sel) = filters.build_label_selector() {
        lp = lp.labels(&label_sel);
    }
    if let Some(field_sel) = filters.build_field_selector() {
        lp = lp.fields(&field_sel);
    }
    if let Some(limit) = filters.base.limit {
        lp = lp.limit(limit.try_into().unwrap_or(u32::MAX));
    }

    let started = std::time::Instant::now();
    let pod_list = api.list(&lp).await?;
    let fetched_ms = crate::utils::elapsed_ms(started);
    let mut pods: Vec<PodInfo> = pod_list.items.iter().map(PodInfo::from).collect();
    // The reported cost of this page is seconds on a hundred pods, and the
    // split between the API round-trip and everything after it is the whole
    // diagnosis — visible under RUST_LOG=info without a profiler in hand.
    tracing::info!(
        count = pods.len(),
        fetch_ms = fetched_ms,
        total_ms = crate::utils::elapsed_ms(started),
        "list_pods"
    );

    // Client-side, and against both readings of "status": the caller may
    // be naming the phase (`Running`) or the status the app shows
    // (`CrashLoopBackOff`), and only one of those is a phase at all.
    if let Some(status) = &filters.status_filter {
        pods.retain(|p| {
            p.status.phase.eq_ignore_ascii_case(status)
                || p.status.display.eq_ignore_ascii_case(status)
        });
    }

    Ok(pods)
}

/// How a paged read ended: how many rows went out, and whether that was all of them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Paged {
    pub rows: usize,
    pub complete: bool,
}

/// Read every page of `api`, handing each page's rows to `on_rows` as it
/// lands, until the last page or `cancel`.
pub async fn page_rows<F, C>(api: &kube::Api<Pod>, mut on_rows: F, cancel: &mut C) -> Result<Paged>
where
    F: FnMut(Vec<PodRow>),
    C: Future + Unpin,
{
    let mut lp = ListParams::default().limit(PAGE);
    let mut total = 0;
    loop {
        let page = tokio::select! {
            biased;
            _ = &mut *cancel => return Ok(Paged { rows: total, complete: false }),
            page = api.list(&lp) => page?,
        };
        total += page.items.len();
        on_rows(page.items.iter().map(PodRow::from).collect());
        match page.metadata.continue_.filter(|token| !token.is_empty()) {
            Some(token) => lp.continue_token = Some(token),
            None => {
                return Ok(Paged {
                    rows: total,
                    complete: true,
                })
            }
        }
    }
}

/// How a read of the scope's pods ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopePaged {
    pub rows: usize,
    pub complete: bool,
    pub unread: Vec<UnreadNamespace>,
}

/// Page every reach of `scope` at once until each has ended, or `cancel`.
///
/// Rows go to `on_rows` as they land, a namespace that fails partway
/// included: `unread` names it, and the rows it did send are not its list.
/// The rules for several answers are [`gathered`]'s.
pub async fn page_scope<F>(
    client: &kube::Client,
    scope: Option<&[String]>,
    on_rows: F,
    cancel: &mut oneshot::Receiver<()>,
) -> Result<ScopePaged>
where
    F: Fn(Vec<PodRow>) + Sync,
{
    let sent = AtomicUsize::new(0);
    let counted = |rows: Vec<PodRow>| {
        sent.fetch_add(rows.len(), Ordering::Relaxed);
        on_rows(rows);
    };
    let walks = join_all(reaches(scope).into_iter().map(|reach| {
        let api = api_in::<Pod>(client, reach);
        let counted = &counted;
        async move { page_rows(&api, counted, &mut std::future::pending::<()>()).await }
    }));
    let answers = tokio::select! {
        biased;
        _ = &mut *cancel => {
            return Ok(ScopePaged {
                rows: sent.load(Ordering::Relaxed),
                complete: false,
                unread: Vec::new(),
            });
        }
        answers = walks => answers,
    };
    let unread = match scope {
        Some(names) if names.len() > 1 => {
            let answers = answers
                .into_iter()
                .map(|walk| walk.map(|_| Vec::<()>::new()));
            gathered(names.to_vec(), answers.collect())?.unread
        }
        _ => {
            for walk in answers {
                walk?;
            }
            Vec::new()
        }
    };
    Ok(ScopePaged {
        rows: sent.load(Ordering::Relaxed),
        complete: true,
        unread,
    })
}

/// Start listing the scope's pods as rows. They arrive in `pod-rows-batch`
/// events, each under the IPC target, and the end as exactly one
/// `pod-rows-done` or `pod-rows-failed`.
#[tauri::command]
pub async fn list_pod_rows(
    scope: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<String> {
    // Checked here so a bad scope is refused before a stream id exists.
    let scope = scope_of(scope)?;
    state.current_client()?;
    let context = state.get_current_context().ok_or_else(|| {
        crate::error::Error::Internal(crate::error::messages::NO_CLUSTER.to_string())
    })?;
    let clients = state.client_manager.clone();

    let stream_id = generate_id("pods");
    let mut opened = state.pod_row_streams.open(stream_id.clone());
    let event_tx = state.event_tx.clone();

    let id = stream_id.clone();
    tokio::spawn(async move {
        if !opened.wait_for_subscriber(SUBSCRIBE_TIMEOUT).await {
            // A terminal event on every path, including this one. Tauri
            // events have no replay, and a reader that installed its
            // listeners and was then cancelled would otherwise wait on a
            // promise nothing ever settles.
            let _ = event_tx.send(AppEvent::PodRowsDone {
                stream_id: id.clone(),
                rows: 0,
                complete: false,
                elapsed_ms: 0,
                unread: Vec::new(),
            });
            return;
        }
        let (mut cancel_rx, _held) = opened.split();
        // After the gate, not before it. The task can sit here for a minute
        // waiting to be subscribed, and CLAUDE.md states the rule: a held
        // `kube::Client` carries a token that expires. Taken per run, so a
        // renewal that happened while this waited is the one used.
        let Some(client) = clients.get_client(&context) else {
            let _ = event_tx.send(AppEvent::PodRowsFailed {
                stream_id: id.clone(),
                message: crate::error::Error::NotConnected(context.clone()).to_string(),
            });
            return;
        };
        let began = Instant::now();
        let outcome = page_scope(
            &client,
            scope.as_deref(),
            |rows| {
                for chunk in chunks_within(rows, IPC_TARGET_BYTES) {
                    let _ = event_tx.send(AppEvent::PodRowsBatch {
                        stream_id: id.clone(),
                        rows: chunk,
                    });
                }
            },
            &mut cancel_rx,
        )
        .await;
        let terminal = match outcome {
            Ok(paged) => {
                tracing::info!(
                    count = paged.rows,
                    complete = paged.complete,
                    total_ms = elapsed_ms(began),
                    "list_pod_rows"
                );
                AppEvent::PodRowsDone {
                    stream_id: id.clone(),
                    rows: paged.rows,
                    complete: paged.complete,
                    elapsed_ms: elapsed_ms(began),
                    unread: paged.unread,
                }
            }
            Err(error) => AppEvent::PodRowsFailed {
                stream_id: id.clone(),
                message: error.to_string(),
            },
        };
        let _ = event_tx.send(terminal);
    });

    Ok(stream_id)
}

/// The frontend's listeners are up; let the rows flow.
#[tauri::command]
pub fn pod_rows_subscribed(stream_id: String, state: State<'_, AppState>) -> Result<()> {
    let _ = state.pod_row_streams.subscribed(&stream_id);
    Ok(())
}

/// Stop a list that is still arriving.
#[tauri::command]
pub fn stop_pod_rows(stream_id: String, state: State<'_, AppState>) -> Result<()> {
    let _ = state.pod_row_streams.stop(&stream_id);
    Ok(())
}

/// Get a single pod by name
#[tauri::command]
pub async fn get_pod(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<PodInfo> {
    get_resource_info::<Pod, PodInfo>(name, namespace, state).await
}

/// Delete a pod
#[tauri::command]
pub async fn delete_pod(
    name: String,
    namespace: Option<String>,
    force: Option<bool>,
    state: State<'_, AppState>,
) -> Result<()> {
    let delete_params = if force.unwrap_or(false) {
        Some(kube::api::DeleteParams::default().grace_period(0))
    } else {
        None
    };

    crate::commands::helpers::delete_resource::<Pod>(name, namespace, state, delete_params).await
}

/// Restart a pod (delete and let the controller recreate it)
#[tauri::command]
pub async fn restart_pod(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<()> {
    // A standalone pod is simply gone; only a controller-managed one returns.
    delete_pod(name, namespace, Some(false), state).await
}

#[cfg(test)]
mod paging_tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// Answers two pages: the first carries a continue token, the second
    /// does not. Enough of the apiserver for `Api::list` to walk.
    async fn two_page_apiserver() -> (u16, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let handle = tokio::spawn(async move {
            let mut served = 0;
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut buf = [0_u8; 4096];
                let read = socket.read(&mut buf).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..read]).to_string();
                let more = !request.contains("continue=");
                let body = if more {
                    r#"{"kind":"PodList","apiVersion":"v1","metadata":{"continue":"next"},"items":[{"metadata":{"name":"a","namespace":"shop"}}]}"#
                } else {
                    r#"{"kind":"PodList","apiVersion":"v1","metadata":{},"items":[{"metadata":{"name":"b","namespace":"shop"}}]}"#
                };
                let answer = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(answer.as_bytes()).await;
                let _ = socket.flush().await;
                served += 1;
                if served >= 2 {
                    break;
                }
            }
        });
        (port, handle)
    }

    /// The paging loop, which until now ran in no test that CI executes:
    /// both harnesses for it are `#[ignore]`d and need a cluster. Every row
    /// has to arrive exactly once, and the answer has to say it is complete.
    #[tokio::test]
    async fn every_page_arrives_once_and_the_walk_says_it_finished() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let (port, server) = two_page_apiserver().await;
        let config = kube::Config::new(
            format!("http://127.0.0.1:{port}")
                .parse()
                .expect("a cluster url"),
        );
        let client = kube::Client::try_from(config).expect("a client");
        let api: kube::Api<Pod> = kube::Api::namespaced(client, "shop");

        let (_tx, mut cancel_rx) = oneshot::channel::<()>();
        let mut seen: Vec<String> = Vec::new();
        let paged = page_rows(
            &api,
            |rows| seen.extend(rows.into_iter().map(|row| row.name)),
            &mut cancel_rx,
        )
        .await
        .expect("two pages");

        assert_eq!(seen, ["a", "b"], "every page's rows, once, in order");
        assert_eq!(paged.rows, 2);
        assert!(paged.complete, "the walk reached the end of the list");
        server.abort();
    }

    /// Cancelling mid-walk is not an ending: the answer has to say it is
    /// incomplete, or the reader draws a short list as the whole truth.
    #[tokio::test]
    async fn a_cancelled_walk_does_not_call_itself_complete() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let (port, server) = two_page_apiserver().await;
        let config = kube::Config::new(
            format!("http://127.0.0.1:{port}")
                .parse()
                .expect("a cluster url"),
        );
        let client = kube::Client::try_from(config).expect("a client");
        let api: kube::Api<Pod> = kube::Api::namespaced(client, "shop");

        let (tx, mut cancel_rx) = oneshot::channel::<()>();
        drop(tx);
        let paged = page_rows(&api, |_| {}, &mut cancel_rx)
            .await
            .expect("a cancelled walk still answers");
        assert!(!paged.complete, "a stopped list is not a finished one");
        server.abort();
    }
}

#[cfg(test)]
mod scope_tests {
    use super::*;
    use crate::client::served::test_server::server;
    use serde_json::json;
    use std::sync::Mutex;

    fn pods(namespace: &str, names: &[&str]) -> String {
        let items: Vec<_> = names
            .iter()
            .map(|name| json!({ "metadata": { "name": name, "namespace": namespace } }))
            .collect();
        json!({ "kind": "PodList", "apiVersion": "v1", "metadata": {}, "items": items }).to_string()
    }

    fn forbidden() -> String {
        json!({
            "kind": "Status", "apiVersion": "v1", "status": "Failure",
            "message": "pods is forbidden", "reason": "Forbidden", "code": 403,
        })
        .to_string()
    }

    async fn paged(routes: Vec<(&'static str, u16, String)>) -> (Result<ScopePaged>, Vec<String>) {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let (client, _) = server(routes).await;
        let seen = Mutex::new(Vec::new());
        let (_tx, mut cancel_rx) = oneshot::channel::<()>();
        let scope = ["prod".to_string(), "staging".to_string()];
        let answer = page_scope(
            &client,
            Some(&scope),
            |rows| {
                seen.lock()
                    .unwrap()
                    .extend(rows.into_iter().map(|row| row.name));
            },
            &mut cancel_rx,
        )
        .await;
        (answer, seen.into_inner().unwrap())
    }

    /// The pods of the namespace that answered arrive, and the one that
    /// refused is named at the end. Dropping `unread` here is the old
    /// defect: a shorter list drawn as the whole scope.
    #[tokio::test]
    async fn a_refused_namespace_is_named_at_the_end_of_the_scope() {
        let (answer, seen) = paged(vec![
            (
                "/api/v1/namespaces/prod/pods",
                200,
                pods("prod", &["api", "db"]),
            ),
            ("/api/v1/namespaces/staging/pods", 403, forbidden()),
        ])
        .await;
        let paged = answer.expect("prod answered");
        assert!(paged.complete);
        assert_eq!(paged.rows, 2);
        assert_eq!(seen, ["api", "db"]);
        assert_eq!(paged.unread.len(), 1);
        assert_eq!(paged.unread[0].namespace, "staging");
        assert_eq!(paged.unread[0].code, "PERMISSION_DENIED");
    }

    /// Every namespace refusing is the refusal, not an empty scope.
    #[tokio::test]
    async fn a_scope_where_nothing_answered_fails() {
        let (answer, seen) = paged(vec![
            ("/api/v1/namespaces/prod/pods", 403, forbidden()),
            ("/api/v1/namespaces/staging/pods", 403, forbidden()),
        ])
        .await;
        assert!(answer.is_err_and(|error| error.is_refusal()));
        assert!(seen.is_empty());
    }

    /// Both namespaces answering leaves nothing unread and every pod once.
    #[tokio::test]
    async fn every_namespace_answering_is_a_whole_scope() {
        let (answer, mut seen) = paged(vec![
            ("/api/v1/namespaces/prod/pods", 200, pods("prod", &["api"])),
            (
                "/api/v1/namespaces/staging/pods",
                200,
                pods("staging", &["web"]),
            ),
        ])
        .await;
        let paged = answer.expect("both answered");
        seen.sort();
        assert_eq!(seen, ["api", "web"]);
        assert_eq!(paged.rows, 2);
        assert!(paged.unread.is_empty());
    }
}
