//! Cross-cluster resource search.
//!
//! One search fans out over N contexts. Each cluster reports on its
//! own: its hits arrive as soon as that cluster answers, and its
//! terminal state (`done` / `failed` / `skipped`) arrives whether it
//! answered or not. Nothing waits for the slowest cluster, and a
//! cluster that could not be reached never renders as "no matches".
//!
//! Cost is bounded on four axes, all in `plan.rs`: contexts per search,
//! clusters queried at once, kind queries in flight per cluster, and
//! hits collected per cluster. A superseded search is cancelled for
//! real — the in-flight HTTP futures are dropped, not just ignored.
//!
//! - `plan`:  pure "who and what will this touch" decisions
//! - `types`: the IPC contract

mod plan;
mod types;

pub use plan::{matches, MIN_QUERY_LEN};
pub use types::{
    describe_failure, SearchContextStatus, SearchFailureKind, SearchHandle, SearchHit,
    SearchRequest, SearchTarget, SEARCHABLE_KINDS,
};

use crate::client::K8sClientManager;
use crate::error::{Error, Result};
use crate::state::AppEvent;
use crate::utils::generate_id;
use dashmap::DashMap;
use futures::StreamExt;
use kube::api::{Api, DynamicObject, ListParams};
use kube::{Client, ResourceExt};
use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{broadcast, oneshot, watch};
use types::SearchableKind;

/// Budget for establishing a client for a cold cluster. Long enough
/// for an exec credential plugin that is going to succeed, short
/// enough that the reader is told about the failure instead of
/// watching a spinner.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);

/// Budget for one cluster's whole share of a search, connect included.
const CONTEXT_BUDGET: Duration = Duration::from_secs(15);

/// How long the fan-out waits for the frontend to install its event
/// listener before starting anyway.
const SUBSCRIBE_GATE_TIMEOUT: Duration = Duration::from_secs(5);

struct SearchSession {
    /// Dropping or firing this cancels every context task. Cancellation
    /// is a `watch` rather than a `oneshot` because one search has many
    /// consumers — one per cluster.
    cancel_tx: watch::Sender<bool>,
    subscribe_tx: Option<oneshot::Sender<()>>,
}

/// Removes the session row on every exit path of the fan-out task,
/// including a panic unwind.
struct SearchCleanup {
    sessions: Arc<DashMap<String, SearchSession>>,
    key: String,
}

impl Drop for SearchCleanup {
    fn drop(&mut self) {
        self.sessions.remove(&self.key);
    }
}

/// Owns every in-flight search.
pub struct SearchManager {
    event_tx: broadcast::Sender<AppEvent>,
    client_manager: Arc<K8sClientManager>,
    sessions: Arc<DashMap<String, SearchSession>>,
}

impl SearchManager {
    #[must_use]
    pub fn new(
        event_tx: broadcast::Sender<AppEvent>,
        client_manager: Arc<K8sClientManager>,
    ) -> Self {
        Self {
            event_tx,
            client_manager,
            sessions: Arc::new(DashMap::new()),
        }
    }

    #[must_use]
    pub fn active_searches(&self) -> usize {
        self.sessions.len()
    }

    /// Release the gate once the frontend's listener is installed.
    /// Erroring on unknown ids keeps a caller from poking at searches
    /// it does not own. Idempotent.
    pub fn mark_subscribed(&self, search_id: &str) -> Result<()> {
        if let Some(mut entry) = self.sessions.get_mut(search_id) {
            if let Some(tx) = entry.subscribe_tx.take() {
                let _ = tx.send(());
            }
            Ok(())
        } else {
            Err(Error::Internal(format!("Search {search_id} not found")))
        }
    }

    /// Stop a search. Idempotent, and safe to race with completion.
    pub fn cancel(&self, search_id: &str) {
        if let Some((_, session)) = self.sessions.remove(search_id) {
            let _ = session.cancel_tx.send(true);
        }
    }

    /// Stop every in-flight search.
    pub fn cancel_all(&self) {
        let ids: Vec<String> = self.sessions.iter().map(|e| e.key().clone()).collect();
        for id in ids {
            self.cancel(&id);
        }
    }

    /// Plan a search from a frontend request and start it.
    ///
    /// Takes `&AppState` rather than `tauri::State` so the fan-out can
    /// be exercised without a Tauri runtime — the integration proof in
    /// `tests/` drives this directly.
    pub async fn start_from_request(
        state: &crate::state::AppState,
        request: SearchRequest,
    ) -> Result<SearchHandle> {
        let query = plan::normalize_query(&request.query)?;
        let kinds = plan::resolve_kinds(request.kinds.as_deref())?;

        let known: BTreeSet<String> = state
            .client_manager
            .list_contexts()
            .await?
            .into_iter()
            .map(|c| c.name)
            .collect();
        let current = state.get_current_context();
        let names = plan::resolve_context_names(&request, &known, current.as_deref())?;
        let live: BTreeSet<String> = state
            .client_manager
            .connected_contexts()
            .into_iter()
            .collect();

        let targets = plan::plan_targets(&names, &known, &live, request.connect);
        let limit = plan::clamp_limit(request.limit_per_context);
        let namespace = crate::utils::normalize_optional_namespace(request.namespace.clone());

        let search_id = state
            .search_manager
            .start(&targets, query, namespace, kinds, limit);

        Ok(SearchHandle { search_id, targets })
    }

    /// Spawn the fan-out. Returns the id immediately; every result
    /// arrives as an event.
    ///
    /// Starting a search cancels any other in-flight search: the
    /// palette is the only consumer and it only ever shows one query's
    /// results, so an older fan-out is pure cost against the reader's
    /// laptop and the API servers. This is what makes "superseded"
    /// mean stopped rather than ignored, even if the frontend forgets
    /// to cancel.
    fn start(
        &self,
        targets: &[SearchTarget],
        query: String,
        namespace: Option<String>,
        kinds: Vec<&'static SearchableKind>,
        limit_per_context: u32,
    ) -> String {
        self.cancel_all();

        let search_id = generate_id("search");
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let (subscribe_tx, subscribe_rx) = oneshot::channel();

        self.sessions.insert(
            search_id.clone(),
            SearchSession {
                cancel_tx,
                subscribe_tx: Some(subscribe_tx),
            },
        );

        let active: Vec<String> = targets
            .iter()
            .filter(|t| t.is_active())
            .map(|t| t.context.clone())
            .collect();
        let event_tx = self.event_tx.clone();
        let client_manager = self.client_manager.clone();
        let sessions = self.sessions.clone();
        let id = search_id.clone();
        let kinds = Arc::new(kinds);

        tokio::spawn(async move {
            let _cleanup = SearchCleanup {
                sessions,
                key: id.clone(),
            };

            let mut cancel_rx = cancel_rx;
            tokio::select! {
                _ = subscribe_rx => {}
                () = cancelled(&mut cancel_rx) => return,
                () = tokio::time::sleep(SUBSCRIBE_GATE_TIMEOUT) => {
                    tracing::warn!("Search {id} subscribe gate timed out; emitting anyway");
                }
            }

            // One task per cluster behind a permit, rather than one
            // future chain: an aborted task drops its in-flight HTTP
            // request immediately, which is what "a superseded search
            // stops" has to mean.
            let permits = Arc::new(tokio::sync::Semaphore::new(plan::MAX_CONTEXT_CONCURRENCY));
            let mut tasks = tokio::task::JoinSet::new();

            for context in active {
                let event_tx = event_tx.clone();
                let client_manager = client_manager.clone();
                let id = id.clone();
                let query = query.clone();
                let namespace = namespace.clone();
                let kinds = kinds.clone();
                let permits = permits.clone();

                tasks.spawn(async move {
                    let Ok(_permit) = permits.acquire().await else {
                        return;
                    };
                    let timed_out = tokio::time::timeout(
                        CONTEXT_BUDGET,
                        search_context(
                            event_tx.clone(),
                            client_manager,
                            id.clone(),
                            context.clone(),
                            query,
                            namespace,
                            kinds,
                            limit_per_context,
                        ),
                    )
                    .await
                    .is_err();

                    if timed_out {
                        emit_status(
                            &event_tx,
                            &id,
                            &context,
                            SearchContextStatus::Failed,
                            Some(SearchFailureKind::Timeout),
                            Some(format!(
                                "'{context}' did not answer within {}s",
                                CONTEXT_BUDGET.as_secs()
                            )),
                            0,
                            false,
                        );
                    }
                });
            }

            tokio::select! {
                () = cancelled(&mut cancel_rx) => {
                    tracing::debug!("Search {id} cancelled; aborting {} cluster tasks", tasks.len());
                    tasks.shutdown().await;
                }
                () = async { while tasks.join_next().await.is_some() {} } => {}
            }
        });

        search_id
    }
}

/// Resolves when the search has been cancelled — either explicitly or
/// because its session row (and with it the sender) went away.
async fn cancelled(rx: &mut watch::Receiver<bool>) {
    loop {
        if *rx.borrow_and_update() {
            return;
        }
        if rx.changed().await.is_err() {
            return;
        }
    }
}

/// One cluster's share of a search: get a client (connecting first if
/// that is what was planned), query the kinds, emit hits as they land,
/// then emit exactly one terminal status.
#[allow(clippy::too_many_arguments)]
async fn search_context(
    event_tx: broadcast::Sender<AppEvent>,
    client_manager: Arc<K8sClientManager>,
    search_id: String,
    context: String,
    query: String,
    namespace: Option<String>,
    kinds: Arc<Vec<&'static SearchableKind>>,
    limit: u32,
) {
    let event_tx = &event_tx;
    let search_id = search_id.as_str();
    let context = context.as_str();

    let Some(client) = resolve_client(event_tx, &client_manager, search_id, context).await else {
        return;
    };

    let mut matched: u32 = 0;
    let mut truncated = false;
    let mut unreadable: Vec<String> = Vec::new();
    let mut first_error: Option<Error> = None;
    let attempted = kinds.len();

    // Built as a plain Vec of futures rather than `iter().map(closure)`:
    // a closure that returns a future borrowing its argument needs an
    // HRTB rustc cannot infer here, and the error it produces
    // ("implementation of FnOnce is not general enough") points at the
    // spawn site instead of the closure.
    let mut kind_futures = Vec::with_capacity(kinds.len());
    for kind in kinds.iter().copied() {
        let client = client.clone();
        let namespace = namespace.clone();
        let query = query.clone();
        let context = context.to_string();
        kind_futures.push(async move {
            (
                kind.label,
                list_kind(client, kind, namespace, query, context).await,
            )
        });
    }
    let mut stream =
        futures::stream::iter(kind_futures).buffer_unordered(plan::MAX_KIND_CONCURRENCY);

    while let Some((label, result)) = stream.next().await {
        match result {
            Ok((mut hits, kind_truncated)) => {
                truncated |= kind_truncated;
                let remaining = limit.saturating_sub(matched) as usize;
                if hits.len() > remaining {
                    hits.truncate(remaining);
                    truncated = true;
                }
                if hits.is_empty() {
                    continue;
                }
                matched += hits.len() as u32;
                let _ = event_tx.send(AppEvent::SearchHits {
                    search_id: search_id.to_string(),
                    context: context.to_string(),
                    hits,
                });
                if matched >= limit {
                    truncated = true;
                    break;
                }
            }
            Err(error) => {
                tracing::debug!("Search {search_id}: {context}/{label} failed: {error}");
                unreadable.push(label.to_string());
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
    }
    drop(stream);

    // Every kind refused: this cluster produced no answer at all, so
    // it must not read as "found nothing".
    if unreadable.len() == attempted {
        let error = first_error.expect("a failed kind recorded an error");
        let (reason, message) = describe_failure(&error);
        emit_status(
            event_tx,
            search_id,
            context,
            SearchContextStatus::Failed,
            Some(reason),
            Some(message),
            0,
            false,
        );
        return;
    }

    // Some kinds were readable and some were not — the cluster answered,
    // so this is `Done`, not `Failed`. But it carries the reason as a
    // `reason` rather than only in prose: the app already treats a
    // denied read as its own state (`MetricsStatusKind::Forbidden`)
    // instead of folding it into "no data", and a partial search is the
    // same thing one level down. Naming the kinds is what lets a reader
    // tell "no Secrets match" from "you cannot see Secrets".
    let (reason, message) = match first_error {
        None => (None, None),
        Some(error) => {
            let (reason, cause) = describe_failure(&error);
            (
                Some(reason),
                Some(format!(
                    "Could not read {} — {cause}",
                    unreadable.join(", ")
                )),
            )
        }
    };

    emit_status(
        event_tx,
        search_id,
        context,
        SearchContextStatus::Done,
        reason,
        message,
        matched,
        truncated,
    );
}

/// Live client, or a connection made on purpose. Emits the terminal
/// failure status itself and returns None when there is nothing to
/// query.
async fn resolve_client(
    event_tx: &broadcast::Sender<AppEvent>,
    client_manager: &K8sClientManager,
    search_id: &str,
    context: &str,
) -> Option<Client> {
    if let Some(client) = client_manager.get_client(context) {
        return Some((*client).clone());
    }

    match tokio::time::timeout(CONNECT_TIMEOUT, client_manager.connect(context)).await {
        Ok(Ok(client)) => {
            emit_status(
                event_tx,
                search_id,
                context,
                SearchContextStatus::Searching,
                None,
                None,
                0,
                false,
            );
            Some((*client).clone())
        }
        Ok(Err(error)) => {
            let (reason, message) = describe_failure(&error);
            emit_status(
                event_tx,
                search_id,
                context,
                SearchContextStatus::Failed,
                Some(reason),
                Some(message),
                0,
                false,
            );
            None
        }
        Err(_) => {
            emit_status(
                event_tx,
                search_id,
                context,
                SearchContextStatus::Failed,
                Some(SearchFailureKind::Timeout),
                Some(format!(
                    "Connecting to '{context}' timed out after {}s",
                    CONNECT_TIMEOUT.as_secs()
                )),
                0,
                false,
            );
            None
        }
    }
}

/// List one kind in one cluster and keep the matches. Returns the hits
/// plus whether the cluster had more objects than one page.
async fn list_kind(
    client: Client,
    kind: &'static SearchableKind,
    namespace: Option<String>,
    query: String,
    context: String,
) -> Result<(Vec<SearchHit>, bool)> {
    let api_resource = kind.api_resource();
    let api: Api<DynamicObject> = if kind.cluster_scoped {
        Api::all_with(client, &api_resource)
    } else {
        match namespace.as_deref() {
            Some(ns) => Api::namespaced_with(client, ns, &api_resource),
            None => Api::all_with(client, &api_resource),
        }
    };

    let list = api
        .list(&ListParams::default().limit(plan::LIST_PAGE_LIMIT))
        .await?;

    // A continue token means the page cap hid objects from us — the
    // caller has to say "first N scanned", not "no matches".
    let truncated = list
        .metadata
        .continue_
        .as_deref()
        .is_some_and(|token| !token.is_empty());

    let hits = list
        .items
        .iter()
        .filter_map(|item| {
            let name = item.name_any();
            let namespace = item.namespace();
            plan::matches(&query, &name, namespace.as_deref()).then(|| SearchHit {
                context: context.clone(),
                kind: kind.label.to_string(),
                name,
                namespace,
            })
        })
        .collect();

    Ok((hits, truncated))
}

#[allow(clippy::too_many_arguments)]
fn emit_status(
    event_tx: &broadcast::Sender<AppEvent>,
    search_id: &str,
    context: &str,
    status: SearchContextStatus,
    reason: Option<SearchFailureKind>,
    message: Option<String>,
    matched: u32,
    truncated: bool,
) {
    let _ = event_tx.send(AppEvent::SearchStatus {
        search_id: search_id.to_string(),
        context: context.to_string(),
        status,
        reason,
        message,
        matched,
        truncated,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manager() -> (SearchManager, broadcast::Receiver<AppEvent>) {
        let (event_tx, rx) = broadcast::channel(64);
        (
            SearchManager::new(event_tx, Arc::new(K8sClientManager::new())),
            rx,
        )
    }

    fn target(name: &str) -> SearchTarget {
        SearchTarget::searching(name.to_string())
    }

    #[tokio::test]
    async fn starting_a_search_cancels_the_previous_one() {
        let (manager, _rx) = manager();
        let kinds = plan::resolve_kinds(None).unwrap();

        let first = manager.start(&[target("a")], "api".to_string(), None, kinds.clone(), 50);
        assert_eq!(manager.active_searches(), 1);

        let second = manager.start(&[target("a")], "api".to_string(), None, kinds, 50);
        assert_eq!(
            manager.active_searches(),
            1,
            "the superseded search must be gone, not merely ignored"
        );
        assert_ne!(first, second);
        assert!(manager.mark_subscribed(&first).is_err());
        assert!(manager.mark_subscribed(&second).is_ok());
    }

    #[tokio::test]
    async fn cancel_is_idempotent_and_unknown_ids_do_not_panic() {
        let (manager, _rx) = manager();
        let kinds = plan::resolve_kinds(None).unwrap();
        let id = manager.start(&[target("a")], "api".to_string(), None, kinds, 50);

        manager.cancel(&id);
        manager.cancel(&id);
        manager.cancel("no-such-search");
        assert_eq!(manager.active_searches(), 0);
    }

    #[tokio::test]
    async fn mark_subscribed_rejects_unknown_ids() {
        let (manager, _rx) = manager();
        assert!(manager.mark_subscribed("nope").is_err());
    }

    /// A search whose every target was skipped still has to terminate
    /// on its own — otherwise the session row leaks and the next
    /// search's `cancel_all` is the only thing that ever clears it.
    #[tokio::test]
    async fn a_search_with_no_active_target_finishes_by_itself() {
        let (manager, _rx) = manager();
        let kinds = plan::resolve_kinds(None).unwrap();
        let skipped =
            SearchTarget::skipped("prod".to_string(), SearchFailureKind::NotConnected, "cold");

        let id = manager.start(&[skipped], "api".to_string(), None, kinds, 50);
        manager.mark_subscribed(&id).unwrap();

        for _ in 0..50 {
            if manager.active_searches() == 0 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("search session never cleaned itself up");
    }

    /// A refused connection reaches us as `ServiceError: client error
    /// (Connect)` — a sentence that names no cause and classifies as
    /// `Other`. The words a reader can act on are two links down the
    /// source chain, so that is where the message has to come from.
    #[test]
    fn a_refused_connection_is_described_from_the_bottom_of_the_chain() {
        #[derive(Debug)]
        struct Layer(&'static str, Option<Box<Layer>>);
        impl std::fmt::Display for Layer {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(self.0)
            }
        }
        impl std::error::Error for Layer {
            fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
                self.1
                    .as_deref()
                    .map(|l| l as &(dyn std::error::Error + 'static))
            }
        }

        let hyper_chain = Layer(
            "client error (Connect)",
            Some(Box::new(Layer(
                "tcp connect error",
                Some(Box::new(Layer("Connection refused (os error 111)", None))),
            ))),
        );
        let error = Error::KubeApi(kube::Error::Service(Box::new(hyper_chain)));

        let (kind, message) = describe_failure(&error);
        assert_eq!(kind, SearchFailureKind::Unreachable);
        assert_eq!(
            message, "Connection refused (os error 111)",
            "the deepest cause is the only link that says what to fix"
        );
    }

    #[test]
    fn classify_maps_the_failures_a_reader_can_act_on() {
        let kind = |error: &Error| describe_failure(error).0;

        assert_eq!(
            kind(&Error::Connection(
                "error trying to connect: tcp connect error: Connection refused (os error 111)"
                    .into()
            )),
            SearchFailureKind::Unreachable,
        );
        assert_eq!(
            kind(&Error::Timeout("connect".into())),
            SearchFailureKind::Timeout,
        );
        // "Permission denied: …" contains none of the words the text
        // classifier looks for, so the variant has to carry it.
        assert_eq!(
            kind(&Error::PermissionDenied("listing pods".into())),
            SearchFailureKind::Forbidden,
        );
        // An exec plugin that blew up is none of the above; calling it
        // "unreachable" would send the reader to check the cluster.
        assert_eq!(
            kind(&Error::Config(
                "exec plugin returned status 1: no such profile".into()
            )),
            SearchFailureKind::Other,
        );
    }

    /// An RBAC refusal is the message a reader is most likely to hit,
    /// and the one the error chain phrases worst: `kube::Error::Api`
    /// renders as `ApiError: {0} ({0:?})`, so walking the chain hands
    /// back a struct dump. The server's own sentence — what `kubectl`
    /// prints — is the only acceptable thing to put on screen.
    #[test]
    fn a_denied_read_reads_like_the_sentence_kubectl_prints() {
        let error = Error::KubeApi(kube::Error::Api(kube::core::ErrorResponse {
            status: "Failure".into(),
            message: "secrets is forbidden: User \"system:serviceaccount:default:probe\" \
                      cannot list resource \"secrets\" in API group \"\" at the cluster scope"
                .into(),
            reason: "Forbidden".into(),
            code: 403,
        }));

        let (kind, message) = describe_failure(&error);
        assert_eq!(kind, SearchFailureKind::Forbidden);
        assert_eq!(
            message,
            "secrets is forbidden: User \"system:serviceaccount:default:probe\" \
             cannot list resource \"secrets\" in API group \"\" at the cluster scope",
        );
        assert!(
            !message.contains("ErrorResponse {"),
            "a Debug dump reached the UI: {message}"
        );
    }
}
