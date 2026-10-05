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
    SearchRequest, SearchTarget, SearchedKind, UnreadKind, SEARCHABLE_KINDS,
};

use crate::client::K8sClientManager;
use crate::error::{Error, Result};
use crate::ownership::{ClusterIndex, KindKey};
use crate::state::streams::Streams;
use crate::state::AppEvent;
use crate::utils::generate_id;
use futures::future::{BoxFuture, Shared};
use futures::{FutureExt, StreamExt};
use kube::api::{Api, DynamicObject, ListParams};
use kube::{Client, ResourceExt};
use parking_lot::Mutex;
use std::collections::{BTreeSet, HashMap};
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

/// One kind's names as read: `None` where the cluster does not serve it.
type Read = std::result::Result<Option<Arc<Listed>>, Arc<Error>>;

#[derive(Debug)]
struct Listed {
    names: Vec<(String, Option<String>)>,
    /// The cluster had more of this kind than one page holds.
    truncated: bool,
}

/// Which cluster, kind and namespace one list was of.
type ListKey = (String, &'static str, Option<String>);

/// The lists one palette session has read, each once. A read is its own task,
/// so a keystroke that supersedes the search does not throw it away half done.
#[derive(Default)]
struct SessionLists {
    lists: Mutex<HashMap<ListKey, Shared<BoxFuture<'static, Read>>>>,
}

impl SessionLists {
    fn read<F>(&self, key: ListKey, fetch: impl FnOnce() -> F) -> Shared<BoxFuture<'static, Read>>
    where
        F: std::future::Future<Output = Read> + Send + 'static,
    {
        self.lists
            .lock()
            .entry(key)
            .or_insert_with(|| {
                let task = tokio::spawn(fetch());
                async move {
                    task.await
                        .unwrap_or_else(|error| Err(Arc::new(Error::Internal(error.to_string()))))
                }
                .boxed()
                .shared()
            })
            .clone()
    }
}

/// Where a search finds names besides asking the cluster.
#[derive(Clone, Default)]
struct Sources {
    lists: Option<Arc<SessionLists>>,
    /// The ownership index of this context, where it is already running.
    index: Option<(String, Arc<ClusterIndex>)>,
}

/// Owns every in-flight search.
pub struct SearchManager {
    event_tx: broadcast::Sender<AppEvent>,
    client_manager: Arc<K8sClientManager>,
    streams: Streams,
    session: Mutex<Option<(String, Arc<SessionLists>)>>,
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
            session: Mutex::new(None),
        }
    }

    /// The lists read under `session`, kept until another session begins.
    fn lists_for(&self, session: Option<&str>) -> Option<Arc<SessionLists>> {
        let session = session?;
        let mut held = self.session.lock();
        match held.as_ref() {
            Some((id, lists)) if id == session => Some(lists.clone()),
            _ => {
                let lists = Arc::new(SessionLists::default());
                *held = Some((session.to_string(), lists.clone()));
                Some(lists)
            }
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

        let sources = Sources {
            lists: state.search_manager.lists_for(request.session.as_deref()),
            index: current
                .as_deref()
                .and_then(|context| Some((context.to_string(), state.ownership.running(context)?))),
        };
        let search_id = state
            .search_manager
            .start(&targets, query, namespace, kinds, limit, sources);

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
        sources: Sources,
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
                let sources = sources.clone();

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
                            sources,
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
                            Answer::default(),
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

/// What one cluster said, besides whether it finished.
#[derive(Debug, Default)]
struct Answer {
    matched: u32,
    truncated: bool,
    searched: Vec<SearchedKind>,
    unreadable: Vec<UnreadKind>,
}

/// One cluster's share of a search: get a client (connecting first if
/// that is what was planned), read the kinds, emit hits as they land,
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
    sources: Sources,
) {
    let event_tx = &event_tx;
    let search_id = search_id.as_str();
    let context = context.as_str();

    let Some(client) = resolve_client(event_tx, &client_manager, search_id, context).await else {
        return;
    };
    let index = sources
        .index
        .filter(|(indexed, _)| indexed == context)
        .map(|(_, index)| index);

    // Built as a plain Vec of futures rather than `iter().map(closure)`:
    // a closure that returns a future borrowing its argument needs an
    // HRTB rustc cannot infer here, and the error it produces
    // ("implementation of FnOnce is not general enough") points at the
    // spawn site instead of the closure.
    let mut kind_futures = Vec::with_capacity(kinds.len());
    for kind in kinds.iter().copied() {
        let read = names_of(
            client.clone(),
            client_manager.clone(),
            kind,
            namespace.clone(),
            context.to_string(),
            index.clone(),
            sources.lists.clone(),
        );
        kind_futures.push(async move { (kind, read.await) });
    }
    let mut stream =
        futures::stream::iter(kind_futures).buffer_unordered(plan::MAX_KIND_CONCURRENCY);

    let mut answer = Answer::default();
    while let Some((kind, read)) = stream.next().await {
        let (group, plural) = kind.key();
        match read {
            Ok(None) => {}
            Ok(Some(listed)) => {
                answer.truncated |= listed.truncated;
                let remaining = limit.saturating_sub(answer.matched) as usize;
                let mut hits: Vec<SearchHit> = listed
                    .names
                    .iter()
                    .filter(|(name, namespace)| plan::matches(&query, name, namespace.as_deref()))
                    .map(|(name, namespace)| SearchHit {
                        context: context.to_string(),
                        kind: kind.label.to_string(),
                        group: group.clone(),
                        plural: plural.clone(),
                        name: name.clone(),
                        namespace: namespace.clone(),
                    })
                    .collect();
                answer.searched.push(SearchedKind {
                    kind: kind.label.to_string(),
                    group,
                    plural,
                });
                if hits.len() > remaining {
                    hits.truncate(remaining);
                    answer.truncated = true;
                }
                if hits.is_empty() {
                    continue;
                }
                answer.matched += hits.len() as u32;
                let _ = event_tx.send(AppEvent::SearchHits {
                    search_id: search_id.to_string(),
                    context: context.to_string(),
                    hits,
                });
            }
            Err(error) => {
                tracing::debug!(
                    "Search {search_id}: {context}/{} failed: {error}",
                    kind.label
                );
                let (reason, message) = describe_failure(&error);
                answer.unreadable.push(UnreadKind {
                    kind: kind.label.to_string(),
                    group,
                    plural,
                    reason,
                    message,
                });
            }
        }
    }
    drop(stream);

    // Every kind refused: this cluster produced no answer at all, so
    // it must not read as "found nothing".
    if answer.searched.is_empty() {
        if let Some(first) = answer.unreadable.first() {
            let (reason, message) = (first.reason, first.message.clone());
            emit_status(
                event_tx,
                search_id,
                context,
                SearchContextStatus::Failed,
                Some(reason),
                Some(message),
                answer,
            );
            return;
        }
    }

    // Some kinds read and some refused is `Done`, with the refused ones named
    // as data and each in the cluster's own words: that is what lets a reader
    // tell "no Secrets match" from "you cannot see Secrets".
    emit_status(
        event_tx,
        search_id,
        context,
        SearchContextStatus::Done,
        None,
        None,
        answer,
    );
}

/// One kind's names: from the ownership index where it already reads the
/// kind, from this session's list where one was made, from the cluster else.
fn names_of(
    client: Client,
    client_manager: Arc<K8sClientManager>,
    kind: &'static SearchableKind,
    namespace: Option<String>,
    context: String,
    index: Option<Arc<ClusterIndex>>,
    lists: Option<Arc<SessionLists>>,
) -> BoxFuture<'static, Read> {
    let namespace = if kind.cluster_scoped { None } else { namespace };
    if let Some(index) = index {
        let (group, plural) = kind.key();
        if let Ok(names) = index.names(&KindKey { group, plural }, namespace.as_deref()) {
            return futures::future::ready(Ok(Some(Arc::new(Listed {
                names,
                truncated: false,
            }))))
            .boxed();
        }
    }
    let key: ListKey = (context.clone(), kind.label, namespace.clone());
    let fetch = move || list_kind(client, client_manager, kind, namespace, context);
    match lists {
        Some(lists) => lists.read(key, fetch).boxed(),
        None => fetch().boxed(),
    }
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
                Answer::default(),
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
                Answer::default(),
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
                Answer::default(),
            );
            None
        }
    }
}

/// List one kind's names in one cluster, one page of them.
async fn list_kind(
    client: Client,
    client_manager: Arc<K8sClientManager>,
    kind: &'static SearchableKind,
    namespace: Option<String>,
    context: String,
) -> Read {
    let (api_resource, served_in) = match &kind.coordinates {
        types::Coordinates::Typed(resource) => (resource(), None),
        types::Coordinates::Served { group, plural } => {
            // Not installed is an answer: there is nothing of it to match.
            match client_manager
                .served()
                .resource(&context, &client, group, plural)
                .await
                .map_err(Arc::new)?
            {
                Some(served) => (served.resource, Some(*group)),
                None => return Ok(None),
            }
        }
    };
    let api: Api<DynamicObject> = match namespace.as_deref() {
        Some(ns) if !kind.cluster_scoped => Api::namespaced_with(client, ns, &api_resource),
        _ => Api::all_with(client, &api_resource),
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
    }
    .map_err(|error| Arc::new(Error::from(error)))?;

    // A continue token means the page cap hid objects from us — the
    // caller has to say "first N scanned", not "no matches".
    let truncated = list
        .metadata
        .continue_
        .as_deref()
        .is_some_and(|token| !token.is_empty());

    Ok(Some(Arc::new(Listed {
        names: list
            .items
            .iter()
            .map(|item| (item.name_any(), item.namespace()))
            .collect(),
        truncated,
    })))
}

fn emit_status(
    event_tx: &broadcast::Sender<AppEvent>,
    search_id: &str,
    context: &str,
    status: SearchContextStatus,
    reason: Option<SearchFailureKind>,
    message: Option<String>,
    answer: Answer,
) {
    let _ = event_tx.send(AppEvent::SearchStatus {
        search_id: search_id.to_string(),
        context: context.to_string(),
        status,
        reason,
        message,
        matched: answer.matched,
        truncated: answer.truncated,
        searched: answer.searched,
        unreadable: answer.unreadable,
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
            Sources::default(),
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
        assert_eq!(message, None);
        let [refused] = unreadable.as_slice() else {
            panic!("one refused kind, got {unreadable:?}");
        };
        assert_eq!(refused.kind, "Service");
        assert_eq!(refused.reason, SearchFailureKind::Forbidden);
        assert_eq!(
            refused.message, "services is forbidden",
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
        let answer = list_kind(
            client,
            Arc::new(K8sClientManager::new()),
            gateway_kind("TCPRoute"),
            None,
            "kind".to_string(),
        )
        .await
        .expect("an answer");
        assert!(answer.is_none());
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
            Arc::new(K8sClientManager::new()),
            gateway_kind("TCPRoute"),
            None,
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
        let client_manager = Arc::new(K8sClientManager::with_served(ServedIndex::aged(
            Duration::from_mins(1),
            Duration::from_mins(2),
            Duration::from_millis(100),
        )));
        let asked = || hits.lock().unwrap().get("/apis").copied();
        let search = || {
            list_kind(
                client.clone(),
                client_manager.clone(),
                gateway_kind("HTTPRoute"),
                None,
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

        let first = manager.start(
            &[target("a")],
            "api".to_string(),
            None,
            kinds.clone(),
            50,
            Sources::default(),
        );
        assert_eq!(manager.active_searches(), 1);

        let second = manager.start(
            &[target("a")],
            "api".to_string(),
            None,
            kinds,
            50,
            Sources::default(),
        );
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
        let id = manager.start(
            &[target("a")],
            "api".to_string(),
            None,
            kinds,
            50,
            Sources::default(),
        );

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

        let id = manager.start(
            &[skipped],
            "api".to_string(),
            None,
            kinds,
            50,
            Sources::default(),
        );
        manager.mark_subscribed(&id).unwrap();

        for _ in 0..50 {
            if manager.active_searches() == 0 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("search session never cleaned itself up");
    }

    fn pods_and_accounts(path: &str, _: usize) -> (u16, String) {
        let list = |name: &str| {
            serde_json::json!({
                "kind": "PartialObjectMetadataList",
                "apiVersion": "meta.k8s.io/v1",
                "metadata": {},
                "items": [{"metadata": {"name": name, "namespace": "team"}}],
            })
            .to_string()
        };
        match path {
            "/api/v1/pods" => (200, list("marco-7f9")),
            "/api/v1/serviceaccounts" => (200, list("marco")),
            _ => (404, "{}".to_string()),
        }
    }

    async fn statuses(
        state: &crate::state::AppState,
        query: &str,
        kinds: Vec<&'static SearchableKind>,
        sources: Sources,
    ) -> (Vec<SearchHit>, Answer) {
        let (event_tx, mut rx) = broadcast::channel(64);
        search_context(
            event_tx,
            state.client_manager.clone(),
            "s".into(),
            "fake".into(),
            query.into(),
            None,
            Arc::new(kinds),
            50,
            sources,
        )
        .await;
        let mut hits = Vec::new();
        let mut answer = Answer::default();
        while let Ok(event) = rx.try_recv() {
            match event {
                AppEvent::SearchHits { hits: more, .. } => hits.extend(more),
                AppEvent::SearchStatus {
                    matched,
                    truncated,
                    searched,
                    unreadable,
                    ..
                } => {
                    answer = Answer {
                        matched,
                        truncated,
                        searched,
                        unreadable,
                    };
                }
                _ => {}
            }
        }
        (hits, answer)
    }

    /// "marco" said Nothing matches over a service account named marco: the
    /// search never listed service accounts. The hit carries where its kind
    /// is served, which is how a kind with no page of its own opens.
    #[tokio::test]
    async fn a_service_account_is_found_by_name_and_says_where_it_is_served() {
        use crate::client::served::{test_server::connected, ServedIndex};

        let (state, _) = connected(ServedIndex::default(), pods_and_accounts).await;
        let (hits, answer) = statuses(
            &state,
            "marco",
            plan::resolve_kinds(Some(&["Pod".into(), "ServiceAccount".into()])).unwrap(),
            Sources::default(),
        )
        .await;

        let account = hits
            .iter()
            .find(|hit| hit.kind == "ServiceAccount")
            .expect("the ServiceAccount");
        assert_eq!(
            (
                account.group.as_str(),
                account.plural.as_str(),
                account.name.as_str()
            ),
            ("", "serviceaccounts", "marco")
        );
        let mut searched: Vec<_> = answer.searched.iter().map(|k| k.kind.as_str()).collect();
        searched.sort_unstable();
        assert_eq!(searched, ["Pod", "ServiceAccount"]);
    }

    /// Every keystroke listed every kind again. Within one session a kind is
    /// listed once and filtered after; a new session reads the cluster anew.
    #[tokio::test]
    async fn a_session_lists_each_kind_once_and_the_next_session_lists_again() {
        use crate::client::served::{test_server::connected, ServedIndex};

        let (state, asked) = connected(ServedIndex::default(), pods_and_accounts).await;
        let kinds = || plan::resolve_kinds(Some(&["ServiceAccount".into()])).unwrap();
        let manager = &state.search_manager;
        let session = |id: &str| Sources {
            lists: manager.lists_for(Some(id)),
            index: None,
        };

        for query in ["ma", "mar", "marco"] {
            let (hits, _) = statuses(&state, query, kinds(), session("open-1")).await;
            assert_eq!(hits.len(), 1, "{query} finds marco");
        }
        let lists = || asked.lock().unwrap()["/api/v1/serviceaccounts"];
        assert_eq!(lists(), 1);

        statuses(&state, "marco", kinds(), session("open-2")).await;
        assert_eq!(lists(), 2);
    }

    /// The ownership index already holds every name of the kinds it reads;
    /// asking the cluster again for them is the request this saves. A kind
    /// it is still listing is asked of the cluster, not waited on.
    #[tokio::test]
    async fn a_kind_the_ownership_index_reads_live_is_not_listed_again() {
        use crate::client::served::{test_server::connected, ServedIndex};

        let (state, asked) = connected(ServedIndex::default(), pods_and_accounts).await;
        let client = state.client_manager.get_client("fake").unwrap();
        let key = |plural: &str| KindKey {
            group: String::new(),
            plural: plural.to_string(),
        };
        let index = ClusterIndex::holding(
            (*client).clone(),
            &[(key("serviceaccounts"), &[("marco", Some("team"))])],
            &[key("pods")],
        );
        let (hits, answer) = statuses(
            &state,
            "marco",
            plan::resolve_kinds(Some(&["Pod".into(), "ServiceAccount".into()])).unwrap(),
            Sources {
                lists: None,
                index: Some(("fake".to_string(), index)),
            },
        )
        .await;

        assert_eq!(hits.len(), 2);
        assert_eq!(answer.searched.len(), 2);
        let asked = asked.lock().unwrap();
        assert!(!asked.contains_key("/api/v1/serviceaccounts"));
        assert_eq!(asked.get("/api/v1/pods"), Some(&1));
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
