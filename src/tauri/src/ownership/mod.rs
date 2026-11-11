//! Who owns what, read the way the garbage collector reads it: a
//! metadata-only list and watch on every kind the cluster lets this user list
//! and watch, and each owner's dependents gathered from `ownerReferences`.
//! The API has no reverse lookup; this is one.
//!
//! The watches are counted, each holding a connection of its own: a kind past
//! the count is read by its list alone, again on every turn, until a watch
//! comes free.
//!
//! Started by the first question and stopped after three idle minutes, as the
//! overview's watches are. Every kind carries how well it was read: a
//! dependent missing from a kind nobody could read is not a dependent that
//! does not exist.

mod graph;
mod slots;

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use dashmap::DashMap;
use kube::discovery::ApiResource;
use kube::Client;
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

use crate::client::served::Served;
use crate::commands::catalog::UnreadGroup;
use crate::error::Result;
use crate::state::AppState;

pub use graph::{Dependent, KindCount, KindKey, DEPENDENTS_PAGE};
use graph::{Graph, SlotKey};

/// Watches nobody has asked anything of for this long are stopped.
const IDLE_AFTER: Duration = Duration::from_mins(3);
const REAP_EVERY: Duration = Duration::from_secs(30);

/// Kinds left out on purpose: events turn over by the thousand and nothing
/// owns them. Each is still named as not read.
const SKIPPED: [(&str, &str); 2] = [("", "events"), ("events.k8s.io", "events")];

/// The most watches the indexes of every cluster hold open together, each
/// on a connection of its own: more than the kinds of a cluster running a
/// dozen operators, and far fewer than one per kind and namespace.
const MAX_WATCHES: usize = 300;

/// How many watches fit beside everything else the app keeps open, given
/// the open files this process is allowed.
fn watch_budget(open_files: Option<u64>) -> usize {
    open_files.map_or(MAX_WATCHES, |limit| {
        MAX_WATCHES.min(usize::try_from(limit / 2).unwrap_or(MAX_WATCHES))
    })
}

fn open_files() -> Option<u64> {
    #[cfg(unix)]
    return crate::client::open_files::allowed();
    #[cfg(not(unix))]
    None
}

/// How many kinds with no watch are listed at once, on the connections the
/// lists share.
const LISTS_AT_ONCE: usize = 8;

/// How long a turn is kept after its list: with the count above that is at
/// most thirty-two lists a second, however fast the cluster answers.
const TURN_PAUSE: Duration = Duration::from_millis(250);

/// How long a kind read by its list alone waits before its next turn.
const RELIST_EVERY: Duration = Duration::from_secs(30);

/// How old such a list may be and still be the kind as it is: three turns.
const LISTED_FOR: Duration = RELIST_EVERY.saturating_mul(3);

/// How one kind is being read, across the cluster or in one namespace.
#[derive(Debug, Clone, PartialEq, Eq)]
enum SlotState {
    /// No watch is free, and its first turn to be listed has not come.
    Queued,
    Syncing,
    Live,
    /// Read by its list at `at` with no watch behind it, and listed again
    /// on its next turn.
    Listed {
        at: chrono::DateTime<chrono::Utc>,
    },
    Stale {
        since: String,
    },
    Refused {
        message: String,
    },
    Failed {
        message: String,
    },
}

/// How well one kind is read, for every kind that is not simply live.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "says", rename_all = "camelCase")]
pub enum Reading {
    /// Still listing.
    Syncing,
    /// Not read yet: the app holds as many watches open as it allows itself,
    /// and the kind's turn to be listed has not come.
    Queued,
    /// The watch broke, or the kind's turn to be listed again is long
    /// overdue; what it holds is from then.
    Stale {
        since: String,
    },
    /// The cluster refused the list, everywhere this could ask.
    Refused {
        message: String,
    },
    /// Refused across the cluster, and read only in these namespaces.
    Partial {
        namespaces: Vec<String>,
    },
    Failed {
        message: String,
    },
    /// Discovery offers no list of it.
    Unlistable,
    /// Discovery offers a list of it and no watch.
    Unwatchable,
    /// Left out on purpose.
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KindReading {
    pub kind: String,
    pub group: String,
    pub plural: String,
    pub reading: Reading,
}

/// What a deletion takes because the object holds it, which no
/// ownerReference says.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "says", rename_all = "camelCase")]
pub enum Holds {
    /// A `CustomResourceDefinition`: every object of the kind it defines.
    Objects {
        kind: Option<String>,
        group: String,
        plural: String,
        count: usize,
        /// How well that kind was read; none where it is live.
        reading: Option<Reading>,
    },
    /// A Namespace: everything inside it.
    Namespace,
}

const DEFINITIONS: (&str, &str) = ("apiextensions.k8s.io", "customresourcedefinitions");
const NAMESPACES: (&str, &str) = ("", "namespaces");

/// Why a served kind is never watched, by the verbs discovery offers it with.
fn unwatched(group: &str, plural: &str, verbs: &[String]) -> Option<Reading> {
    let offers = |verb: &str| verbs.iter().any(|offered| offered == verb);
    if SKIPPED.contains(&(group, plural)) {
        Some(Reading::Skipped)
    } else if !offers("list") {
        Some(Reading::Unlistable)
    } else if !offers("watch") {
        Some(Reading::Unwatchable)
    } else {
        None
    }
}

fn is(key: &KindKey, (group, plural): (&str, &str)) -> bool {
    key.group == group && key.plural == plural
}

/// The kind a CRD named `<plural>.<group>` defines.
fn defined_by(name: &str) -> Option<KindKey> {
    let (plural, group) = name.split_once('.')?;
    Some(KindKey {
        group: group.to_string(),
        plural: plural.to_string(),
    })
}

/// Everything the index could not vouch for when it answered.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotRead {
    pub kinds: Vec<KindReading>,
    pub groups: Vec<UnreadGroup>,
    /// How many kinds the index watches, so a reader can say how far it got.
    pub watched: usize,
}

struct Watched {
    resource: ApiResource,
    namespaced: bool,
}

pub struct ClusterIndex {
    graph: RwLock<Graph>,
    slots: Mutex<BTreeMap<SlotKey, SlotState>>,
    /// Each running watch's own stop, taken under `slots`' lock.
    stops: Mutex<BTreeMap<SlotKey, CancellationToken>>,
    watched: Mutex<BTreeMap<KindKey, Watched>>,
    /// Kinds never watched, and why.
    unwatched: Mutex<BTreeMap<KindKey, (String, Reading)>>,
    unread_groups: Mutex<Vec<UnreadGroup>>,
    /// The window's namespaces, where a refused kind is read instead.
    scope: Mutex<Option<Vec<String>>>,
    last_used: Mutex<Instant>,
    client: Client,
    stop: CancellationToken,
    /// What this connection was refused, kept across the index idling out.
    refusals: Refusals,
    /// One permit per running watch, shared by every cluster's index.
    watches: Arc<Semaphore>,
    /// One permit per list of a kind that has no watch, shared the same way.
    turns: Arc<Semaphore>,
}

/// Slots the cluster refused on one connection, and its words for it.
type Refusals = Arc<Mutex<BTreeMap<SlotKey, String>>>;

pub struct OwnershipIndexes {
    clusters: Arc<DashMap<String, Arc<ClusterIndex>>>,
    /// Per context, until it connects again: a refused list is not asked again
    /// when an idle index starts over, which was a 403 and a warning per kind.
    refusals: DashMap<String, Refusals>,
    watches: Arc<Semaphore>,
    turns: Arc<Semaphore>,
}

impl Default for OwnershipIndexes {
    fn default() -> Self {
        Self {
            clusters: Arc::default(),
            refusals: DashMap::new(),
            watches: Arc::new(Semaphore::new(watch_budget(open_files()))),
            turns: Arc::new(Semaphore::new(LISTS_AT_ONCE)),
        }
    }
}

impl OwnershipIndexes {
    /// The current cluster's index, started on the first call. `scope` is
    /// where a kind refused across the cluster is read instead.
    ///
    /// # Errors
    ///
    /// No cluster, or the list of API groups could not be read.
    pub async fn ensure(
        &self,
        state: &AppState,
        scope: Option<Vec<String>>,
    ) -> Result<Arc<ClusterIndex>> {
        let context = state.get_current_context().ok_or_else(|| {
            crate::error::Error::Internal(crate::error::messages::NO_CLUSTER.to_string())
        })?;
        if let Some(index) = self.clusters.get(&context).map(|held| held.clone()) {
            *index.last_used.lock() = Instant::now();
            index.rescope(scope);
            for kind in index.unread_definitions() {
                if let Ok(Some(served)) = state.served(&kind.group, &kind.plural).await {
                    index.watch(kind, served);
                }
            }
            self.make_room(&context, &index);
            return Ok(index);
        }
        let client = crate::commands::helpers::ResourceContext::for_list(state, None)?.client;
        let catalog = crate::commands::catalog::catalog(state).await?;
        let index = Arc::new(ClusterIndex {
            graph: RwLock::new(Graph::default()),
            slots: Mutex::new(BTreeMap::new()),
            stops: Mutex::new(BTreeMap::new()),
            watched: Mutex::new(BTreeMap::new()),
            unwatched: Mutex::new(BTreeMap::new()),
            unread_groups: Mutex::new(catalog.unread),
            scope: Mutex::new(scope),
            last_used: Mutex::new(Instant::now()),
            client,
            stop: CancellationToken::new(),
            refusals: self.refusals.entry(context.clone()).or_default().clone(),
            watches: self.watches.clone(),
            turns: self.turns.clone(),
        });
        let index = self
            .clusters
            .entry(context.clone())
            .or_insert(index)
            .clone();
        if !index.watched.lock().is_empty() || !index.unwatched.lock().is_empty() {
            return Ok(index);
        }
        for entry in catalog.entries {
            let key = KindKey {
                group: entry.group.clone(),
                plural: entry.plural.clone(),
            };
            if let Some(reading) = unwatched(&entry.group, &entry.plural, &entry.verbs) {
                index.unwatched.lock().insert(key, (entry.kind, reading));
                continue;
            }
            let resource = ApiResource {
                group: entry.group.clone(),
                version: entry.version.clone(),
                api_version: if entry.group.is_empty() {
                    entry.version.clone()
                } else {
                    format!("{}/{}", entry.group, entry.version)
                },
                kind: entry.kind,
                plural: entry.plural,
            };
            index.watched.lock().insert(
                key.clone(),
                Watched {
                    resource: resource.clone(),
                    namespaced: entry.namespaced,
                },
            );
            slots::spawn(
                &index,
                SlotKey {
                    kind: key,
                    namespace: None,
                },
                resource,
            );
        }
        self.make_room(&context, &index);
        spawn_reaper(self.clusters.clone(), context, index.clone());
        Ok(index)
    }

    /// The cluster on screen comes first: where its index is short of a
    /// watch, those of the clusters the window left stop now, not when idle.
    fn make_room(&self, context: &str, index: &ClusterIndex) {
        let short = index
            .slots
            .lock()
            .values()
            .any(|state| matches!(state, SlotState::Queued | SlotState::Listed { .. }));
        if !short {
            return;
        }
        self.clusters.retain(|held, left| {
            if held != context {
                tracing::info!(
                    context = held,
                    "ownership watches given up to the cluster on screen"
                );
                left.stop.cancel();
            }
            held == context
        });
    }

    /// A context's index where one is already running; none is started.
    #[must_use]
    pub fn running(&self, context: &str) -> Option<Arc<ClusterIndex>> {
        self.clusters.get(context).map(|held| held.clone())
    }

    pub fn forget(&self, context: &str) {
        self.refusals.remove(context);
        if let Some((_, index)) = self.clusters.remove(context) {
            index.stop.cancel();
        }
    }

    pub fn forget_all(&self) {
        self.refusals.clear();
        for entry in self.clusters.iter() {
            entry.stop.cancel();
        }
        self.clusters.clear();
    }
}

fn spawn_reaper(
    clusters: Arc<DashMap<String, Arc<ClusterIndex>>>,
    context: String,
    index: Arc<ClusterIndex>,
) {
    tokio::spawn(async move {
        loop {
            tokio::select! {
                biased;
                () = index.stop.cancelled() => break,
                () = tokio::time::sleep(REAP_EVERY) => {}
            }
            if index.last_used.lock().elapsed() > IDLE_AFTER {
                tracing::info!(context, "ownership watches idle; stopped");
                clusters.remove_if(&context, |_, held| Arc::ptr_eq(held, &index));
                index.stop.cancel();
                break;
            }
        }
    });
}

impl ClusterIndex {
    /// One page of the direct dependents of `uid`, which page it is, how
    /// many there are in all, and what was not read.
    #[must_use]
    pub fn dependents(&self, uid: &str, page: usize) -> (Vec<Dependent>, usize, usize, NotRead) {
        let (rows, page, total) = self.graph.read().dependents_of(uid, page);
        (rows, page, total, self.not_read())
    }

    /// The dependents of `owner` before and after `uid` among those of its kind.
    #[must_use]
    pub fn beside(&self, owner: &str, uid: &str) -> (Option<Dependent>, Option<Dependent>) {
        self.graph.read().beside(owner, uid)
    }

    /// What deleting `uid` would take with it, what it holds besides, and
    /// what was not read. `unindexed` is why a CRD's kind is not read when
    /// the index has never heard of it.
    #[must_use]
    pub fn cascade(
        &self,
        uid: &str,
        unindexed: Option<Reading>,
    ) -> (Vec<KindCount>, NotRead, Option<Holds>) {
        let not_read = self.not_read();
        let graph = self.graph.read();
        let (takes, holds) = cascade_in(
            &graph,
            uid,
            &not_read,
            |kind| {
                self.watched
                    .lock()
                    .get(kind)
                    .map(|watched| watched.resource.kind.clone())
            },
            unindexed,
        );
        (takes, not_read, holds)
    }

    /// The kind a CRD defines, where `uid` is a CRD the index has read and
    /// its kind is one the index does not.
    #[must_use]
    pub fn unindexed_definition(&self, uid: &str) -> Option<KindKey> {
        let defined = {
            let graph = self.graph.read();
            let node = graph.node(uid)?;
            if !is(&node.key, DEFINITIONS) {
                return None;
            }
            defined_by(&node.name)?
        };
        (!self.knows(&defined)).then_some(defined)
    }

    /// Every name of one kind the index holds, where it reads that kind whole
    /// or, for `namespace`, in that namespace; how it reads it otherwise.
    ///
    /// # Errors
    ///
    /// The kind is not live here: still listing, refused, stale or unwatched.
    pub fn names(
        &self,
        kind: &KindKey,
        namespace: Option<&str>,
    ) -> std::result::Result<Vec<(String, Option<String>)>, Reading> {
        let slots = self.slots_now();
        let whole = SlotKey {
            kind: kind.clone(),
            namespace: None,
        };
        if !slots.contains_key(&whole) {
            return Err(self
                .unwatched
                .lock()
                .get(kind)
                .map_or(Reading::Syncing, |(_, reading)| reading.clone()));
        }
        match reading_of(kind, &slots) {
            None => {}
            Some(Reading::Partial { namespaces })
                if namespace.is_some_and(|ns| namespaces.iter().any(|read| read == ns)) => {}
            Some(reading) => return Err(reading),
        }
        let graph = self.graph.read();
        Ok(graph
            .of_kind(kind)
            .iter()
            .filter_map(|uid| graph.node(uid))
            .filter(|node| namespace.is_none() || node.namespace.as_deref() == namespace)
            .map(|node| (node.name.clone(), node.namespace.clone()))
            .collect())
    }

    /// Every kind the index watches, where it is served, and its scope.
    #[must_use]
    pub fn kinds(&self) -> Vec<(KindKey, ApiResource, bool)> {
        self.watched
            .lock()
            .iter()
            .map(|(key, watched)| (key.clone(), watched.resource.clone(), watched.namespaced))
            .collect()
    }

    /// Kinds a CRD the index holds defines and the index does not know: one
    /// installed after it started, or in a group discovery missed.
    fn unread_definitions(&self) -> Vec<KindKey> {
        let defined: Vec<KindKey> = {
            let graph = self.graph.read();
            let definitions = KindKey {
                group: DEFINITIONS.0.to_string(),
                plural: DEFINITIONS.1.to_string(),
            };
            graph
                .of_kind(&definitions)
                .iter()
                .filter_map(|uid| defined_by(&graph.node(uid)?.name))
                .collect()
        };
        defined
            .into_iter()
            .filter(|kind| !self.knows(kind))
            .collect()
    }

    fn knows(&self, kind: &KindKey) -> bool {
        self.watched.lock().contains_key(kind) || self.unwatched.lock().contains_key(kind)
    }

    /// Starts reading a kind served since the index began: a CRD installed
    /// after it.
    pub fn watch(self: &Arc<Self>, kind: KindKey, served: Served) {
        {
            let mut watched = self.watched.lock();
            if watched.contains_key(&kind) || self.unwatched.lock().contains_key(&kind) {
                return;
            }
            watched.insert(
                kind.clone(),
                Watched {
                    resource: served.resource.clone(),
                    namespaced: served.namespaced,
                },
            );
        }
        slots::spawn(
            self,
            SlotKey {
                kind,
                namespace: None,
            },
            served.resource,
        );
    }

    /// The slots as they read now: a list whose next turn is long overdue is
    /// no longer the kind as it is, and says since when.
    fn slots_now(&self) -> BTreeMap<SlotKey, SlotState> {
        let mut slots = self.slots.lock().clone();
        let overdue = chrono::Utc::now() - LISTED_FOR;
        for state in slots.values_mut() {
            if let SlotState::Listed { at } = *state {
                if at < overdue {
                    *state = SlotState::Stale {
                        since: at.to_rfc3339(),
                    };
                }
            }
        }
        slots
    }

    /// Every kind that is not live, named, plus every group discovery missed.
    #[must_use]
    pub fn not_read(&self) -> NotRead {
        let unread = self.unread_definitions();
        let slots = self.slots_now();
        let watched = self.watched.lock();
        let mut kinds: Vec<KindReading> = watched
            .iter()
            .filter_map(|(key, watched)| {
                reading_of(key, &slots).map(|reading| KindReading {
                    kind: watched.resource.kind.clone(),
                    group: key.group.clone(),
                    plural: key.plural.clone(),
                    reading,
                })
            })
            .collect();
        kinds.extend(
            self.unwatched
                .lock()
                .iter()
                .map(|(key, (kind, reading))| KindReading {
                    kind: kind.clone(),
                    group: key.group.clone(),
                    plural: key.plural.clone(),
                    reading: reading.clone(),
                }),
        );
        // Metadata does not say the kind's own name; the plural stands in
        // until discovery serves it.
        kinds.extend(unread.into_iter().map(|key| KindReading {
            kind: key.plural.clone(),
            group: key.group,
            plural: key.plural,
            reading: Reading::Syncing,
        }));
        NotRead {
            kinds,
            groups: self.unread_groups.lock().clone(),
            watched: watched.len(),
        }
    }

    /// Read every refused kind in the namespaces of `scope`, and stop
    /// reading it in those that left: the window has one scope, and a watch
    /// per kind for every namespace ever picked ran until the index idled.
    fn rescope(self: &Arc<Self>, scope: Option<Vec<String>>) {
        let namespaces = scope.clone().unwrap_or_default();
        *self.scope.lock() = scope;
        {
            let mut slots = self.slots.lock();
            let mut stops = self.stops.lock();
            let mut graph = self.graph.write();
            slots.retain(|slot, _| {
                let kept = slot
                    .namespace
                    .as_ref()
                    .is_none_or(|namespace| namespaces.contains(namespace));
                if !kept {
                    if let Some(stop) = stops.remove(slot) {
                        stop.cancel();
                    }
                    graph.drop_slot(slot);
                }
                kept
            });
        }
        let refused: Vec<KindKey> = self
            .slots
            .lock()
            .iter()
            .filter(|(slot, state)| {
                slot.namespace.is_none() && matches!(state, SlotState::Refused { .. })
            })
            .map(|(slot, _)| slot.kind.clone())
            .collect();
        for kind in refused {
            self.fall_back(&kind, &namespaces);
        }
    }

    /// A kind refused across the cluster, read in each namespace instead.
    fn fall_back(self: &Arc<Self>, kind: &KindKey, namespaces: &[String]) {
        let resource = {
            let watched = self.watched.lock();
            match watched.get(kind) {
                Some(found) if found.namespaced => found.resource.clone(),
                _ => return,
            }
        };
        for namespace in namespaces {
            let slot = SlotKey {
                kind: kind.clone(),
                namespace: Some(namespace.clone()),
            };
            if self.slots.lock().contains_key(&slot) {
                continue;
            }
            slots::spawn(self, slot, resource.clone());
        }
    }
}

#[cfg(test)]
impl ClusterIndex {
    /// An index watching `kinds`, each still listing, with no watch behind it.
    pub(crate) fn holding(client: Client, kinds: &[(&str, KindKey)]) -> Arc<Self> {
        Self::remembering(client, kinds, Refusals::default())
    }

    /// The same, sharing what a connection was refused with another index.
    fn remembering(client: Client, kinds: &[(&str, KindKey)], refusals: Refusals) -> Arc<Self> {
        let index = Self {
            graph: RwLock::new(Graph::default()),
            slots: Mutex::new(BTreeMap::new()),
            stops: Mutex::new(BTreeMap::new()),
            watched: Mutex::new(BTreeMap::new()),
            unwatched: Mutex::new(BTreeMap::new()),
            unread_groups: Mutex::new(Vec::new()),
            scope: Mutex::new(None),
            last_used: Mutex::new(Instant::now()),
            client,
            stop: CancellationToken::new(),
            refusals,
            watches: Arc::new(Semaphore::new(MAX_WATCHES)),
            turns: Arc::new(Semaphore::new(LISTS_AT_ONCE)),
        };
        for (kind, key) in kinds {
            let resource = ApiResource {
                group: key.group.clone(),
                version: "v1".to_string(),
                api_version: if key.group.is_empty() {
                    "v1".to_string()
                } else {
                    format!("{}/v1", key.group)
                },
                kind: (*kind).to_string(),
                plural: key.plural.clone(),
            };
            index.watched.lock().insert(
                key.clone(),
                Watched {
                    resource,
                    namespaced: true,
                },
            );
            index.slots.lock().insert(
                SlotKey {
                    kind: key.clone(),
                    namespace: None,
                },
                SlotState::Syncing,
            );
        }
        Arc::new(index)
    }

    /// One watched kind done listing, holding `names`.
    pub(crate) fn go_live(&self, key: &KindKey, names: &[(&str, Option<&str>)]) {
        let slot = SlotKey {
            kind: key.clone(),
            namespace: None,
        };
        for (at, (name, namespace)) in names.iter().enumerate() {
            self.graph.write().apply(
                &slot,
                format!("{}/{at}", key.plural),
                graph::Node {
                    key: key.clone(),
                    kind: key.plural.clone(),
                    version: "v1".to_string(),
                    name: (*name).to_string(),
                    namespace: namespace.map(str::to_string),
                    owners: Vec::new(),
                },
            );
        }
        self.slots.lock().insert(slot, SlotState::Live);
    }
}

/// The cascade from `uid`, with what it holds: a namespace its contents, a
/// CRD every object of its kind. `indexed` names a kind the index watches.
fn cascade_in(
    graph: &Graph,
    uid: &str,
    not_read: &NotRead,
    indexed: impl Fn(&KindKey) -> Option<String>,
    unindexed: Option<Reading>,
) -> (Vec<KindCount>, Option<Holds>) {
    let Some(node) = graph.node(uid) else {
        return (graph.cascade(uid, &[]), None);
    };
    if is(&node.key, NAMESPACES) {
        let inside = graph.inside(&node.name);
        return (graph.cascade(uid, &inside), Some(Holds::Namespace));
    }
    let Some(defined) = is(&node.key, DEFINITIONS)
        .then(|| defined_by(&node.name))
        .flatten()
    else {
        return (graph.cascade(uid, &[]), None);
    };
    let objects = graph.of_kind(&defined);
    let named = not_read
        .kinds
        .iter()
        .find(|reading| reading.group == defined.group && reading.plural == defined.plural);
    let (kind, reading) = match (named, indexed(&defined)) {
        (Some(named), _) => (Some(named.kind.clone()), Some(named.reading.clone())),
        (None, Some(kind)) => (Some(kind), None),
        (None, None) => (None, Some(unindexed.unwrap_or(Reading::Syncing))),
    };
    let holds = Holds::Objects {
        kind,
        group: defined.group,
        plural: defined.plural,
        count: objects.len(),
        reading,
    };
    (graph.cascade(uid, &objects), Some(holds))
}

/// One kind's reading from its slots: `None` where it is simply live.
fn reading_of(kind: &KindKey, slots: &BTreeMap<SlotKey, SlotState>) -> Option<Reading> {
    let Some(cluster) = slots.get(&SlotKey {
        kind: kind.clone(),
        namespace: None,
    }) else {
        return Some(Reading::Syncing);
    };
    match cluster {
        SlotState::Live | SlotState::Listed { .. } => None,
        SlotState::Syncing => Some(Reading::Syncing),
        SlotState::Queued => Some(Reading::Queued),
        SlotState::Stale { since } => Some(Reading::Stale {
            since: since.clone(),
        }),
        SlotState::Failed { message } => Some(Reading::Failed {
            message: message.clone(),
        }),
        SlotState::Refused { message } => {
            let fallbacks: Vec<(&String, &SlotState)> = slots
                .iter()
                .filter(|(slot, _)| slot.kind == *kind)
                .filter_map(|(slot, state)| slot.namespace.as_ref().map(|ns| (ns, state)))
                .collect();
            if fallbacks.is_empty() {
                return Some(Reading::Refused {
                    message: message.clone(),
                });
            }
            if fallbacks
                .iter()
                .any(|(_, state)| matches!(state, SlotState::Syncing))
            {
                return Some(Reading::Syncing);
            }
            let namespaces: BTreeSet<String> = fallbacks
                .iter()
                .filter(|(_, state)| {
                    matches!(
                        state,
                        SlotState::Live | SlotState::Listed { .. } | SlotState::Stale { .. }
                    )
                })
                .map(|(ns, _)| (*ns).clone())
                .collect();
            Some(if !namespaces.is_empty() {
                Reading::Partial {
                    namespaces: namespaces.into_iter().collect(),
                }
            } else if fallbacks
                .iter()
                .any(|(_, state)| matches!(state, SlotState::Queued))
            {
                Reading::Queued
            } else {
                Reading::Refused {
                    message: message.clone(),
                }
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kind() -> KindKey {
        KindKey {
            group: String::new(),
            plural: "pods".to_string(),
        }
    }

    fn slot(namespace: Option<&str>) -> SlotKey {
        SlotKey {
            kind: kind(),
            namespace: namespace.map(str::to_string),
        }
    }

    fn refused() -> SlotState {
        SlotState::Refused {
            message: "pods is forbidden".to_string(),
        }
    }

    /// A kind read live says nothing; only what was not read is named.
    #[test]
    fn a_live_kind_is_not_named() {
        let slots = BTreeMap::from([(slot(None), SlotState::Live)]);
        assert_eq!(reading_of(&kind(), &slots), None);
    }

    /// Refused across the cluster and read in two namespaces is neither
    /// "read" nor "refused": it is read there and only there.
    #[test]
    fn a_kind_read_only_in_some_namespaces_says_which() {
        let slots = BTreeMap::from([
            (slot(None), refused()),
            (slot(Some("shop")), SlotState::Live),
            (slot(Some("web")), refused()),
        ]);
        assert_eq!(
            reading_of(&kind(), &slots),
            Some(Reading::Partial {
                namespaces: vec!["shop".to_string()]
            })
        );
    }

    #[test]
    fn a_kind_refused_everywhere_is_refused() {
        let slots = BTreeMap::from([(slot(None), refused())]);
        assert!(matches!(
            reading_of(&kind(), &slots),
            Some(Reading::Refused { .. })
        ));
    }

    /// A kind the index watches and has no watch for yet read as live: a
    /// kind served a moment ago was "read, and nothing there". Fails if a
    /// watched kind with no slot says nothing.
    #[test]
    fn a_watched_kind_with_no_watch_yet_is_still_listing() {
        assert_eq!(
            reading_of(&kind(), &BTreeMap::new()),
            Some(Reading::Syncing)
        );
    }

    /// Refused across the cluster, with its namespaces waiting for a free
    /// watch, is not yet refused everywhere: nobody has asked them.
    #[test]
    fn a_refused_kind_whose_namespaces_wait_for_a_watch_says_it_waits() {
        let slots = BTreeMap::from([
            (slot(None), refused()),
            (slot(Some("shop")), SlotState::Queued),
        ]);
        assert_eq!(reading_of(&kind(), &slots), Some(Reading::Queued));
    }

    /// A kind read by its list alone is read. Named as not read, no Delete
    /// on a cluster with more kinds than watches ever said that nothing else
    /// goes with it. Fails if such a kind is named, or left out of the
    /// namespaces a refused kind was read in.
    #[test]
    fn a_kind_read_by_its_list_alone_is_read() {
        let listed = SlotState::Listed {
            at: chrono::Utc::now(),
        };
        let whole = BTreeMap::from([(slot(None), listed.clone())]);
        assert_eq!(reading_of(&kind(), &whole), None);

        let slots = BTreeMap::from([
            (slot(None), refused()),
            (slot(Some("shop")), listed),
            (slot(Some("web")), SlotState::Queued),
        ]);
        assert_eq!(
            reading_of(&kind(), &slots),
            Some(Reading::Partial {
                namespaces: vec!["shop".to_string()]
            })
        );
    }

    /// A list is the kind as it was when it answered. Fails if one whose
    /// next turn never came still reads as the kind as it is, however old,
    /// or if a list within its turns is called stale.
    #[tokio::test]
    async fn a_list_long_past_its_next_turn_is_stale_since_it_answered() {
        use crate::client::served::test_server::answering;
        let (client, _) = answering(|_, _| (404, "{}".to_string())).await;
        let index = ClusterIndex::holding(client, &[("Pod", kind())]);
        let listed = |at| {
            index
                .slots
                .lock()
                .insert(slot(None), SlotState::Listed { at });
            index.not_read().kinds
        };

        let at = chrono::Utc::now() - LISTED_FOR - Duration::from_secs(1);
        let [named] = &listed(at)[..] else {
            panic!("the kind is not named");
        };
        assert_eq!(
            named.reading,
            Reading::Stale {
                since: at.to_rfc3339()
            }
        );
        assert_eq!(index.names(&kind(), None), Err(named.reading.clone()));

        assert_eq!(listed(chrono::Utc::now()), []);
    }

    /// launchd hands a Finder-launched app 256 open files; where raising
    /// that fails, 300 watches would take every one. Fails if the watches
    /// may take more than half of what the process is allowed.
    #[test]
    fn the_watches_leave_half_the_open_files_to_everything_else() {
        assert_eq!(watch_budget(Some(256)), 128);
        assert_eq!(watch_budget(Some(10_240)), MAX_WATCHES);
        assert_eq!(watch_budget(None), MAX_WATCHES);
    }

    /// A watch still listing has not said there is nothing.
    #[test]
    fn a_kind_still_listing_says_so() {
        let slots = BTreeMap::from([(slot(None), SlotState::Syncing)]);
        assert_eq!(reading_of(&kind(), &slots), Some(Reading::Syncing));
    }

    fn put(
        graph: &mut Graph,
        uid: &str,
        key: (&str, &str),
        kind: &str,
        name: &str,
        ns: Option<&str>,
    ) {
        let key = KindKey {
            group: key.0.to_string(),
            plural: key.1.to_string(),
        };
        graph.apply(
            &SlotKey {
                kind: key.clone(),
                namespace: None,
            },
            uid.to_string(),
            graph::Node {
                key,
                kind: kind.to_string(),
                version: "v1".to_string(),
                name: name.to_string(),
                namespace: ns.map(str::to_string),
                owners: Vec::new(),
            },
        );
    }

    const WIDGETS: (&str, &str) = ("demo.example.com", "widgets");

    fn widgets() -> Graph {
        let mut graph = Graph::default();
        put(
            &mut graph,
            "crd",
            DEFINITIONS,
            "CustomResourceDefinition",
            "widgets.demo.example.com",
            None,
        );
        put(&mut graph, "w1", WIDGETS, "Widget", "one", Some("shop"));
        put(&mut graph, "w2", WIDGETS, "Widget", "two", Some("web"));
        graph
    }

    fn objects(holds: Option<Holds>) -> (Option<String>, usize, Option<Reading>) {
        match holds {
            Some(Holds::Objects {
                kind,
                count,
                reading,
                ..
            }) => (kind, count, reading),
            other => panic!("expected the objects a CRD defines, got {other:?}"),
        }
    }

    /// No ownerReference names a custom resource's CRD, so the plain
    /// cascade said in green that nothing else goes with it.
    #[test]
    fn a_crd_holds_every_object_of_its_kind_in_every_namespace() {
        let (takes, holds) = cascade_in(
            &widgets(),
            "crd",
            &NotRead::default(),
            |_| Some("Widget".to_string()),
            None,
        );
        assert_eq!(objects(holds), (Some("Widget".to_string()), 2, None));
        assert_eq!(takes.len(), 1);
        assert_eq!(takes[0].count, 2);
    }

    /// Two objects read is not every object when the list was refused.
    #[test]
    fn a_crd_whose_kind_was_refused_says_so_beside_what_it_counted() {
        let refused = Reading::Refused {
            message: "widgets is forbidden".to_string(),
        };
        let not_read = NotRead {
            kinds: vec![KindReading {
                kind: "Widget".to_string(),
                group: WIDGETS.0.to_string(),
                plural: WIDGETS.1.to_string(),
                reading: refused.clone(),
            }],
            groups: Vec::new(),
            watched: 1,
        };
        let (_, holds) = cascade_in(&widgets(), "crd", &not_read, |_| None, None);
        assert_eq!(objects(holds).2, Some(refused));
    }

    /// `ComponentStatus` is offered get and list and no watch, and was called
    /// a kind that cannot be listed while kubectl lists it. Fails if a kind
    /// with a list is said to have none, or if a kind with no list is said to
    /// lack only a watch.
    #[test]
    fn a_kind_is_left_out_for_the_verb_it_lacks() {
        let verbs = |offered: &[&str]| -> Vec<String> {
            offered.iter().map(|verb| (*verb).to_string()).collect()
        };
        assert_eq!(
            unwatched("", "componentstatuses", &verbs(&["get", "list"])),
            Some(Reading::Unwatchable)
        );
        assert_eq!(
            unwatched(
                "authorization.k8s.io",
                "selfsubjectaccessreviews",
                &verbs(&["create"])
            ),
            Some(Reading::Unlistable)
        );
        assert_eq!(
            unwatched("", "events", &verbs(&["get", "list", "watch"])),
            Some(Reading::Skipped)
        );
        assert_eq!(
            unwatched("apps", "deployments", &verbs(&["get", "list", "watch"])),
            None
        );
    }

    /// A kind the index never watched has not been counted, whatever the
    /// count of zero would say.
    #[test]
    fn a_crd_whose_kind_the_index_never_read_says_why() {
        let mut graph = Graph::default();
        put(
            &mut graph,
            "crd",
            DEFINITIONS,
            "CustomResourceDefinition",
            "widgets.demo.example.com",
            None,
        );
        let (_, holds) = cascade_in(
            &graph,
            "crd",
            &NotRead::default(),
            |_| None,
            Some(Reading::Unlistable),
        );
        assert_eq!(objects(holds), (None, 0, Some(Reading::Unlistable)));
    }

    #[test]
    fn a_namespace_holds_everything_inside_it() {
        let mut graph = widgets();
        put(&mut graph, "ns", NAMESPACES, "Namespace", "shop", None);
        let (takes, holds) = cascade_in(&graph, "ns", &NotRead::default(), |_| None, None);
        assert_eq!(holds, Some(Holds::Namespace));
        assert_eq!(takes.len(), 1);
        assert_eq!((takes[0].kind.as_str(), takes[0].count), ("Widget", 1));
    }

    /// Any other object holds nothing beyond what it owns.
    #[test]
    fn an_ordinary_object_holds_nothing() {
        let (_, holds) = cascade_in(&widgets(), "w1", &NotRead::default(), |_| None, None);
        assert_eq!(holds, None);
    }

    /// Marco's index idled out and started again, and every kind his Role
    /// cannot list across the cluster was asked again: a 403 and a warning
    /// line each, about ninety at a time. Fails if a kind this connection was
    /// refused is asked across the cluster when a new index starts.
    #[tokio::test]
    async fn a_kind_refused_on_this_connection_is_not_asked_again_after_the_index_restarts() {
        use crate::client::served::test_server::{answering, failure};

        let (client, hits) = answering(|path, _| match path {
            "/api/v1/pods" => failure(403, "Forbidden"),
            _ => (404, "{}".to_string()),
        })
        .await;
        let refusals = Refusals::default();
        let whole = slot(None);
        let resource = ApiResource {
            group: String::new(),
            version: "v1".to_string(),
            api_version: "v1".to_string(),
            kind: "Pod".to_string(),
            plural: "pods".to_string(),
        };
        let asked = || {
            hits.lock()
                .unwrap()
                .get("/api/v1/pods")
                .copied()
                .unwrap_or(0)
        };

        let first = ClusterIndex::remembering(client.clone(), &[("Pod", kind())], refusals.clone());
        slots::spawn(&first, whole.clone(), resource.clone());
        for _ in 0..200 {
            if matches!(
                first.slots.lock().get(&whole),
                Some(SlotState::Refused { .. })
            ) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(matches!(
            first.slots.lock().get(&whole),
            Some(SlotState::Refused { .. })
        ));
        first.stop.cancel();
        let before = asked();

        let second = ClusterIndex::remembering(client, &[("Pod", kind())], refusals);
        slots::spawn(&second, whole.clone(), resource);
        tokio::time::sleep(Duration::from_millis(200)).await;

        assert!(matches!(
            second.slots.lock().get(&whole),
            Some(SlotState::Refused { .. })
        ));
        assert_eq!(asked(), before);
        second.stop.cancel();
    }

    fn pods_in(namespace: &str) -> (u16, String) {
        (
            200,
            serde_json::json!({
                "apiVersion": "meta.k8s.io/v1",
                "kind": "PartialObjectMetadataList",
                "metadata": { "resourceVersion": "5" },
                "items": [{
                    "apiVersion": "meta.k8s.io/v1",
                    "kind": "PartialObjectMetadata",
                    "metadata": {
                        "name": "api", "namespace": namespace,
                        "uid": format!("{namespace}-api"), "resourceVersion": "5",
                    },
                }],
            })
            .to_string(),
        )
    }

    /// A developer refused pods across the cluster flicked through their
    /// namespaces, and every one they ever picked kept a watch per refused
    /// kind until the index idled: hundreds of connections, never fewer.
    /// Fails if a namespace that left the scope is still read.
    #[tokio::test]
    async fn a_namespace_that_leaves_the_scope_is_no_longer_read() {
        use crate::client::served::test_server::{answering, failure};

        let (client, hits) = answering(|path, nth| match path {
            "/api/v1/pods" => failure(403, "Forbidden"),
            "/api/v1/namespaces/shop/pods" if nth == 1 => pods_in("shop"),
            "/api/v1/namespaces/web/pods" if nth == 1 => pods_in("web"),
            _ => (200, String::new()),
        })
        .await;
        let index = ClusterIndex::holding(client, &[("Pod", kind())]);
        let resource = ApiResource {
            group: String::new(),
            version: "v1".to_string(),
            api_version: "v1".to_string(),
            kind: "Pod".to_string(),
            plural: "pods".to_string(),
        };
        let web = || {
            hits.lock()
                .unwrap()
                .get("/api/v1/namespaces/web/pods")
                .copied()
                .unwrap_or(0)
        };
        let reading = || reading_of(&kind(), &index.slots.lock().clone());
        let both = Some(Reading::Partial {
            namespaces: vec!["shop".to_string(), "web".to_string()],
        });
        *index.scope.lock() = Some(vec!["shop".to_string(), "web".to_string()]);
        slots::spawn(&index, slot(None), resource);
        for _ in 0..300 {
            if reading() == both {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(reading(), both);

        index.rescope(Some(vec!["shop".to_string()]));
        tokio::time::sleep(Duration::from_millis(200)).await;
        let asked = web();
        tokio::time::sleep(Duration::from_millis(400)).await;

        assert_eq!(
            reading(),
            Some(Reading::Partial {
                namespaces: vec!["shop".to_string()]
            })
        );
        assert!(!index.slots.lock().contains_key(&slot(Some("web"))));
        assert!(index.graph.read().node("web-api").is_none());
        assert_eq!(web(), asked, "the web namespace is still being watched");
        index.stop.cancel();
    }

    fn definitions() -> KindKey {
        KindKey {
            group: DEFINITIONS.0.to_string(),
            plural: DEFINITIONS.1.to_string(),
        }
    }

    /// cert-manager installed while an Owns tab kept the index running: its
    /// kinds were in neither list, so Delete said in green that an Ingress
    /// takes nothing with it while its Certificate would go. Fails if a kind
    /// whose CRD the index holds, and which it does not watch, is not named.
    #[tokio::test]
    async fn a_kind_whose_crd_arrived_after_the_index_started_is_named_as_not_read() {
        use crate::client::served::test_server::answering;

        let (client, _) = answering(|_, _| (404, "{}".to_string())).await;
        let index = ClusterIndex::holding(client, &[("CustomResourceDefinition", definitions())]);
        index.go_live(&definitions(), &[("widgets.demo.example.com", None)]);

        let named: Vec<_> = index
            .not_read()
            .kinds
            .into_iter()
            .map(|kind| (kind.group, kind.plural, kind.reading))
            .collect();
        assert_eq!(
            named,
            [(
                WIDGETS.0.to_string(),
                WIDGETS.1.to_string(),
                Reading::Syncing
            )]
        );
    }

    fn crds_and_widgets(path: &str, served: bool) -> (u16, String) {
        use serde_json::json;
        let group = |name: &str| {
            json!({
                "name": name,
                "versions": [{ "groupVersion": format!("{name}/v1"), "version": "v1" }],
                "preferredVersion": { "groupVersion": format!("{name}/v1"), "version": "v1" },
            })
        };
        let kinds = |group: &str, plural: &str, kind: &str| {
            json!({
                "kind": "APIResourceList",
                "groupVersion": format!("{group}/v1"),
                "resources": [{
                    "name": plural, "singularName": "", "namespaced": false,
                    "kind": kind, "verbs": ["get", "list", "watch"],
                }],
            })
        };
        let listing = |name: &str, uid: &str| {
            json!({
                "apiVersion": "meta.k8s.io/v1",
                "kind": "PartialObjectMetadataList",
                "metadata": { "resourceVersion": "5" },
                "items": [{
                    "apiVersion": "meta.k8s.io/v1",
                    "kind": "PartialObjectMetadata",
                    "metadata": { "name": name, "uid": uid, "resourceVersion": "5" },
                }],
            })
        };
        let body = match path {
            "/apis" if served => {
                json!({ "kind": "APIGroupList", "groups": [group(DEFINITIONS.0), group(WIDGETS.0)] })
            }
            "/apis" => json!({ "kind": "APIGroupList", "groups": [group(DEFINITIONS.0)] }),
            "/apis/apiextensions.k8s.io/v1" => {
                kinds(DEFINITIONS.0, DEFINITIONS.1, "CustomResourceDefinition")
            }
            "/apis/demo.example.com/v1" if served => kinds(WIDGETS.0, WIDGETS.1, "Widget"),
            "/apis/apiextensions.k8s.io/v1/customresourcedefinitions" => {
                listing("widgets.demo.example.com", "crd")
            }
            "/apis/demo.example.com/v1/widgets" if served => listing("one", "w1"),
            _ => return (404, "{}".to_string()),
        };
        (200, body.to_string())
    }

    /// The same install, from the other end: the index went on watching the
    /// kinds it started with for as long as anything polled it. Fails if the
    /// next question does not start reading a kind the cluster now serves.
    #[tokio::test]
    async fn a_kind_served_after_the_index_started_is_read_from_the_next_question() {
        use crate::client::served::test_server::connected;
        use std::sync::atomic::{AtomicBool, Ordering};

        let served = Arc::new(AtomicBool::new(false));
        let now = served.clone();
        let (state, _) = connected(
            crate::client::served::ServedIndex::default(),
            move |path, nth| {
                // The first answer to a collection is its list; the watch after
                // it stays quiet.
                let collection = path.ends_with("definitions") || path.ends_with("widgets");
                if collection && nth > 1 {
                    return (200, String::new());
                }
                crds_and_widgets(path, now.load(Ordering::SeqCst))
            },
        )
        .await;
        let widgets = KindKey {
            group: WIDGETS.0.to_string(),
            plural: WIDGETS.1.to_string(),
        };
        let index = state.ownership.ensure(&state, None).await.expect("index");
        let named = |index: &ClusterIndex| {
            index
                .not_read()
                .kinds
                .into_iter()
                .any(|kind| kind.group == WIDGETS.0)
        };
        for _ in 0..300 {
            if named(&index) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(named(&index), "the CRD was never listed");

        served.store(true, Ordering::SeqCst);
        for _ in 0..300 {
            state.ownership.ensure(&state, None).await.expect("index");
            if index.names(&widgets, None).is_ok() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(
            index.names(&widgets, None),
            Ok(vec![("one".to_string(), None)])
        );
        assert!(!named(&index));
        state.ownership.forget_all();
    }

    /// The watches are counted across every cluster, and the index of one
    /// the window left kept its own for three more minutes while the cluster
    /// on screen was listed in turns. Fails if an index short of a watch does
    /// not take them from the ones left behind, on its start or on a later
    /// question, or takes them when it is short of none.
    #[tokio::test]
    async fn the_cluster_on_screen_takes_the_watches_of_one_the_window_left() {
        use crate::client::served::test_server::connected;

        let (state, _) = connected(
            crate::client::served::ServedIndex::default(),
            |path, nth| {
                if path.ends_with("definitions") && nth > 1 {
                    return (200, String::new());
                }
                crds_and_widgets(path, false)
            },
        )
        .await;
        let indexes = &state.ownership;
        let context = state.get_current_context().expect("connected");
        let client = (*state.client_manager.get_client(&context).expect("a client")).clone();
        let leave = |name: &str| {
            let left = ClusterIndex::holding(client.clone(), &[]);
            indexes.clusters.insert(name.to_string(), left.clone());
            left
        };
        let every = u32::try_from(indexes.watches.available_permits()).expect("a count");
        let held = indexes.watches.clone().try_acquire_many_owned(every);

        let first = leave("first");
        let index = indexes.ensure(&state, None).await.expect("index");
        assert!(first.stop.is_cancelled(), "short at its start");
        assert!(indexes.running("first").is_none());

        drop(held);
        let whole = SlotKey {
            kind: definitions(),
            namespace: None,
        };
        for _ in 0..300 {
            if index.slots.lock().get(&whole) == Some(&SlotState::Live) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let second = leave("second");
        indexes.ensure(&state, None).await.expect("index");
        assert!(!second.stop.is_cancelled(), "short of none");

        let at = chrono::Utc::now();
        index.slots.lock().insert(whole, SlotState::Listed { at });
        indexes.ensure(&state, None).await.expect("index");
        assert!(second.stop.is_cancelled(), "short on a later question");
        assert!(!index.stop.is_cancelled());
        assert!(indexes.running(&context).is_some());
        indexes.forget_all();
    }

    /// Marco's Delete dialog started the index and the log took ninety lines
    /// in 0.3 s: kube's 403 dump for every kind across the cluster, then for
    /// each namespace it fell back to. kube's dump is left out (`app_log`), and
    /// the index says a kind once. Fails if a namespace's refusal of a kind
    /// already told about warns again.
    #[test]
    fn a_refused_kind_warns_once_and_its_namespaces_do_not() {
        assert_eq!(slots::refusal_level(&slot(None)), tracing::Level::WARN);
        assert_eq!(
            slots::refusal_level(&slot(Some("shop"))),
            tracing::Level::DEBUG
        );
    }
}
