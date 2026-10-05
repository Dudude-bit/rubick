//! Who owns what, read the way the garbage collector reads it: a
//! metadata-only list and watch on every kind the cluster lets this user list
//! and watch, and each owner's dependents gathered from `ownerReferences`.
//! The API has no reverse lookup; this is one.
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
use tokio_util::sync::CancellationToken;

use crate::client::served::Served;
use crate::commands::catalog::UnreadGroup;
use crate::error::Result;
use crate::state::AppState;

pub use graph::{Dependent, KindCount, KindKey};
use graph::{Graph, SlotKey};

/// Watches nobody has asked anything of for this long are stopped.
const IDLE_AFTER: Duration = Duration::from_mins(3);
const REAP_EVERY: Duration = Duration::from_secs(30);

/// Kinds left out on purpose: events turn over by the thousand and nothing
/// owns them. Each is still named as not read.
const SKIPPED: [(&str, &str); 2] = [("", "events"), ("events.k8s.io", "events")];

/// How one watch is doing.
#[derive(Debug, Clone, PartialEq, Eq)]
enum SlotState {
    Syncing,
    Live,
    Stale { since: String },
    Refused { message: String },
    Failed { message: String },
}

/// How well one kind is read, for every kind that is not simply live.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "says", rename_all = "camelCase")]
pub enum Reading {
    /// Still listing.
    Syncing,
    /// The watch broke; what it holds is from then.
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
    /// Discovery offers no list or watch on it.
    Unlistable,
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
}

struct Watched {
    resource: ApiResource,
    namespaced: bool,
}

pub struct ClusterIndex {
    graph: RwLock<Graph>,
    slots: Mutex<BTreeMap<SlotKey, SlotState>>,
    watched: Mutex<BTreeMap<KindKey, Watched>>,
    /// Kinds never watched, and why.
    unwatched: Mutex<BTreeMap<KindKey, (String, Reading)>>,
    unread_groups: Mutex<Vec<UnreadGroup>>,
    /// The window's namespaces, where a refused kind is read instead.
    scope: Mutex<Option<Vec<String>>>,
    last_used: Mutex<Instant>,
    client: Client,
    stop: CancellationToken,
}

#[derive(Default)]
pub struct OwnershipIndexes {
    clusters: Arc<DashMap<String, Arc<ClusterIndex>>>,
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
            index.widen(scope);
            return Ok(index);
        }
        let client = crate::commands::helpers::ResourceContext::for_list(state, None)?.client;
        let catalog = crate::commands::catalog::catalog(state).await?;
        let index = Arc::new(ClusterIndex {
            graph: RwLock::new(Graph::default()),
            slots: Mutex::new(BTreeMap::new()),
            watched: Mutex::new(BTreeMap::new()),
            unwatched: Mutex::new(BTreeMap::new()),
            unread_groups: Mutex::new(catalog.unread),
            scope: Mutex::new(scope),
            last_used: Mutex::new(Instant::now()),
            client,
            stop: CancellationToken::new(),
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
            let reading = if SKIPPED.contains(&(entry.group.as_str(), entry.plural.as_str())) {
                Some(Reading::Skipped)
            } else if !(entry.verbs.iter().any(|v| v == "list")
                && entry.verbs.iter().any(|v| v == "watch"))
            {
                Some(Reading::Unlistable)
            } else {
                None
            };
            if let Some(reading) = reading {
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
        spawn_reaper(self.clusters.clone(), context, index.clone());
        Ok(index)
    }

    pub fn forget(&self, context: &str) {
        if let Some((_, index)) = self.clusters.remove(context) {
            index.stop.cancel();
        }
    }

    pub fn forget_all(&self) {
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
    /// The direct dependents of `uid`, and what was not read.
    #[must_use]
    pub fn dependents(&self, uid: &str) -> (Vec<Dependent>, NotRead) {
        (self.graph.read().dependents_of(uid), self.not_read())
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

    /// Every kind that is not live, named, plus every group discovery missed.
    #[must_use]
    pub fn not_read(&self) -> NotRead {
        let slots = self.slots.lock().clone();
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
        NotRead {
            kinds,
            groups: self.unread_groups.lock().clone(),
        }
    }

    /// Read every refused kind in the namespaces `scope` adds.
    fn widen(self: &Arc<Self>, scope: Option<Vec<String>>) {
        let Some(namespaces) = scope else {
            return;
        };
        *self.scope.lock() = Some(namespaces.clone());
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
    let cluster = slots.get(&SlotKey {
        kind: kind.clone(),
        namespace: None,
    })?;
    match cluster {
        SlotState::Live => None,
        SlotState::Syncing => Some(Reading::Syncing),
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
                .filter(|(_, state)| matches!(state, SlotState::Live | SlotState::Stale { .. }))
                .map(|(ns, _)| (*ns).clone())
                .collect();
            Some(if namespaces.is_empty() {
                Reading::Refused {
                    message: message.clone(),
                }
            } else {
                Reading::Partial {
                    namespaces: namespaces.into_iter().collect(),
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
        };
        let (_, holds) = cascade_in(&widgets(), "crd", &not_read, |_| None, None);
        assert_eq!(objects(holds).2, Some(refused));
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
}
