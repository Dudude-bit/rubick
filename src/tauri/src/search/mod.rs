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
use crate::ownership::{ClusterIndex, KindKey, Reading};
use crate::state::streams::Streams;
use crate::state::AppEvent;
use crate::utils::generate_id;
use futures::future::{BoxFuture, Shared};
use futures::{FutureExt, StreamExt};
use kube::api::{Api, DynamicObject, ListParams};
use kube::discovery::ApiResource;
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

/// How long a search that reads every kind waits for the ownership index to
/// finish listing the ones it is still listing.
const INDEX_WAIT: Duration = Duration::from_secs(10);

/// How often a kind still listing in the index is looked at again.
const INDEX_POLL: Duration = Duration::from_millis(300);

/// One kind's names as read, or why they could not be.
type Read = std::result::Result<Found, Arc<Error>>;

#[derive(Debug, Clone)]
enum Found {
    /// The cluster does not serve this kind: there is nothing of it to match.
    NotServed,
    /// The ownership index is still listing it.
    Loading,
    Listed(Arc<Listed>),
}

/// A kind to read: one of the table's, or one only the ownership index knows.
#[derive(Clone)]
enum Wanted {
    Table(&'static SearchableKind),
    Indexed {
        resource: ApiResource,
        namespaced: bool,
    },
}

impl Wanted {
    fn label(&self) -> String {
        match self {
            Self::Table(kind) => kind.label.to_string(),
            Self::Indexed { resource, .. } => resource.kind.clone(),
        }
    }

    fn key(&self) -> (String, String) {
        match self {
            Self::Table(kind) => kind.key(),
            Self::Indexed { resource, .. } => (resource.group.clone(), resource.plural.clone()),
        }
    }

    fn cluster_scoped(&self) -> bool {
        match self {
            Self::Table(kind) => kind.cluster_scoped,
            Self::Indexed { namespaced, .. } => !namespaced,
        }
    }

    fn named(&self) -> SearchedKind {
        let (group, plural) = self.key();
        SearchedKind {
            kind: self.label(),
            group,
            plural,
        }
    }
}

#[derive(Debug)]
struct Listed {
    names: Vec<(String, Option<String>)>,
    /// The cluster had more of this kind than one page holds.
    truncated: bool,
}

/// Which cluster, group, plural and namespace one list was of.
type ListKey = (String, String, String, Option<String>);

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
    /// The ownership index of this context, where it is running.
    index: Option<(String, Arc<ClusterIndex>)>,
    /// Read every kind the index watches, not only the table's.
    everything: bool,
    /// How long to wait for the index's kinds still listing.
    index_wait: Duration,
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

        let index = match current.as_deref() {
            Some(context) if request.everything && names.iter().any(|name| name == context) => {
                let scope = namespace.clone().map(|ns| vec![ns]);
                Some((
                    context.to_string(),
                    state.ownership.ensure(state, scope).await?,
                ))
            }
            Some(context) => state
                .ownership
                .running(context)
                .map(|index| (context.to_string(), index)),
            None => None,
        };
        let sources = Sources {
            lists: state.search_manager.lists_for(request.session.as_deref()),
            index,
            everything: request.everything,
            index_wait: INDEX_WAIT,
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
#[derive(Debug, Default, Clone)]
struct Answer {
    matched: u32,
    truncated: bool,
    searched: Vec<SearchedKind>,
    unreadable: Vec<UnreadKind>,
    loading: Vec<SearchedKind>,
}

impl Answer {
    /// Files one kind's read; the hits it adds, once the cap allows them.
    fn absorb(
        &mut self,
        kind: &Wanted,
        read: Read,
        query: &str,
        context: &str,
        limit: u32,
    ) -> Vec<SearchHit> {
        match read {
            Ok(Found::NotServed) => Vec::new(),
            Ok(Found::Loading) => {
                self.loading.push(kind.named());
                Vec::new()
            }
            Ok(Found::Listed(listed)) => {
                self.truncated |= listed.truncated;
                let named = kind.named();
                let remaining = limit.saturating_sub(self.matched) as usize;
                let mut hits: Vec<SearchHit> = listed
                    .names
                    .iter()
                    .filter(|(name, namespace)| plan::matches(query, name, namespace.as_deref()))
                    .map(|(name, namespace)| SearchHit {
                        context: context.to_string(),
                        kind: named.kind.clone(),
                        group: named.group.clone(),
                        plural: named.plural.clone(),
                        name: name.clone(),
                        namespace: namespace.clone(),
                    })
                    .collect();
                self.searched.push(named);
                if hits.len() > remaining {
                    hits.truncate(remaining);
                    self.truncated = true;
                }
                self.matched += hits.len() as u32;
                hits
            }
            Err(error) => {
                let (reason, message) = describe_failure(&error);
                let named = kind.named();
                self.unreadable.push(UnreadKind {
                    kind: named.kind,
                    group: named.group,
                    plural: named.plural,
                    reason,
                    message,
                });
                Vec::new()
            }
        }
    }
}

/// The kinds one cluster is asked about: the table's, and with `everything`
/// each other kind its ownership index watches.
fn wanted(
    kinds: &[&'static SearchableKind],
    index: Option<&ClusterIndex>,
    everything: bool,
) -> Vec<Wanted> {
    let mut wanted: Vec<Wanted> = kinds.iter().copied().map(Wanted::Table).collect();
    let Some(index) = index.filter(|_| everything) else {
        return wanted;
    };
    let table: BTreeSet<(String, String)> =
        SEARCHABLE_KINDS.iter().map(SearchableKind::key).collect();
    wanted.extend(
        index
            .kinds()
            .into_iter()
            .filter(|(key, _, _)| !table.contains(&(key.group.clone(), key.plural.clone())))
            .map(|(_, resource, namespaced)| Wanted::Indexed {
                resource,
                namespaced,
            }),
    );
    wanted
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
    let wait_until = tokio::time::Instant::now() + sources.index_wait;

    let Some(client) = resolve_client(event_tx, &client_manager, search_id, context).await else {
        return;
    };
    let index = sources
        .index
        .filter(|(indexed, _)| indexed == context)
        .map(|(_, index)| index);
    let read = |kind: Wanted, index: Option<Arc<ClusterIndex>>| {
        names_of(
            client.clone(),
            client_manager.clone(),
            kind,
            namespace.clone(),
            context.to_string(),
            index,
            sources.lists.clone(),
        )
    };
    let send = |hits: Vec<SearchHit>| {
        if !hits.is_empty() {
            let _ = event_tx.send(AppEvent::SearchHits {
                search_id: search_id.to_string(),
                context: context.to_string(),
                hits,
            });
        }
    };

    // Built as a plain Vec of futures rather than `iter().map(closure)`:
    // a closure that returns a future borrowing its argument needs an
    // HRTB rustc cannot infer here, and the error it produces
    // ("implementation of FnOnce is not general enough") points at the
    // spawn site instead of the closure.
    let mut kind_futures = Vec::new();
    for kind in wanted(&kinds, index.as_deref(), sources.everything) {
        let found = read(kind.clone(), index.clone());
        kind_futures.push(async move { (kind, found.await) });
    }
    let mut stream =
        futures::stream::iter(kind_futures).buffer_unordered(plan::MAX_KIND_CONCURRENCY);

    let mut answer = Answer::default();
    let mut waiting: Vec<Wanted> = Vec::new();
    while let Some((kind, found)) = stream.next().await {
        if matches!(found, Ok(Found::Loading)) {
            waiting.push(kind);
            continue;
        }
        if let Err(error) = &found {
            tracing::debug!(
                "Search {search_id}: {context}/{} failed: {error}",
                kind.label()
            );
        }
        send(answer.absorb(&kind, found, &query, context, limit));
    }
    drop(stream);

    // Kinds the index is still listing are waited for, and said so while
    // they are: a list that has not finished has not said there is nothing.
    if !waiting.is_empty() {
        let mut progress = answer.clone();
        progress.loading = waiting.iter().map(Wanted::named).collect();
        emit_status(
            event_tx,
            search_id,
            context,
            SearchContextStatus::Searching,
            None,
            None,
            progress,
        );
    }
    while !waiting.is_empty() && tokio::time::Instant::now() < wait_until {
        tokio::time::sleep(INDEX_POLL).await;
        let mut still = Vec::new();
        for kind in waiting {
            match read(kind.clone(), index.clone()).await {
                Ok(Found::Loading) => still.push(kind),
                found => send(answer.absorb(&kind, found, &query, context, limit)),
            }
        }
        waiting = still;
    }
    answer.loading = waiting.iter().map(Wanted::named).collect();

    // Every kind refused: this cluster produced no answer at all, so
    // it must not read as "found nothing".
    if answer.searched.is_empty() && answer.loading.is_empty() {
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
/// A kind only the index knows and is still listing is `Loading`.
fn names_of(
    client: Client,
    client_manager: Arc<K8sClientManager>,
    kind: Wanted,
    namespace: Option<String>,
    context: String,
    index: Option<Arc<ClusterIndex>>,
    lists: Option<Arc<SessionLists>>,
) -> BoxFuture<'static, Read> {
    let namespace = if kind.cluster_scoped() {
        None
    } else {
        namespace
    };
    let (group, plural) = kind.key();
    if let Some(index) = index {
        let key = KindKey {
            group: group.clone(),
            plural: plural.clone(),
        };
        match index.names(&key, namespace.as_deref()) {
            Ok(names) => {
                return futures::future::ready(Ok(Found::Listed(Arc::new(Listed {
                    names,
                    truncated: false,
                }))))
                .boxed();
            }
            Err(Reading::Syncing) if matches!(kind, Wanted::Indexed { .. }) => {
                return futures::future::ready(Ok(Found::Loading)).boxed();
            }
            Err(_) => {}
        }
    }
    let key: ListKey = (context.clone(), group, plural, namespace.clone());
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
    kind: Wanted,
    namespace: Option<String>,
    context: String,
) -> Read {
    let (api_resource, served_in) = match &kind {
        Wanted::Indexed { resource, .. } => (resource.clone(), None),
        Wanted::Table(table) => match &table.coordinates {
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
                    None => return Ok(Found::NotServed),
                }
            }
        },
    };
    let api: Api<DynamicObject> = match namespace.as_deref() {
        Some(ns) if !kind.cluster_scoped() => Api::namespaced_with(client, ns, &api_resource),
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

    Ok(Found::Listed(Arc::new(Listed {
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
        loading: answer.loading,
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
            Wanted::Table(gateway_kind("TCPRoute")),
            None,
            "kind".to_string(),
        )
        .await
        .expect("an answer");
        assert!(matches!(answer, Found::NotServed));
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
            Wanted::Table(gateway_kind("TCPRoute")),
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
                Wanted::Table(gateway_kind("HTTPRoute")),
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
                    status,
                    matched,
                    truncated,
                    searched,
                    unreadable,
                    loading,
                    ..
                } if status != SearchContextStatus::Searching => {
                    answer = Answer {
                        matched,
                        truncated,
                        searched,
                        unreadable,
                        loading,
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
            ..Sources::default()
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
            &[
                ("ServiceAccount", key("serviceaccounts")),
                ("Pod", key("pods")),
            ],
        );
        index.go_live(&key("serviceaccounts"), &[("marco", Some("team"))]);
        let (hits, answer) = statuses(
            &state,
            "marco",
            plan::resolve_kinds(Some(&["Pod".into(), "ServiceAccount".into()])).unwrap(),
            Sources {
                index: Some(("fake".to_string(), index)),
                ..Sources::default()
            },
        )
        .await;

        assert_eq!(hits.len(), 2);
        assert_eq!(answer.searched.len(), 2);
        let asked = asked.lock().unwrap();
        assert!(!asked.contains_key("/api/v1/serviceaccounts"));
        assert_eq!(asked.get("/api/v1/pods"), Some(&1));
    }

    fn widgets() -> KindKey {
        KindKey {
            group: "demo.example.com".to_string(),
            plural: "widgets".to_string(),
        }
    }

    async fn everything(wait: Duration, live_after: Option<Duration>) -> (Vec<SearchHit>, Answer) {
        use crate::client::served::{test_server::connected, ServedIndex};

        let (state, _) = connected(ServedIndex::default(), pods_and_accounts).await;
        let client = state.client_manager.get_client("fake").unwrap();
        let index = ClusterIndex::holding((*client).clone(), &[("Widget", widgets())]);
        if let Some(after) = live_after {
            let index = index.clone();
            tokio::spawn(async move {
                tokio::time::sleep(after).await;
                index.go_live(&widgets(), &[("marco-widget", Some("team"))]);
            });
        }
        statuses(
            &state,
            "marco",
            plan::resolve_kinds(Some(&["ServiceAccount".into()])).unwrap(),
            Sources {
                index: Some(("fake".to_string(), index)),
                everything: true,
                index_wait: wait,
                ..Sources::default()
            },
        )
        .await
    }

    /// Searching every kind reads the ones only the ownership index knows,
    /// a custom resource among them, and waits for one still listing rather
    /// than calling it empty.
    #[tokio::test]
    async fn searching_every_kind_waits_for_a_kind_the_index_is_still_listing() {
        let (hits, answer) =
            everything(Duration::from_secs(3), Some(Duration::from_millis(200))).await;
        assert!(
            hits.iter().any(|hit| hit.kind == "Widget"
                && hit.group == "demo.example.com"
                && hit.name == "marco-widget"),
            "the widget the index finished listing: {hits:?}"
        );
        assert!(answer.loading.is_empty());
        assert!(answer.searched.iter().any(|kind| kind.kind == "Widget"));
    }

    /// A kind still listing when the wait runs out is named as loading, and
    /// the cluster still answers for what it read: neither "no widgets" nor
    /// a failed cluster.
    #[tokio::test]
    async fn a_kind_still_listing_when_the_wait_ends_is_named_as_loading() {
        let (hits, answer) = everything(Duration::ZERO, None).await;
        assert_eq!(hits.len(), 1, "the service account is still found");
        assert_eq!(
            answer
                .loading
                .iter()
                .map(|kind| kind.kind.as_str())
                .collect::<Vec<_>>(),
            ["Widget"]
        );
        assert!(!answer.searched.iter().any(|kind| kind.kind == "Widget"));
    }

    /// Without being asked for every kind, the index's other kinds are not
    /// read, so the search costs what it cost before.
    #[tokio::test]
    async fn a_running_index_adds_no_kinds_unless_every_kind_was_asked_for() {
        use crate::client::served::{test_server::connected, ServedIndex};

        let (state, _) = connected(ServedIndex::default(), pods_and_accounts).await;
        let client = state.client_manager.get_client("fake").unwrap();
        let index = ClusterIndex::holding((*client).clone(), &[("Widget", widgets())]);
        index.go_live(&widgets(), &[("marco-widget", Some("team"))]);
        let (hits, answer) = statuses(
            &state,
            "marco",
            plan::resolve_kinds(Some(&["ServiceAccount".into()])).unwrap(),
            Sources {
                index: Some(("fake".to_string(), index)),
                ..Sources::default()
            },
        )
        .await;
        assert_eq!(hits.len(), 1);
        assert_eq!(answer.searched.len(), 1);
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
