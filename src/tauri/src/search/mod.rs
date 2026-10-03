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
use crate::state::streams::Streams;
use crate::state::AppEvent;
use crate::utils::generate_id;
use futures::StreamExt;
use kube::api::{Api, DynamicObject, ListParams};
use kube::{Client, ResourceExt};
use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast;
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

/// Owns every in-flight search.
pub struct SearchManager {
    event_tx: broadcast::Sender<AppEvent>,
    client_manager: Arc<K8sClientManager>,
    streams: Streams,
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
            streams: Streams::default(),
        }
    }

    #[must_use]
    pub fn active_searches(&self) -> usize {
        self.streams.len()
    }

    /// Release the gate once the frontend's listener is installed.
    /// Erroring on unknown ids keeps a caller from poking at searches
    /// it does not own. Idempotent.
    pub fn mark_subscribed(&self, search_id: &str) -> Result<()> {
        if self.streams.subscribed(search_id) || self.streams.contains(search_id) {
            Ok(())
        } else {
            Err(Error::Internal(format!("Search {search_id} not found")))
        }
    }

    /// Stop a search. Idempotent, and safe to race with completion.
    pub fn cancel(&self, search_id: &str) {
        let _ = self.streams.stop(search_id);
    }

    /// Stop every in-flight search.
    pub fn cancel_all(&self) {
        self.streams.stop_all();
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
        let mut opened = self.streams.open(search_id.clone());

        let active: Vec<String> = targets
            .iter()
            .filter(|t| t.is_active())
            .map(|t| t.context.clone())
            .collect();
        let event_tx = self.event_tx.clone();
        let client_manager = self.client_manager.clone();
        let id = search_id.clone();
        let kinds = Arc::new(kinds);

        tokio::spawn(async move {
            if !opened.wait_for_subscriber(SUBSCRIBE_GATE_TIMEOUT).await {
                return;
            }
            let (cancel, _held) = opened.split();

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
                            Vec::new(),
                        );
                    }
                });
            }

            tokio::select! {
                () = cancel.cancelled() => {
                    tracing::debug!("Search {id} cancelled; aborting {} cluster tasks", tasks.len());
                    tasks.shutdown().await;
                }
                () = async { while tasks.join_next().await.is_some() {} } => {}
            }
        });

        search_id
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
        let client_manager = client_manager.clone();
        kind_futures.push(async move {
            (
                kind.label,
                list_kind(client, &client_manager, kind, namespace, query, context).await,
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
            unreadable,
        );
        return;
    }

    // Some kinds were readable and some were not — the cluster answered,
    // so this is `Done`, not `Failed`, with the unread kinds named: that is
    // what lets a reader tell "no Secrets match" from "you cannot see
    // Secrets". `message` is the cluster's own words; the sentence around
    // them is the frontend's, in the reader's language.
    let (reason, message) = match first_error {
        None => (None, None),
        Some(error) => {
            let (reason, cause) = describe_failure(&error);
            (Some(reason), Some(cause))
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
        unreadable,
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
                Vec::new(),
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
                Vec::new(),
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
                Vec::new(),
            );
            None
        }
    }
}

/// List one kind in one cluster and keep the matches. Returns the hits
/// plus whether the cluster had more objects than one page.
async fn list_kind(
    client: Client,
    client_manager: &K8sClientManager,
    kind: &'static SearchableKind,
    namespace: Option<String>,
    query: String,
    context: String,
) -> Result<(Vec<SearchHit>, bool)> {
    let (api_resource, served_in) = match &kind.coordinates {
        types::Coordinates::Typed(resource) => (resource(), None),
        types::Coordinates::Served { group, plural } => {
            // Not installed is an answer: there is nothing of it to match.
            match client_manager
                .served()
                .resource(&context, &client, group, plural)
                .await?
            {
                Some(served) => (served.resource, Some(*group)),
                None => return Ok((Vec::new(), false)),
            }
        }
    };
    let api: Api<DynamicObject> = if kind.cluster_scoped {
        Api::all_with(client, &api_resource)
    } else {
        match namespace.as_deref() {
            Some(ns) => Api::namespaced_with(client, ns, &api_resource),
            None => Api::all_with(client, &api_resource),
        }
    };

    // Metadata only: a name is all that is matched, and a full list carried
    // every Secret's values and every Helm release's manifest into memory on
    // each keystroke.
    let list = api
        .list_metadata(&ListParams::default().limit(plan::LIST_PAGE_LIMIT))
        .await;
    let list = match served_in {
        Some(group) => client_manager.served().answered(&context, group, list),
        None => list,
    }?;

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
    unreadable: Vec<String>,
) {
    let _ = event_tx.send(AppEvent::SearchStatus {
        search_id: search_id.to_string(),
        context: context.to_string(),
        status,
        reason,
        message,
        matched,
        truncated,
        unreadable,
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

    fn gateway_kind(label: &str) -> &'static SearchableKind {
        SEARCHABLE_KINDS
            .iter()
            .find(|kind| kind.label == label)
            .expect("a searchable kind")
    }

    /// Pods read and Services refused: the cluster answered, so `Done`, with
    /// the refused kind named as data. It used to travel only inside an
    /// English sentence the palette never drew, so "1 match" read as the
    /// whole answer.
    #[tokio::test]
    async fn a_partly_refused_search_names_the_kinds_it_could_not_read() {
        use crate::client::served::{test_server::connected, ServedIndex};

        let (state, _) = connected(ServedIndex::default(), |path, _| match path {
            "/api/v1/pods" => (
                200,
                serde_json::json!({
                    "kind": "PartialObjectMetadataList",
                    "apiVersion": "meta.k8s.io/v1",
                    "metadata": {},
                    "items": [{"metadata": {"name": "app-1", "namespace": "default"}}],
                })
                .to_string(),
            ),
            "/api/v1/services" => (
                403,
                serde_json::json!({
                    "kind": "Status", "apiVersion": "v1", "status": "Failure",
                    "message": "services is forbidden", "reason": "Forbidden", "code": 403,
                })
                .to_string(),
            ),
            _ => (404, "{}".to_string()),
        })
        .await;
        let (event_tx, mut rx) = broadcast::channel(16);
        search_context(
            event_tx,
            state.client_manager.clone(),
            "s".into(),
            "fake".into(),
            "app".into(),
            None,
            Arc::new(vec![gateway_kind("Pod"), gateway_kind("Service")]),
            50,
        )
        .await;

        let mut last = None;
        while let Ok(event) = rx.try_recv() {
            if let AppEvent::SearchStatus {
                status,
                matched,
                unreadable,
                message,
                ..
            } = event
            {
                last = Some((status, matched, unreadable, message));
            }
        }
        let (status, matched, unreadable, message) = last.expect("a terminal status");
        assert_eq!(status, SearchContextStatus::Done);
        assert_eq!(matched, 1);
        assert_eq!(unreadable, vec!["Service".to_string()]);
        assert!(
            message.is_some_and(|m| !m.contains("Could not read")),
            "the cluster's words, without a sentence around them"
        );
    }

    /// A kind the cluster does not serve has no objects to match, and says
    /// so without a list; the cluster answering "no such path" used to come
    /// back as "Could not read `TCPRoute`" on every Gateway API 1.6 cluster.
    /// A discovery that failed is still a failure, not "none".
    #[tokio::test]
    async fn a_kind_the_cluster_does_not_serve_is_no_matches_and_a_refusal_is_not() {
        use crate::client::served::test_server::{groups, resources, server};

        let (client, hits) = server(vec![
            ("/apis", 200, groups("v1", &["v1"])),
            (
                "/apis/gateway.networking.k8s.io/v1",
                200,
                resources("v1", &[("httproutes", "HTTPRoute", true)]),
            ),
        ])
        .await;
        let client_manager = K8sClientManager::new();
        let answer = list_kind(
            client,
            &client_manager,
            gateway_kind("TCPRoute"),
            None,
            "api".to_string(),
            "kind".to_string(),
        )
        .await
        .expect("an answer");
        assert!(answer.0.is_empty() && !answer.1);
        assert!(
            !hits
                .lock()
                .unwrap()
                .keys()
                .any(|path| path.ends_with("/tcproutes")),
            "nothing to list where nothing is served"
        );

        let (refused, _) = server(vec![("/apis", 403, "{}".to_string())]).await;
        assert!(list_kind(
            refused,
            &K8sClientManager::new(),
            gateway_kind("TCPRoute"),
            None,
            "api".to_string(),
            "kind".to_string(),
        )
        .await
        .is_err());
    }

    /// Would list a kind at a version the cluster stopped serving for every
    /// query until discovery aged out, filing it among the unreadable ones,
    /// while the pages beside it recovered on their next poll.
    #[tokio::test]
    async fn a_404_from_a_discovered_kind_sends_discovery_back() {
        use crate::client::served::test_server::{answering, failure, groups, resources};
        use crate::client::served::ServedIndex;

        let (client, hits) = answering(|path, _| match path {
            "/apis" => (200, groups("v1", &["v1"])),
            "/apis/gateway.networking.k8s.io/v1" => {
                (200, resources("v1", &[("httproutes", "HTTPRoute", true)]))
            }
            _ => failure(404, "NotFound"),
        })
        .await;
        let client_manager = K8sClientManager::with_served(ServedIndex::aged(
            Duration::from_mins(1),
            Duration::from_mins(2),
            Duration::from_millis(100),
        ));
        let asked = || hits.lock().unwrap().get("/apis").copied();
        let search = || {
            list_kind(
                client.clone(),
                &client_manager,
                gateway_kind("HTTPRoute"),
                None,
                "api".to_string(),
                "kind".to_string(),
            )
        };

        assert!(search().await.is_err());
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(search().await.is_err());
        assert_eq!(asked(), Some(1));
        assert!(search().await.is_err());
        assert_eq!(asked(), Some(2), "the list's 404 sent discovery back");
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
        let error = Error::KubeApi(kube::Error::Api(Box::new(kube::core::Status {
            status: Some(kube::core::response::StatusSummary::Failure),
            message: "secrets is forbidden: User \"system:serviceaccount:default:probe\" \
                      cannot list resource \"secrets\" in API group \"\" at the cluster scope"
                .into(),
            reason: "Forbidden".into(),
            code: 403,
            metadata: None,
            details: None,
        })));

        let (kind, message) = describe_failure(&error);
        assert_eq!(kind, SearchFailureKind::Forbidden);
        assert_eq!(
            message,
            "secrets is forbidden: User \"system:serviceaccount:default:probe\" \
             cannot list resource \"secrets\" in API group \"\" at the cluster scope",
        );
        // The type kube wraps a refusal in was renamed under us — this
        // guard named the old one and would have gone on passing while the
        // dump it exists to catch changed shape. Both names, so the next
        // rename fails here rather than on somebody's screen.
        assert!(
            !message.contains("Status {") && !message.contains("ErrorResponse {"),
            "a Debug dump reached the UI: {message}"
        );
    }
}
