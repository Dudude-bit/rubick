//! One watch per cluster and kind, however many readers in the backend
//! follow it.
//!
//! A reader subscribes to kinds and is handed, per slot (a kind across the
//! cluster, or in one namespace where the cluster refused the kind across
//! it), the whole set when it joins, then each change in order, the whole
//! set again after every relist, and each change of the slot's state. The
//! first subscriber of a kind starts its watch; the last one leaving lets it
//! linger, then stops it. The watches draw on the budget the ownership index
//! holds, through the same slot loop.
//!
//! What is kept is what a late subscriber needs: the current version of each
//! object, once, shared by `Arc` with every reader, `managedFields` dropped.
//! A late subscriber's whole set is read from it under the lock every change
//! is fanned out under, so it sees each change once and needs no watch of
//! its own.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use dashmap::DashMap;
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, ReplicaSet, StatefulSet};
use k8s_openapi::api::autoscaling::v2::HorizontalPodAutoscaler;
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{
    ConfigMap, Event as CoreEvent, LimitRange, Namespace, Node, PersistentVolumeClaim, Pod, Secret,
    Service, ServiceAccount,
};
use k8s_openapi::api::networking::v1::{Ingress, NetworkPolicy};
use k8s_openapi::api::policy::v1::PodDisruptionBudget;
use k8s_openapi::api::rbac::v1::{ClusterRole, ClusterRoleBinding, Role, RoleBinding};
use kube::api::{Api, DynamicObject};
use kube::discovery::ApiResource;
use kube::runtime::watcher::{self, Event};
use kube::Client;
use parking_lot::Mutex;
use tokio::sync::{mpsc, Semaphore};
use tokio_util::sync::CancellationToken;

use crate::error::Result;
use crate::ownership::slots::{spawn_slot, SlotHost, PAGE_WITHIN};
use crate::ownership::{KindKey, SlotKey, SlotState};

/// How long a kind nobody follows keeps its watch: a page left and opened
/// again does not list the cluster twice.
const LINGER: Duration = Duration::from_mins(1);
/// How long a page-bound subscription lives without a `touch`.
const PAGE_IDLE: Duration = Duration::from_mins(3);
const REAP_EVERY: Duration = Duration::from_secs(5);
/// How long a kind with no watch free waits for its next list.
const RELIST_EVERY: Duration = Duration::from_secs(30);
/// Updates a subscriber may leave unread before it is resent the whole set.
const QUEUE: usize = 4096;

/// How one slot is being read, as a subscriber is told it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FeedState {
    Syncing,
    /// Waiting for a watch: the app holds as many open as it allows itself.
    Queued,
    Synced,
    /// The watch broke after its list answered; what was served is as of `since`.
    Blind {
        since: String,
    },
    Refused {
        message: String,
    },
    Failed {
        message: String,
    },
    /// Discovery serves no such kind on this cluster.
    Unserved,
}

impl FeedState {
    fn of(state: &SlotState) -> Self {
        match state {
            SlotState::Queued => Self::Queued,
            SlotState::Syncing => Self::Syncing,
            SlotState::Live | SlotState::Listed { .. } => Self::Synced,
            SlotState::Stale { since } => Self::Blind {
                since: since.clone(),
            },
            SlotState::Refused { message } => Self::Refused {
                message: message.clone(),
            },
            SlotState::Failed { message } => Self::Failed {
                message: message.clone(),
            },
        }
    }

    /// Whether a new client's read of the slot has said what it will say.
    fn settled(&self) -> bool {
        !matches!(self, Self::Syncing | Self::Queued)
    }
}

/// Why a subscriber is handed a slot's whole set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Whole {
    /// The first set of this slot it is handed.
    Fresh,
    /// After a break or a list turn: what it held and is not here was
    /// deleted while nobody watched.
    Relist,
    /// A new client (a renewal, a reconnect) took the slot over, with no gap.
    Handover,
}

#[derive(Debug, Clone)]
pub enum Update {
    Whole {
        slot: SlotKey,
        why: Whole,
        objects: Vec<Arc<DynamicObject>>,
    },
    /// An object added or changed. May repeat one a `Whole` already held.
    Applied {
        slot: SlotKey,
        object: Arc<DynamicObject>,
    },
    Deleted {
        slot: SlotKey,
        object: Arc<DynamicObject>,
    },
    State {
        slot: SlotKey,
        state: FeedState,
    },
    /// Every kind is now served by the context's newest client.
    HandedOver,
}

/// What keeps a subscription.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Binding {
    /// A page's: let go when not touched for `PAGE_IDLE`.
    Page,
    /// A session's: held until dropped or the cluster disconnects.
    Session,
}

#[derive(Debug, Clone)]
pub struct Ask {
    pub kinds: Vec<KindKey>,
    /// Where a kind refused across the cluster is read instead; `None` is
    /// the whole cluster. Objects outside it are not handed over.
    pub scope: Option<Vec<String>>,
    pub binding: Binding,
}

pub struct Subscription {
    pub updates: mpsc::Receiver<Update>,
    pub lease: Lease,
}

/// Held while the subscriber follows its kinds; dropping it lets them go.
pub struct Lease {
    context: Weak<ContextFeeds>,
    id: u64,
}

impl Lease {
    /// A page-bound subscriber says it is still on screen.
    pub fn touch(&self) {
        if let Some(context) = self.context.upgrade() {
            if let Some(sub) = context.inner.lock().subscribers.get_mut(&self.id) {
                sub.touched = Instant::now();
            }
        }
    }

    /// The window's namespaces changed: a kind refused across the cluster
    /// is read in the new ones.
    pub fn rescope(&self, scope: Option<Vec<String>>) {
        if let Some(context) = self.context.upgrade() {
            let kinds = {
                let mut inner = context.inner.lock();
                let Some(sub) = inner.subscribers.get_mut(&self.id) else {
                    return;
                };
                sub.scope = scope;
                sub.kinds.clone()
            };
            for kind in kinds {
                context.fall_back_all(&kind);
            }
        }
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        if let Some(context) = self.context.upgrade() {
            context.inner.lock().leave(self.id);
        }
    }
}

/// Fixed per kind, never per subscriber: one watch has one shape.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Params {
    pub fields: Option<&'static str>,
}

/// Helm keeps every release whole in a Secret of this type, megabytes each,
/// and its history is read elsewhere.
const NOT_HELM_RELEASES: &str = "type!=helm.sh/release.v1";

#[must_use]
pub fn params(kind: &KindKey) -> Params {
    match (kind.group.as_str(), kind.plural.as_str()) {
        ("", "secrets") => Params {
            fields: Some(NOT_HELM_RELEASES),
        },
        _ => Params::default(),
    }
}

/// The kinds the app knows without asking discovery, and their scope.
#[must_use]
pub fn built_in(kind: &KindKey) -> Option<(ApiResource, bool)> {
    let known = [
        (ApiResource::erase::<Deployment>(&()), true),
        (ApiResource::erase::<StatefulSet>(&()), true),
        (ApiResource::erase::<DaemonSet>(&()), true),
        (ApiResource::erase::<ReplicaSet>(&()), true),
        (ApiResource::erase::<Job>(&()), true),
        (ApiResource::erase::<CronJob>(&()), true),
        (ApiResource::erase::<Pod>(&()), true),
        (ApiResource::erase::<Service>(&()), true),
        (ApiResource::erase::<ServiceAccount>(&()), true),
        (ApiResource::erase::<ConfigMap>(&()), true),
        (ApiResource::erase::<Secret>(&()), true),
        (ApiResource::erase::<LimitRange>(&()), true),
        (ApiResource::erase::<PersistentVolumeClaim>(&()), true),
        (ApiResource::erase::<CoreEvent>(&()), true),
        (ApiResource::erase::<Ingress>(&()), true),
        (ApiResource::erase::<NetworkPolicy>(&()), true),
        (ApiResource::erase::<PodDisruptionBudget>(&()), true),
        (ApiResource::erase::<HorizontalPodAutoscaler>(&()), true),
        (ApiResource::erase::<Role>(&()), true),
        (ApiResource::erase::<RoleBinding>(&()), true),
        (ApiResource::erase::<ClusterRole>(&()), false),
        (ApiResource::erase::<ClusterRoleBinding>(&()), false),
        (ApiResource::erase::<Node>(&()), false),
        (ApiResource::erase::<Namespace>(&()), false),
    ];
    known
        .into_iter()
        .find(|(resource, _)| resource.group == kind.group && resource.plural == kind.plural)
}

#[must_use]
pub fn key_of(resource: &ApiResource) -> KindKey {
    KindKey {
        group: resource.group.clone(),
        plural: resource.plural.clone(),
    }
}

type Refusals = Arc<Mutex<BTreeMap<SlotKey, String>>>;

/// A slot as a subscriber joining now is told it: its state, and its set where listed.
type Known = (SlotKey, FeedState, Option<Vec<Arc<DynamicObject>>>);

/// What a take-over lets go of, done once the context's lock is released:
/// a generation's own locks are never taken under it.
enum Retire {
    Generation(Arc<Generation>),
    Kind(Arc<Generation>, KindKey),
}

/// Every context's feeds.
pub struct Feeds {
    contexts: Arc<DashMap<String, Arc<ContextFeeds>>>,
    watches: Arc<Semaphore>,
    turns: Arc<Semaphore>,
    linger: Duration,
    page_idle: Duration,
    queue: usize,
}

impl Feeds {
    /// `budget` is the ownership index's: watches and list turns, shared.
    #[must_use]
    pub fn new(budget: (Arc<Semaphore>, Arc<Semaphore>)) -> Self {
        Self {
            contexts: Arc::new(DashMap::new()),
            watches: budget.0,
            turns: budget.1,
            linger: LINGER,
            page_idle: PAGE_IDLE,
            queue: QUEUE,
        }
    }

    /// Follows `ask.kinds` of the cluster in hand. A kind discovery does not
    /// serve is said `Unserved` and nothing more.
    pub async fn subscribe(&self, here: &crate::state::Here<'_>, ask: Ask) -> Result<Subscription> {
        let mut kinds = Vec::new();
        let mut unserved = Vec::new();
        for kind in &ask.kinds {
            let resolved = match built_in(kind) {
                Some(found) => Some(found),
                None => here
                    .served(&kind.group, &kind.plural)
                    .await?
                    .map(|served| (served.resource, served.namespaced)),
            };
            match resolved {
                Some(found) => kinds.push((kind.clone(), found)),
                None => unserved.push(kind.clone()),
            }
        }
        let context = self.context_for(&here.context, (*here.client).clone());
        Ok(context.join(&ask, &kinds, &unserved))
    }

    fn context_for(&self, name: &str, client: Client) -> Arc<ContextFeeds> {
        if let Some(held) = self.contexts.get(name) {
            return held.clone();
        }
        let context = Arc::new(ContextFeeds {
            name: name.to_string(),
            inner: Mutex::new(Inner::default()),
            stop: CancellationToken::new(),
            watches: self.watches.clone(),
            turns: self.turns.clone(),
            refusals: Refusals::default(),
            linger: self.linger,
            page_idle: self.page_idle,
            queue: self.queue,
        });
        let context = self
            .contexts
            .entry(name.to_string())
            .or_insert(context)
            .clone();
        if context.inner.lock().generations.is_empty() {
            let generation = context.generation(client);
            let first = {
                let mut inner = context.inner.lock();
                let first = inner.generations.is_empty();
                if first {
                    inner.serving = generation.id;
                    inner.generations.insert(generation.id, generation);
                }
                first
            };
            if first {
                spawn_reaper(self.contexts.clone(), context.clone());
            }
        }
        context
    }

    /// A context's client was replaced or let go. With a new client every
    /// kind is read again on it, the old one serving until the new one has
    /// said what it will; with none every subscription ends.
    pub fn client_replaced(&self, context: &str, client: Option<Client>) {
        let Some(held) = self.contexts.get(context).map(|held| held.clone()) else {
            return;
        };
        match client {
            None => {
                self.contexts.remove(context);
                held.end();
            }
            Some(client) => held.hand_over(client),
        }
    }

    pub fn forget_all(&self) {
        for entry in self.contexts.iter() {
            entry.end();
        }
        self.contexts.clear();
    }

    #[cfg(test)]
    pub(crate) fn lingering(mut self, linger: Duration, page_idle: Duration, queue: usize) -> Self {
        self.linger = linger;
        self.page_idle = page_idle;
        self.queue = queue;
        self
    }

    #[cfg(test)]
    pub(crate) fn context(&self, name: &str) -> Option<Arc<ContextFeeds>> {
        self.contexts.get(name).map(|held| held.clone())
    }
}

struct Subscriber {
    kinds: BTreeSet<KindKey>,
    scope: Option<Vec<String>>,
    binding: Binding,
    touched: Instant,
    tx: mpsc::Sender<Update>,
    /// Slots it has been handed a whole set of.
    seen: BTreeSet<SlotKey>,
    /// Its queue filled: it is resent every whole set once there is room.
    lagged: bool,
}

struct KindFeed {
    resource: ApiResource,
    namespaced: bool,
    /// The generation whose reads subscribers are handed.
    serving: u64,
    released_at: Option<Instant>,
}

#[derive(Default)]
struct SlotStore {
    objects: HashMap<String, Arc<DynamicObject>>,
    /// What a list under way has handed so far.
    listing: Option<HashMap<String, Arc<DynamicObject>>>,
    synced: bool,
}

#[derive(Default)]
struct Inner {
    generations: BTreeMap<u64, Arc<Generation>>,
    serving: u64,
    next_generation: u64,
    kinds: BTreeMap<KindKey, KindFeed>,
    subscribers: BTreeMap<u64, Subscriber>,
    next_subscriber: u64,
    states: BTreeMap<(u64, SlotKey), FeedState>,
    stores: BTreeMap<(u64, SlotKey), SlotStore>,
}

fn uid_of(object: &DynamicObject) -> Option<String> {
    object.metadata.uid.clone()
}

fn kept(mut object: DynamicObject) -> Arc<DynamicObject> {
    object.metadata.managed_fields = None;
    Arc::new(object)
}

fn in_scope(scope: Option<&[String]>, object: &DynamicObject) -> bool {
    match (scope, object.metadata.namespace.as_deref()) {
        (Some(names), Some(namespace)) => names.iter().any(|name| name == namespace),
        _ => true,
    }
}

impl Inner {
    fn leave(&mut self, id: u64) {
        let Some(sub) = self.subscribers.remove(&id) else {
            return;
        };
        let now = Instant::now();
        for kind in sub.kinds {
            let followed = self.subscribers.values().any(|s| s.kinds.contains(&kind));
            if let (false, Some(feed)) = (followed, self.kinds.get_mut(&kind)) {
                feed.released_at = Some(now);
            }
        }
    }

    /// Hands `update` to every subscriber of `slot`'s kind whose scope holds it.
    fn fan_out(&mut self, slot: &SlotKey, update: &Update) {
        let ids: Vec<u64> = self
            .subscribers
            .iter()
            .filter(|(_, sub)| sub.kinds.contains(&slot.kind))
            .map(|(id, _)| *id)
            .collect();
        for id in ids {
            let scoped = {
                let sub = &self.subscribers[&id];
                match update {
                    Update::Whole { slot, why, objects } => {
                        let mut why = *why;
                        if !sub.seen.contains(slot) {
                            why = Whole::Fresh;
                        }
                        Update::Whole {
                            slot: slot.clone(),
                            why,
                            objects: objects
                                .iter()
                                .filter(|o| in_scope(sub.scope.as_deref(), o))
                                .cloned()
                                .collect(),
                        }
                    }
                    Update::Applied { object, .. } | Update::Deleted { object, .. }
                        if !in_scope(sub.scope.as_deref(), object) =>
                    {
                        continue;
                    }
                    other => other.clone(),
                }
            };
            self.send(id, scoped);
        }
    }

    fn send(&mut self, id: u64, update: Update) {
        let resync = self.subscribers.get(&id).is_some_and(|sub| sub.lagged);
        if resync {
            self.resync(id);
            return;
        }
        let Some(sub) = self.subscribers.get_mut(&id) else {
            return;
        };
        if let Update::Whole { slot, .. } = &update {
            sub.seen.insert(slot.clone());
        }
        match sub.tx.try_send(update) {
            Ok(()) => {}
            Err(mpsc::error::TrySendError::Full(_)) => sub.lagged = true,
            Err(mpsc::error::TrySendError::Closed(_)) => {
                self.leave(id);
            }
        }
    }

    /// A subscriber that fell behind is handed every slot it follows whole,
    /// and is caught up when all of them fit.
    fn resync(&mut self, id: u64) {
        let Some(sub) = self.subscribers.get(&id) else {
            return;
        };
        let wholes: Vec<Update> = self
            .stores
            .iter()
            .filter(|((generation, slot), store)| {
                store.synced
                    && sub.kinds.contains(&slot.kind)
                    && self
                        .kinds
                        .get(&slot.kind)
                        .is_some_and(|f| f.serving == *generation)
            })
            .map(|((_, slot), store)| Update::Whole {
                slot: slot.clone(),
                why: Whole::Relist,
                objects: store
                    .objects
                    .values()
                    .filter(|o| in_scope(sub.scope.as_deref(), o))
                    .cloned()
                    .collect(),
            })
            .collect();
        let Some(sub) = self.subscribers.get_mut(&id) else {
            return;
        };
        if sub.tx.capacity() < wholes.len() + 1 {
            return;
        }
        for whole in wholes {
            if let Update::Whole { slot, .. } = &whole {
                sub.seen.insert(slot.clone());
            }
            let _ = sub.tx.try_send(whole);
        }
        sub.lagged = false;
    }

    /// The generation `generation` has settled every slot of `kind` it
    /// reads: it serves the kind from now, and the one before lets it go.
    fn take_over(&mut self, generation: u64, kind: &KindKey) -> Vec<Retire> {
        let Some(feed) = self.kinds.get(kind) else {
            return Vec::new();
        };
        if feed.serving >= generation {
            return Vec::new();
        }
        let settled = self
            .states
            .iter()
            .filter(|((g, slot), _)| *g == generation && slot.kind == *kind)
            .all(|(_, state)| state.settled());
        if !settled {
            return Vec::new();
        }
        let old = feed.serving;
        if let Some(feed) = self.kinds.get_mut(kind) {
            feed.serving = generation;
        }
        let slots: Vec<SlotKey> = self
            .states
            .keys()
            .filter(|(g, slot)| *g == generation && slot.kind == *kind)
            .map(|(_, slot)| slot.clone())
            .collect();
        for slot in slots {
            let state = self.states[&(generation, slot.clone())].clone();
            self.fan_out(
                &slot,
                &Update::State {
                    slot: slot.clone(),
                    state,
                },
            );
            let objects = self
                .stores
                .get(&(generation, slot.clone()))
                .filter(|store| store.synced)
                .map(|store| store.objects.values().cloned().collect::<Vec<_>>());
            if let Some(objects) = objects {
                self.fan_out(
                    &slot,
                    &Update::Whole {
                        slot: slot.clone(),
                        why: Whole::Handover,
                        objects,
                    },
                );
            }
        }
        self.stores
            .retain(|(g, slot), _| !(*g == old && slot.kind == *kind));
        self.states
            .retain(|(g, slot), _| !(*g == old && slot.kind == *kind));
        let still_serves = self.kinds.values().any(|feed| feed.serving == old);
        if let (false, Some(gone)) = (still_serves, self.generations.remove(&old)) {
            if self.generations.len() == 1 {
                self.serving = generation;
                let ids: Vec<u64> = self.subscribers.keys().copied().collect();
                for id in ids {
                    self.send(id, Update::HandedOver);
                }
            }
            vec![Retire::Generation(gone)]
        } else {
            self.generations
                .get(&old)
                .map(|old| Retire::Kind(old.clone(), kind.clone()))
                .into_iter()
                .collect()
        }
    }

    fn serves(&self, generation: u64, kind: &KindKey) -> bool {
        self.kinds
            .get(kind)
            .is_some_and(|feed| feed.serving == generation)
    }

    /// Records a slot's state; tells subscribers where the generation serves it.
    fn state(&mut self, generation: u64, slot: &SlotKey, state: FeedState) {
        let key = (generation, slot.clone());
        if self.states.get(&key) == Some(&state) {
            return;
        }
        self.states.insert(key, state.clone());
        if self.serves(generation, &slot.kind) {
            self.fan_out(
                slot,
                &Update::State {
                    slot: slot.clone(),
                    state,
                },
            );
        }
    }
}

pub(crate) struct ContextFeeds {
    name: String,
    inner: Mutex<Inner>,
    stop: CancellationToken,
    watches: Arc<Semaphore>,
    turns: Arc<Semaphore>,
    refusals: Refusals,
    linger: Duration,
    page_idle: Duration,
    queue: usize,
}

impl ContextFeeds {
    fn generation(self: &Arc<Self>, client: Client) -> Arc<Generation> {
        let id = {
            let mut inner = self.inner.lock();
            inner.next_generation += 1;
            inner.next_generation
        };
        Arc::new(Generation {
            id,
            client,
            stop: self.stop.child_token(),
            slots: Mutex::new(BTreeMap::new()),
            stops: Mutex::new(BTreeMap::new()),
            feeds: Arc::downgrade(self),
            watches: self.watches.clone(),
            turns: self.turns.clone(),
            refusals: self.refusals.clone(),
        })
    }

    fn join(
        self: &Arc<Self>,
        ask: &Ask,
        kinds: &[(KindKey, (ApiResource, bool))],
        unserved: &[KindKey],
    ) -> Subscription {
        let (tx, updates) = mpsc::channel(self.queue);
        let mut start: Vec<(Arc<Generation>, KindKey, ApiResource)> = Vec::new();
        let id = {
            let mut inner = self.inner.lock();
            inner.next_subscriber += 1;
            let id = inner.next_subscriber;
            inner.subscribers.insert(
                id,
                Subscriber {
                    kinds: kinds.iter().map(|(kind, _)| kind.clone()).collect(),
                    scope: ask.scope.clone(),
                    binding: ask.binding,
                    touched: Instant::now(),
                    tx,
                    seen: BTreeSet::new(),
                    lagged: false,
                },
            );
            let serving = inner.serving;
            for (kind, (resource, namespaced)) in kinds {
                if let Some(feed) = inner.kinds.get_mut(kind) {
                    feed.released_at = None;
                    continue;
                }
                inner.kinds.insert(
                    kind.clone(),
                    KindFeed {
                        resource: resource.clone(),
                        namespaced: *namespaced,
                        serving,
                        released_at: None,
                    },
                );
                for generation in inner.generations.values() {
                    start.push((generation.clone(), kind.clone(), resource.clone()));
                }
            }
            // What is already known, as a subscriber joining then would see it.
            let known: Vec<Known> = inner
                .states
                .iter()
                .filter(|((generation, slot), _)| {
                    inner.subscribers[&id].kinds.contains(&slot.kind)
                        && inner.serves(*generation, &slot.kind)
                })
                .map(|((generation, slot), state)| {
                    let objects = inner
                        .stores
                        .get(&(*generation, slot.clone()))
                        .filter(|store| store.synced)
                        .map(|store| store.objects.values().cloned().collect());
                    (slot.clone(), state.clone(), objects)
                })
                .collect();
            for (slot, state, objects) in known {
                inner.send(
                    id,
                    Update::State {
                        slot: slot.clone(),
                        state,
                    },
                );
                if let Some(objects) = objects {
                    let scope = ask.scope.clone();
                    let objects = objects
                        .into_iter()
                        .filter(|o| in_scope(scope.as_deref(), o))
                        .collect();
                    inner.send(
                        id,
                        Update::Whole {
                            slot,
                            why: Whole::Fresh,
                            objects,
                        },
                    );
                }
            }
            for kind in unserved {
                inner.send(
                    id,
                    Update::State {
                        slot: SlotKey {
                            kind: kind.clone(),
                            namespace: None,
                        },
                        state: FeedState::Unserved,
                    },
                );
            }
            id
        };
        for (generation, kind, resource) in start {
            generation.start(&kind, resource);
        }
        for (kind, _) in kinds {
            self.fall_back_all(kind);
        }
        Subscription {
            updates,
            lease: Lease {
                context: Arc::downgrade(self),
                id,
            },
        }
    }

    /// Reads a kind refused across the cluster in every namespace a
    /// subscriber's scope names, in each generation that refused it.
    fn fall_back_all(&self, kind: &KindKey) {
        let (generations, namespaces, resource) = {
            let inner = self.inner.lock();
            let Some(feed) = inner.kinds.get(kind).filter(|feed| feed.namespaced) else {
                return;
            };
            let namespaces: BTreeSet<String> = inner
                .subscribers
                .values()
                .filter(|sub| sub.kinds.contains(kind))
                .filter_map(|sub| sub.scope.clone())
                .flatten()
                .collect();
            (
                inner.generations.values().cloned().collect::<Vec<_>>(),
                namespaces,
                feed.resource.clone(),
            )
        };
        for generation in generations {
            let whole = SlotKey {
                kind: kind.clone(),
                namespace: None,
            };
            let refused = matches!(
                generation.slots.lock().get(&whole),
                Some(SlotState::Refused { .. })
            );
            if !refused {
                continue;
            }
            for namespace in &namespaces {
                let slot = SlotKey {
                    kind: kind.clone(),
                    namespace: Some(namespace.clone()),
                };
                if generation.stops.lock().contains_key(&slot)
                    || generation.slots.lock().contains_key(&slot)
                {
                    continue;
                }
                spawn_slot(
                    &generation,
                    slot,
                    resource.clone(),
                    RELIST_EVERY,
                    PAGE_WITHIN,
                );
            }
        }
    }

    /// Starts every followed kind again on `client`; the generation serving
    /// now goes on serving each kind until the new one has settled it.
    fn hand_over(self: &Arc<Self>, client: Client) {
        self.refusals.lock().clear();
        let generation = self.generation(client);
        let kinds: Vec<(KindKey, ApiResource)> = {
            let mut inner = self.inner.lock();
            inner.generations.insert(generation.id, generation.clone());
            inner
                .kinds
                .iter()
                .map(|(kind, feed)| (kind.clone(), feed.resource.clone()))
                .collect()
        };
        for (kind, resource) in kinds {
            generation.start(&kind, resource);
            self.fall_back_all(&kind);
        }
    }

    /// Every subscription of the context ends: its senders are dropped.
    fn end(&self) {
        self.stop.cancel();
        let mut inner = self.inner.lock();
        inner.subscribers.clear();
        inner.kinds.clear();
        inner.stores.clear();
        inner.states.clear();
        inner.generations.clear();
    }

    /// Lets go of page subscriptions nobody touched, and of kinds nobody
    /// has followed for the linger. `true` once nothing is left.
    fn reap(&self, now: Instant) -> bool {
        let mut stopping: Vec<(Arc<Generation>, KindKey)> = Vec::new();
        let empty = {
            let mut inner = self.inner.lock();
            let idle: Vec<u64> = inner
                .subscribers
                .iter()
                .filter(|(_, sub)| {
                    sub.binding == Binding::Page && now.duration_since(sub.touched) > self.page_idle
                })
                .map(|(id, _)| *id)
                .collect();
            for id in idle {
                inner.leave(id);
            }
            let done: Vec<KindKey> = inner
                .kinds
                .iter()
                .filter(|(_, feed)| {
                    feed.released_at
                        .is_some_and(|at| now.duration_since(at) >= self.linger)
                })
                .map(|(kind, _)| kind.clone())
                .collect();
            for kind in done {
                inner.kinds.remove(&kind);
                inner.stores.retain(|(_, slot), _| slot.kind != kind);
                inner.states.retain(|(_, slot), _| slot.kind != kind);
                for generation in inner.generations.values() {
                    stopping.push((generation.clone(), kind.clone()));
                }
            }
            inner.kinds.is_empty() && inner.subscribers.is_empty()
        };
        for (generation, kind) in stopping {
            generation.stop_kind(&kind);
        }
        empty
    }

    #[cfg(test)]
    pub(crate) fn serving(&self) -> Arc<Generation> {
        let inner = self.inner.lock();
        inner.generations[&inner.serving].clone()
    }

    #[cfg(test)]
    pub(crate) fn newest(&self) -> Arc<Generation> {
        let inner = self.inner.lock();
        inner
            .generations
            .values()
            .next_back()
            .expect("a generation")
            .clone()
    }
}

fn spawn_reaper(contexts: Arc<DashMap<String, Arc<ContextFeeds>>>, context: Arc<ContextFeeds>) {
    tokio::spawn(async move {
        loop {
            tokio::select! {
                biased;
                () = context.stop.cancelled() => break,
                () = tokio::time::sleep(REAP_EVERY) => {}
            }
            if context.reap(Instant::now()) {
                contexts.remove_if(&context.name, |_, held| Arc::ptr_eq(held, &context));
                context.stop.cancel();
                break;
            }
        }
    });
}

/// Every watch one client holds for a context: the slot loop's host.
pub(crate) struct Generation {
    id: u64,
    client: Client,
    stop: CancellationToken,
    slots: Mutex<BTreeMap<SlotKey, SlotState>>,
    stops: Mutex<BTreeMap<SlotKey, CancellationToken>>,
    feeds: Weak<ContextFeeds>,
    watches: Arc<Semaphore>,
    turns: Arc<Semaphore>,
    refusals: Refusals,
}

impl Generation {
    fn start(self: &Arc<Self>, kind: &KindKey, resource: ApiResource) {
        let slot = SlotKey {
            kind: kind.clone(),
            namespace: None,
        };
        spawn_slot(self, slot, resource, RELIST_EVERY, PAGE_WITHIN);
    }

    fn stop_kind(&self, kind: &KindKey) {
        let mut slots = self.slots.lock();
        let mut stops = self.stops.lock();
        slots.retain(|slot, _| {
            if slot.kind != *kind {
                return true;
            }
            if let Some(stop) = stops.remove(slot) {
                stop.cancel();
            }
            false
        });
    }

    /// Hands the context what changed, under its lock; the slots' lock is
    /// held by the caller, which is the order every path takes them in.
    fn tell(&self, change: impl FnOnce(&mut Inner) -> Vec<Retire>) {
        let Some(feeds) = self.feeds.upgrade() else {
            return;
        };
        let retired = {
            let mut inner = feeds.inner.lock();
            // A retired generation's last words are nobody's.
            if !inner.generations.contains_key(&self.id) {
                return;
            }
            change(&mut inner)
        };
        for retire in retired {
            match retire {
                Retire::Generation(generation) => generation.stop.cancel(),
                Retire::Kind(generation, kind) => generation.stop_kind(&kind),
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn holds(&self, slot: &SlotKey) -> bool {
        self.slots.lock().contains_key(slot)
    }

    #[cfg(test)]
    pub(crate) fn id(&self) -> u64 {
        self.id
    }
}

impl SlotHost for Generation {
    type Object = DynamicObject;

    fn api(&self, slot: &SlotKey, resource: &ApiResource) -> Api<DynamicObject> {
        match &slot.namespace {
            Some(namespace) => Api::namespaced_with(self.client.clone(), namespace, resource),
            None => Api::all_with(self.client.clone(), resource),
        }
    }

    fn narrowed(&self, slot: &SlotKey, config: watcher::Config) -> watcher::Config {
        match params(&slot.kind).fields {
            Some(fields) => config.fields(fields),
            None => config,
        }
    }

    fn stop(&self) -> &CancellationToken {
        &self.stop
    }

    fn watches(&self) -> &Arc<Semaphore> {
        &self.watches
    }

    fn turns(&self) -> &Arc<Semaphore> {
        &self.turns
    }

    fn slots(&self) -> &Mutex<BTreeMap<SlotKey, SlotState>> {
        &self.slots
    }

    fn stops(&self) -> &Mutex<BTreeMap<SlotKey, CancellationToken>> {
        &self.stops
    }

    fn known_refusal(&self, slot: &SlotKey) -> Option<String> {
        self.refusals.lock().get(slot).cloned()
    }

    fn told_refused(&self, slot: &SlotKey) {
        let (group, plural) = (&slot.kind.group, &slot.kind.plural);
        let namespace = slot.namespace.as_deref().unwrap_or_default();
        tracing::debug!(group, plural, namespace, "feeds: refused");
    }

    fn saw(
        &self,
        slot: &SlotKey,
        _resource: &ApiResource,
        event: Event<DynamicObject>,
        stop: &CancellationToken,
    ) {
        let mut slots = self.slots.lock();
        if stop.is_cancelled() {
            return;
        }
        let id = self.id;
        match event {
            Event::Init => {
                if !matches!(
                    slots.get(slot),
                    Some(SlotState::Stale { .. } | SlotState::Listed { .. })
                ) {
                    slots.insert(slot.clone(), SlotState::Syncing);
                }
                let state = FeedState::of(&slots[slot]);
                self.tell(|inner| {
                    inner.stores.entry((id, slot.clone())).or_default().listing =
                        Some(HashMap::new());
                    inner.state(id, slot, state);
                    Vec::new()
                });
            }
            Event::InitApply(object) => {
                self.tell(|inner| {
                    let store = inner.stores.entry((id, slot.clone())).or_default();
                    if let (Some(uid), Some(listing)) = (uid_of(&object), store.listing.as_mut()) {
                        listing.insert(uid, kept(object));
                    }
                    Vec::new()
                });
            }
            Event::InitDone => {
                slots.insert(slot.clone(), SlotState::Live);
                self.tell(|inner| {
                    let store = inner.stores.entry((id, slot.clone())).or_default();
                    let listed = store.listing.take().unwrap_or_default();
                    let again = store.synced;
                    store.objects = listed;
                    store.synced = true;
                    let objects: Vec<Arc<DynamicObject>> =
                        store.objects.values().cloned().collect();
                    inner.state(id, slot, FeedState::Synced);
                    if inner.serves(id, &slot.kind) {
                        inner.fan_out(
                            slot,
                            &Update::Whole {
                                slot: slot.clone(),
                                why: if again { Whole::Relist } else { Whole::Fresh },
                                objects,
                            },
                        );
                        Vec::new()
                    } else {
                        inner.take_over(id, &slot.kind)
                    }
                });
            }
            Event::Apply(object) => {
                self.tell(|inner| {
                    let Some(uid) = uid_of(&object) else {
                        return Vec::new();
                    };
                    let object = kept(object);
                    inner
                        .stores
                        .entry((id, slot.clone()))
                        .or_default()
                        .objects
                        .insert(uid, object.clone());
                    if inner.serves(id, &slot.kind) {
                        inner.fan_out(
                            slot,
                            &Update::Applied {
                                slot: slot.clone(),
                                object,
                            },
                        );
                    }
                    Vec::new()
                });
            }
            Event::Delete(object) => {
                self.tell(|inner| {
                    let Some(uid) = uid_of(&object) else {
                        return Vec::new();
                    };
                    let held = inner
                        .stores
                        .entry((id, slot.clone()))
                        .or_default()
                        .objects
                        .remove(&uid);
                    if inner.serves(id, &slot.kind) {
                        inner.fan_out(
                            slot,
                            &Update::Deleted {
                                slot: slot.clone(),
                                object: held.unwrap_or_else(|| kept(object)),
                            },
                        );
                    }
                    Vec::new()
                });
            }
        }
    }

    fn listed(&self, slot: &SlotKey, stop: &CancellationToken) {
        let mut slots = self.slots.lock();
        if stop.is_cancelled() {
            return;
        }
        slots.insert(
            slot.clone(),
            SlotState::Listed {
                at: chrono::Utc::now(),
            },
        );
    }

    fn failed(&self, slot: &SlotKey, message: String, stop: &CancellationToken) {
        let mut slots = self.slots.lock();
        if stop.is_cancelled() {
            return;
        }
        let next = match slots.get(slot) {
            Some(SlotState::Live) => SlotState::Stale {
                since: chrono::Utc::now().to_rfc3339(),
            },
            Some(SlotState::Listed { at }) => SlotState::Stale {
                since: at.to_rfc3339(),
            },
            Some(stale @ SlotState::Stale { .. }) => stale.clone(),
            _ => SlotState::Failed { message },
        };
        let state = FeedState::of(&next);
        slots.insert(slot.clone(), next);
        let id = self.id;
        self.tell(|inner| {
            inner.state(id, slot, state);
            inner.take_over(id, &slot.kind)
        });
    }

    fn refused(
        self: &Arc<Self>,
        slot: &SlotKey,
        message: String,
        stop: Option<&CancellationToken>,
    ) {
        self.refusals.lock().insert(slot.clone(), message.clone());
        {
            let mut slots = self.slots.lock();
            if stop.is_some_and(CancellationToken::is_cancelled) {
                return;
            }
            self.stops.lock().remove(slot);
            slots.insert(
                slot.clone(),
                SlotState::Refused {
                    message: message.clone(),
                },
            );
            let id = self.id;
            self.tell(|inner| {
                inner.stores.remove(&(id, slot.clone()));
                inner.state(id, slot, FeedState::Refused { message });
                inner.take_over(id, &slot.kind)
            });
        }
        if slot.namespace.is_none() {
            if let Some(feeds) = self.feeds.upgrade() {
                feeds.fall_back_all(&slot.kind);
            }
        }
    }

    fn retire(&self, kind: &KindKey) {
        self.stop_kind(kind);
        let id = self.id;
        let slot = SlotKey {
            kind: kind.clone(),
            namespace: None,
        };
        self.tell(|inner| {
            inner
                .stores
                .retain(|(g, s), _| !(*g == id && s.kind == *kind));
            inner.state(id, &slot, FeedState::Unserved);
            inner.take_over(id, kind)
        });
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::client::served::test_server::{answering, failure};

    /// Feeds whose watches never get a permit: every slot waits, and the
    /// test hands its events in by hand.
    fn feeds() -> Feeds {
        Feeds::new((Arc::new(Semaphore::new(0)), Arc::new(Semaphore::new(0))))
    }

    async fn client() -> Client {
        answering(|_, _| failure(500, "InternalError")).await.0
    }

    fn deployments() -> (KindKey, (ApiResource, bool)) {
        let resource = ApiResource::erase::<Deployment>(&());
        (key_of(&resource), (resource, true))
    }

    fn whole(kind: &KindKey) -> SlotKey {
        SlotKey {
            kind: kind.clone(),
            namespace: None,
        }
    }

    fn deployment(namespace: &str, name: &str, version: &str) -> DynamicObject {
        serde_json::from_value(json!({
            "apiVersion": "apps/v1", "kind": "Deployment",
            "metadata": { "name": name, "namespace": namespace, "uid": format!("{namespace}/{name}"),
                "resourceVersion": version, "managedFields": [{ "manager": "kubectl" }] }
        }))
        .unwrap()
    }

    fn ask(scope: Option<Vec<&str>>, binding: Binding) -> Ask {
        Ask {
            kinds: vec![deployments().0],
            scope: scope.map(|names| names.into_iter().map(str::to_string).collect()),
            binding,
        }
    }

    fn drain(sub: &mut Subscription) -> Vec<Update> {
        let mut seen = Vec::new();
        while let Ok(update) = sub.updates.try_recv() {
            seen.push(update);
        }
        seen
    }

    fn names(objects: &[Arc<DynamicObject>]) -> Vec<String> {
        let mut names: Vec<String> = objects
            .iter()
            .map(|o| o.metadata.name.clone().unwrap_or_default())
            .collect();
        names.sort();
        names
    }

    /// Lists `objects` on `generation`'s slot, as a watch's first list would.
    fn list(generation: &Generation, slot: &SlotKey, objects: Vec<DynamicObject>) {
        let resource = deployments().1 .0;
        let stop = CancellationToken::new();
        generation.saw(slot, &resource, Event::Init, &stop);
        for object in objects {
            generation.saw(slot, &resource, Event::InitApply(object), &stop);
        }
        generation.saw(slot, &resource, Event::InitDone, &stop);
    }

    fn apply(generation: &Generation, slot: &SlotKey, object: DynamicObject) {
        let resource = deployments().1 .0;
        generation.saw(
            slot,
            &resource,
            Event::Apply(object),
            &CancellationToken::new(),
        );
    }

    /// Three features following Deployments is one watch of them. Fails if
    /// a second subscriber starts a second slot.
    #[tokio::test]
    async fn two_subscribers_of_a_kind_share_one_watch() {
        let feeds = feeds();
        let client = client().await;
        let context = feeds.context_for("prod", client.clone());
        let again = feeds.context_for("prod", client);
        assert!(Arc::ptr_eq(&context, &again));
        let _first = context.join(&ask(None, Binding::Page), &[deployments()], &[]);
        let _second = again.join(&ask(None, Binding::Session), &[deployments()], &[]);
        let generation = context.serving();
        assert_eq!(generation.stops.lock().len(), 1);
        assert!(generation.holds(&whole(&deployments().0)));
        context.end();
    }

    /// A subscriber arriving after the list is handed what is there from
    /// the store, with no watch of its own, and then each change once, as
    /// the first one is. Fails if it misses the set, or a change reaches
    /// either of them twice or not at all.
    #[tokio::test]
    async fn a_late_subscriber_is_handed_what_is_there_then_each_change_once() {
        let feeds = feeds();
        let context = feeds.context_for("prod", client().await);
        let mut first = context.join(&ask(None, Binding::Page), &[deployments()], &[]);
        let generation = context.serving();
        let slot = whole(&deployments().0);
        list(
            &generation,
            &slot,
            vec![
                deployment("shop", "web", "1"),
                deployment("shop", "api", "1"),
            ],
        );
        let mut late = context.join(&ask(None, Binding::Page), &[deployments()], &[]);
        let joined = drain(&mut late);
        assert!(joined.iter().any(|u| matches!(
            u,
            Update::State {
                state: FeedState::Synced,
                ..
            }
        )));
        let set = joined.iter().find_map(|u| match u {
            Update::Whole {
                why: Whole::Fresh,
                objects,
                ..
            } => Some(names(objects)),
            _ => None,
        });
        assert_eq!(set, Some(vec!["api".to_string(), "web".to_string()]));
        assert!(
            generation.stops.lock().len() == 1,
            "the late one opened a watch"
        );
        drain(&mut first);

        apply(&generation, &slot, deployment("shop", "cart", "1"));
        for sub in [&mut first, &mut late] {
            let changes = drain(sub);
            assert_eq!(changes.len(), 1);
            let Update::Applied { object, .. } = &changes[0] else {
                panic!("{changes:?}");
            };
            assert_eq!(object.metadata.name.as_deref(), Some("cart"));
            assert!(object.metadata.managed_fields.is_none());
        }
        context.end();
    }

    /// After a break the whole set comes again, marked as a relist, so what
    /// went missing while nobody watched can be told. Fails if the relist
    /// is handed as changes, or as a first set.
    #[tokio::test]
    async fn a_relist_after_a_break_hands_the_whole_set_again() {
        let feeds = feeds();
        let context = feeds.context_for("prod", client().await);
        let mut sub = context.join(&ask(None, Binding::Session), &[deployments()], &[]);
        let generation = context.serving();
        let slot = whole(&deployments().0);
        list(
            &generation,
            &slot,
            vec![
                deployment("shop", "web", "1"),
                deployment("shop", "api", "1"),
            ],
        );
        drain(&mut sub);
        generation.failed(
            &slot,
            "connection reset".to_string(),
            &CancellationToken::new(),
        );
        let broke = drain(&mut sub);
        assert!(matches!(
            broke.as_slice(),
            [Update::State {
                state: FeedState::Blind { .. },
                ..
            }]
        ));
        list(&generation, &slot, vec![deployment("shop", "web", "2")]);
        let relisted = drain(&mut sub);
        let set = relisted.iter().find_map(|u| match u {
            Update::Whole { why, objects, .. } => Some((*why, names(objects))),
            _ => None,
        });
        assert_eq!(set, Some((Whole::Relist, vec!["web".to_string()])));
        context.end();
    }

    /// Refused across the cluster, the kind is read in each namespace a
    /// subscriber's scope names, and the refusal is told with the cluster's
    /// words. Fails if a namespace-bound reader is left with nothing.
    #[tokio::test]
    async fn a_kind_refused_across_the_cluster_is_read_in_each_namespace_asked_for() {
        let feeds = feeds();
        let context = feeds.context_for("prod", client().await);
        let mut sub = context.join(
            &ask(Some(vec!["shop", "billing"]), Binding::Page),
            &[deployments()],
            &[],
        );
        let generation = context.serving();
        let kind = deployments().0;
        SlotHost::refused(
            &generation,
            &whole(&kind),
            "deployments is forbidden".to_string(),
            None,
        );
        for namespace in ["shop", "billing"] {
            assert!(generation.holds(&SlotKey {
                kind: kind.clone(),
                namespace: Some(namespace.to_string()),
            }));
        }
        assert!(drain(&mut sub).iter().any(|u| matches!(
            u,
            Update::State { state: FeedState::Refused { message }, .. } if message == "deployments is forbidden"
        )));
        let _other = context.join(
            &ask(Some(vec!["ops"]), Binding::Page),
            &[deployments()],
            &[],
        );
        assert!(generation.holds(&SlotKey {
            kind,
            namespace: Some("ops".to_string()),
        }));
        context.end();
    }

    /// A renewed client reads every kind again; the old one serves until the
    /// new one has listed, then the new set is handed over with no gap.
    /// Fails if a change on the old client is lost before the hand-over, or
    /// one on it is still handed after.
    #[tokio::test]
    async fn a_renewed_client_takes_over_once_synced_with_no_gap() {
        let feeds = feeds();
        let context = feeds.context_for("prod", client().await);
        let mut sub = context.join(&ask(None, Binding::Session), &[deployments()], &[]);
        let old = context.serving();
        let slot = whole(&deployments().0);
        list(&old, &slot, vec![deployment("shop", "web", "1")]);
        drain(&mut sub);

        feeds.client_replaced("prod", Some(client().await));
        let new = context.newest();
        assert_ne!(new.id(), old.id());
        assert!(new.holds(&slot));
        apply(&old, &slot, deployment("shop", "api", "1"));
        assert!(matches!(
            drain(&mut sub).as_slice(),
            [Update::Applied { .. }]
        ));

        list(
            &new,
            &slot,
            vec![
                deployment("shop", "web", "1"),
                deployment("shop", "api", "1"),
            ],
        );
        let handed = drain(&mut sub);
        let set = handed.iter().find_map(|u| match u {
            Update::Whole {
                why: Whole::Handover,
                objects,
                ..
            } => Some(names(objects)),
            _ => None,
        });
        assert_eq!(set, Some(vec!["api".to_string(), "web".to_string()]));
        assert!(handed.iter().any(|u| matches!(u, Update::HandedOver)));
        assert!(old.stop.is_cancelled());

        apply(&old, &slot, deployment("shop", "late", "1"));
        assert!(drain(&mut sub).is_empty(), "the old client still speaks");
        context.end();
    }

    /// A disconnect ends every subscription. Fails if a reader keeps waiting
    /// on a cluster no client reads.
    #[tokio::test]
    async fn a_disconnect_ends_every_subscription() {
        let feeds = feeds();
        let context = feeds.context_for("prod", client().await);
        let mut sub = context.join(&ask(None, Binding::Session), &[deployments()], &[]);
        feeds.client_replaced("prod", None);
        let ended = tokio::time::timeout(Duration::from_secs(2), sub.updates.recv()).await;
        assert!(matches!(ended, Ok(None)), "{ended:?}");
        assert!(feeds.context("prod").is_none());
    }

    /// The last subscriber leaving lets the kind linger, then stops its
    /// watch; a page nobody touches is let go. Fails if a watch outlives
    /// every reader, or a page-bound one is kept for good.
    #[tokio::test]
    async fn the_last_reader_leaving_stops_the_watch_after_the_linger() {
        let feeds = feeds().lingering(Duration::ZERO, Duration::ZERO, QUEUE);
        let context = feeds.context_for("prod", client().await);
        let session = context.join(&ask(None, Binding::Session), &[deployments()], &[]);
        let page = context.join(&ask(None, Binding::Page), &[deployments()], &[]);
        let generation = context.serving();
        let slot = whole(&deployments().0);
        assert!(!context.reap(Instant::now()));
        assert!(
            generation.holds(&slot),
            "a session-bound reader still follows it"
        );
        drop(session);
        context.reap(Instant::now());
        assert!(context.reap(Instant::now()));
        assert!(!generation.holds(&slot));
        drop(page);
        context.end();
    }

    /// A reader that falls behind is handed the whole set once there is
    /// room, not left holding half of the changes.
    #[tokio::test]
    async fn a_reader_that_falls_behind_is_handed_the_whole_set_again() {
        let feeds = feeds().lingering(LINGER, PAGE_IDLE, 2);
        let context = feeds.context_for("prod", client().await);
        let mut sub = context.join(&ask(None, Binding::Session), &[deployments()], &[]);
        let generation = context.serving();
        let slot = whole(&deployments().0);
        list(&generation, &slot, vec![deployment("shop", "web", "1")]);
        for n in 0..5 {
            apply(
                &generation,
                &slot,
                deployment("shop", &format!("burst-{n}"), "1"),
            );
        }
        drain(&mut sub);
        apply(&generation, &slot, deployment("shop", "after", "1"));
        let caught_up = drain(&mut sub);
        let set = caught_up.iter().find_map(|u| match u {
            Update::Whole {
                why: Whole::Relist,
                objects,
                ..
            } => Some(objects.len()),
            _ => None,
        });
        assert_eq!(set, Some(7));
        context.end();
    }

    /// Helm keeps each release whole in a Secret, megabytes apiece, and its
    /// history is read elsewhere. Fails if Secrets are watched with them.
    #[tokio::test]
    async fn secrets_are_watched_without_helm_releases() {
        let feeds = feeds();
        let context = feeds.context_for("prod", client().await);
        let generation = context.serving();
        let secrets = SlotKey {
            kind: KindKey {
                group: String::new(),
                plural: "secrets".to_string(),
            },
            namespace: None,
        };
        let narrowed = generation.narrowed(&secrets, watcher::Config::default());
        assert_eq!(
            narrowed.field_selector.as_deref(),
            Some("type!=helm.sh/release.v1")
        );
        let other = generation.narrowed(&whole(&deployments().0), watcher::Config::default());
        assert_eq!(other.field_selector, None);
        context.end();
    }
}
