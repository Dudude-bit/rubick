//! Pod-specific commands

use std::time::{Duration, Instant};

use k8s_openapi::api::core::v1::Pod;
use kube::api::ListParams;
use tauri::State;
use tokio::sync::oneshot;

use crate::commands::filters::PodFilters;
use crate::commands::helpers::{get_resource_info, ResourceContext};
use crate::error::Result;
use crate::resources::{PodInfo, PodRow};
use crate::state::perf::{chunks_within, IPC_TARGET_BYTES};
use crate::state::{AppEvent, AppState, ListStream, RemoveOnDrop};
use crate::utils::{elapsed_ms, generate_id, normalize_optional_namespace};

/// Rows per API page: one round trip's worth, converted and sent on before
/// the next is asked for, so the first rows land before the last are read.
const PAGE: u32 = 500;
const SUBSCRIBE_TIMEOUT: Duration = Duration::from_mins(1);

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
pub async fn page_rows<F>(
    api: &kube::Api<Pod>,
    mut on_rows: F,
    cancel: &mut oneshot::Receiver<()>,
) -> Result<Paged>
where
    F: FnMut(Vec<PodRow>),
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

/// Start listing pods as rows. They arrive in `pod-rows-batch` events, each
/// under the IPC target, and the end as exactly one `pod-rows-done` or
/// `pod-rows-failed`.
#[tauri::command]
pub async fn list_pod_rows(
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<String> {
    let ctx = ResourceContext::for_list(&state, normalize_optional_namespace(namespace))?;
    let api: kube::Api<Pod> = ctx.namespaced_or_cluster_api();

    let stream_id = generate_id("pods");
    let (cancel_tx, mut cancel_rx) = oneshot::channel();
    let (subscribe_tx, subscribe_rx) = oneshot::channel::<()>();
    let streams = state.list_streams.clone();
    streams.insert(
        stream_id.clone(),
        ListStream {
            cancel_tx,
            subscribe_tx: Some(subscribe_tx),
        },
    );
    let event_tx = state.event_tx.clone();

    let id = stream_id.clone();
    tokio::spawn(async move {
        let _cleanup = RemoveOnDrop {
            map: streams,
            key: id.clone(),
        };
        let started = tokio::select! {
            biased;
            _ = &mut cancel_rx => false,
            subscribed = subscribe_rx => subscribed.is_ok(),
            () = tokio::time::sleep(SUBSCRIBE_TIMEOUT) => true,
        };
        if !started {
            return;
        }
        let began = Instant::now();
        let outcome = page_rows(
            &api,
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
    if let Some(mut entry) = state.list_streams.get_mut(&stream_id) {
        if let Some(tx) = entry.subscribe_tx.take() {
            let _ = tx.send(());
        }
    }
    Ok(())
}

/// Stop a list that is still arriving.
#[tauri::command]
pub fn stop_pod_rows(stream_id: String, state: State<'_, AppState>) -> Result<()> {
    if let Some((_, stream)) = state.list_streams.remove(&stream_id) {
        let _ = stream.cancel_tx.send(());
    }
    Ok(())
}

/// Get a single pod by name
#[tauri::command]
pub async fn get_pod(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<PodInfo> {
    crate::validation::validate_dns_label(&name)?;
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
    crate::validation::validate_dns_label(&name)?;

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
