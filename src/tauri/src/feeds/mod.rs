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
use kube::api::{Api, DynamicObject, ListParams};
use kube::discovery::ApiResource;
use kube::runtime::watcher::{self, Event};
use kube::Client;
use parking_lot::Mutex;
use tokio::sync::{mpsc, Semaphore};
use tokio_util::sync::CancellationToken;

use crate::error::Result;
use crate::ownership::slots::{spawn_slot, SlotHost, PAGE_WITHIN};
use crate::ownership::{KindKey, SlotKey, SlotState, LISTED_FOR};

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
/// Objects per page of a list served to one late reader.
const LIST_PAGE: u32 = 500;

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
    pub(crate) fn of(state: &SlotState) -> Self {
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
    /// A set to start from, with nothing to compare it with: the first of
    /// this slot it is handed, or the first since its namespaces moved.
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
    /// the whole cluster.
    pub scope: Option<Vec<String>>,
    /// Objects outside `scope` are not handed over: a page drawing the
    /// window's namespaces. A recorder of the whole cluster is handed
    /// everything the layer reads, and `scope` only says where to fall back.
    pub narrow: bool,
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

    /// The window's namespaces changed: every set it was handed is handed
    /// again within the new ones, and a kind refused across the cluster is
    /// read in them.
    pub fn rescope(&self, scope: Option<Vec<String>>) {
        if let Some(context) = self.context.upgrade() {
            let (kinds, lists) = {
                let mut inner = context.inner.lock();
                let Some(sub) = inner.subscribers.get_mut(&self.id) else {
                    return;
                };
                let filter = scope.clone().filter(|_| sub.narrow);
                let moved = namespaces(sub.scope.as_deref()) != namespaces(filter.as_deref());
                sub.scope = filter;
                sub.fallback = scope;
                let kinds = sub.kinds.clone();
                if moved {
                    inner.recut(self.id);
                }
                (kinds, std::mem::take(&mut inner.to_list))
            };
            for (id, slot) in lists {
                context.spawn_list(id, slot);
            }
            for kind in kinds {
                context.fall_back_all(&kind);
            }
        }
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        if let Some(context) = self.context.upgrade() {
            let kinds = {
                let mut inner = context.inner.lock();
                let kinds = inner.subscribers.get(&self.id).map(|sub| sub.kinds.clone());
                inner.leave(self.id);
                kinds
            };
            for kind in kinds.iter().flatten() {
                context.fall_back_all(kind);
            }
        }
    }
}

/// What the layer keeps of a kind's objects between changes.
#[derive(Debug, Clone, Copy, Default)]
pub enum Keep {
    /// Each object as it arrived, `managedFields` dropped.
    #[default]
    Whole,
    /// Each object cut at arrival to what readers read; they are handed
    /// the same cut copy.
    Trimmed(fn(&mut DynamicObject)),
    /// Nothing between changes: a reader joining late is served its set by
    /// one list, never by a second watch.
    Nothing,
}

/// Fixed per kind, never per subscriber: one watch has one shape.
#[derive(Debug, Clone, Copy, Default)]
pub struct Params {
    pub fields: Option<&'static str>,
    pub keep: Keep,
}

/// Helm keeps every release whole in a Secret of this type, megabytes each,
/// and its history is read elsewhere.
const NOT_HELM_RELEASES: &str = "type!=helm.sh/release.v1";

/// A Secret's values and a `ConfigMap`'s data sitting in the process for a
/// whole session is more than any reader needs; a pod's env, probes and
/// mounts are most of its bytes and no reader of a feed reads them.
#[must_use]
pub fn params(kind: &KindKey) -> Params {
    match (kind.group.as_str(), kind.plural.as_str()) {
        ("", "secrets") => Params {
            fields: Some(NOT_HELM_RELEASES),
            keep: Keep::Nothing,
        },
        ("", "configmaps") => Params {
            fields: None,
            keep: Keep::Nothing,
        },
        ("", "pods") => Params {
            fields: None,
            keep: Keep::Trimmed(trim_pod),
        },
        _ => Params::default(),
    }
}

/// What a container carries that no feed reader reads.
const CONTAINER_DROPPED: &[&str] = &[
    "command",
    "args",
    "workingDir",
    "livenessProbe",
    "readinessProbe",
    "startupProbe",
    "lifecycle",
    "volumeDevices",
    "securityContext",
    "terminationMessagePath",
    "terminationMessagePolicy",
    "imagePullPolicy",
    "resizePolicy",
    "stdin",
    "stdinOnce",
    "tty",
];

const SPEC_DROPPED: &[&str] = &[
    "tolerations",
    "affinity",
    "securityContext",
    "dnsConfig",
    "topologySpreadConstraints",
    "enableServiceLinks",
    "preemptionPolicy",
    "schedulerName",
    "terminationGracePeriodSeconds",
    "hostAliases",
];

const STATUS_DROPPED: &[&str] = &[
    "imageID",
    "containerID",
    "allocatedResources",
    "resources",
    "volumeMounts",
    "user",
];

/// What a container reads from `ConfigMap`s, `Secret`s and volumes, kept as
/// references: an env entry only where it names a key of a `ConfigMap` or a
/// `Secret`, and never its literal value; `envFrom` whole, which names no
/// value; each mount's volume, path, subPath and readOnly.
fn keep_references(container: &mut serde_json::Map<String, serde_json::Value>) {
    if let Some(serde_json::Value::Array(env)) = container.get_mut("env") {
        env.retain_mut(|entry| {
            let name = entry.get("name").cloned();
            let reference = ["configMapKeyRef", "secretKeyRef"].iter().find_map(|key| {
                let held = entry.pointer(&format!("/valueFrom/{key}"))?;
                Some(serde_json::json!({ *key: held }))
            });
            match (name, reference) {
                (Some(name), Some(reference)) => {
                    *entry = serde_json::json!({ "name": name, "valueFrom": reference });
                    true
                }
                _ => false,
            }
        });
        if env.is_empty() {
            container.remove("env");
        }
    }
    if let Some(serde_json::Value::Array(mounts)) = container.get_mut("volumeMounts") {
        for mount in mounts.iter_mut() {
            if let serde_json::Value::Object(mount) = mount {
                mount.retain(|field, _| {
                    matches!(
                        field.as_str(),
                        "name" | "mountPath" | "subPath" | "readOnly"
                    )
                });
            }
        }
    }
}

/// A pod cut to its identity, owners, placement, containers' names, images,
/// ports, resources and the references they read, volumes, and status
/// without the runtime's ids.
pub fn trim_pod(pod: &mut DynamicObject) {
    if let Some(annotations) = pod.metadata.annotations.as_mut() {
        annotations.remove("kubectl.kubernetes.io/last-applied-configuration");
    }
    let drop_all = |value: Option<&mut serde_json::Value>, fields: &[&str]| {
        if let Some(serde_json::Value::Object(map)) = value {
            for field in fields {
                map.remove(*field);
            }
        }
    };
    let each = |list: Option<&mut serde_json::Value>, fields: &[&str]| {
        if let Some(serde_json::Value::Array(items)) = list {
            for item in items {
                if let serde_json::Value::Object(map) = item {
                    for field in fields {
                        map.remove(*field);
                    }
                }
            }
        }
    };
    let spec = pod.data.get_mut("spec");
    if let Some(spec) = spec {
        for list in ["containers", "initContainers", "ephemeralContainers"] {
            each(spec.get_mut(list), CONTAINER_DROPPED);
        }
        for list in ["containers", "initContainers"] {
            if let Some(serde_json::Value::Array(containers)) = spec.get_mut(list) {
                for container in containers.iter_mut() {
                    if let serde_json::Value::Object(container) = container {
                        keep_references(container);
                    }
                }
            }
        }
        each(
            spec.get_mut("ephemeralContainers"),
            &["env", "envFrom", "volumeMounts"],
        );
        drop_all(Some(spec), SPEC_DROPPED);
    }
    if let Some(status) = pod.data.get_mut("status") {
        for list in [
            "containerStatuses",
            "initContainerStatuses",
            "ephemeralContainerStatuses",
        ] {
            each(status.get_mut(list), STATUS_DROPPED);
        }
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
    /// How long one page of a reader's own list may take, body and all.
    page_within: Duration,
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
            page_within: PAGE_WITHIN,
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
            page_within: self.page_within,
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
    pub(crate) fn listing_within(mut self, page_within: Duration) -> Self {
        self.page_within = page_within;
        self
    }

    #[cfg(test)]
    pub(crate) fn context(&self, name: &str) -> Option<Arc<ContextFeeds>> {
        self.contexts.get(name).map(|held| held.clone())
    }

    /// Joins `ask`'s built-in kinds on `client`, discovery aside.
    #[cfg(test)]
    pub(crate) fn joined(&self, name: &str, client: Client, ask: &Ask) -> Subscription {
        let kinds: Vec<_> = ask
            .kinds
            .iter()
            .filter_map(|kind| Some((kind.clone(), built_in(kind)?)))
            .collect();
        self.context_for(name, client).join(ask, &kinds, &[])
    }
}

struct Subscriber {
    kinds: BTreeSet<KindKey>,
    /// What it is handed is held to these namespaces; `None` is everything.
    scope: Option<Vec<String>>,
    /// Where it asks a kind refused across the cluster to be read.
    fallback: Option<Vec<String>>,
    narrow: bool,
    binding: Binding,
    touched: Instant,
    tx: mpsc::Sender<Update>,
    /// Slots it has been handed a whole set of.
    seen: BTreeSet<SlotKey>,
    /// Its queue filled: it is resent every whole set once there is room.
    lagged: bool,
    /// Slots of a kind kept as nothing whose set is being listed for it,
    /// and the changes that arrived meanwhile.
    pending: BTreeMap<SlotKey, Vec<Update>>,
}

struct KindFeed {
    resource: ApiResource,
    namespaced: bool,
    /// The generation whose reads subscribers are handed.
    serving: u64,
    released_at: Option<Instant>,
}

/// What a late reader is served from, one per live object: the object as
/// compact JSON, a fraction of what it costs as a tree, read back on demand.
#[derive(Default)]
struct SlotStore {
    objects: HashMap<String, Box<str>>,
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
    /// Lists to start once the lock is let go: a subscriber and the slot.
    to_list: Vec<(u64, SlotKey)>,
}

fn uid_of(object: &DynamicObject) -> Option<String> {
    object.metadata.uid.clone()
}

fn kept(slot: &SlotKey, mut object: DynamicObject) -> Arc<DynamicObject> {
    object.metadata.managed_fields = None;
    if let Keep::Trimmed(trim) = params(&slot.kind).keep {
        trim(&mut object);
    }
    Arc::new(object)
}

fn pack(object: &DynamicObject) -> Option<Box<str>> {
    serde_json::to_string(object)
        .ok()
        .map(String::into_boxed_str)
}

fn unpacked<'a>(objects: impl Iterator<Item = &'a Box<str>>) -> Vec<Arc<DynamicObject>> {
    objects
        .filter_map(|text| serde_json::from_str(text).ok().map(Arc::new))
        .collect()
}

fn keeps(kind: &KindKey) -> bool {
    !matches!(params(kind).keep, Keep::Nothing)
}

/// A resourceVersion as the number etcd writes, where it is one.
fn version_of(object: &DynamicObject) -> Option<u64> {
    object.metadata.resource_version.as_deref()?.parse().ok()
}

fn namespaces(scope: Option<&[String]>) -> Option<BTreeSet<&str>> {
    scope.map(|names| names.iter().map(String::as_str).collect())
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
            if let Some(sub) = self.subscribers.get_mut(&id) {
                if let Some(buffer) = sub.pending.get_mut(slot) {
                    match update {
                        Update::Applied { .. } | Update::Deleted { .. } => {
                            buffer.push(update.clone());
                            continue;
                        }
                        // A whole set supersedes the list under way.
                        Update::Whole { .. } => {
                            sub.pending.remove(slot);
                        }
                        Update::State { .. } | Update::HandedOver => {}
                    }
                }
            }
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
        // A set it never received is not one it has seen.
        let whole = match &update {
            Update::Whole { slot, .. } => Some(slot.clone()),
            _ => None,
        };
        match sub.tx.try_send(update) {
            Ok(()) => sub.seen.extend(whole),
            Err(mpsc::error::TrySendError::Full(_)) => sub.lagged = true,
            Err(mpsc::error::TrySendError::Closed(_)) => {
                self.leave(id);
            }
        }
    }

    /// A subscriber that fell behind is handed each slot it follows as it
    /// stands, its state and then its set, and is caught up when all of
    /// them fit. What it lost meanwhile, a state among them, is in these.
    fn resync(&mut self, id: u64) {
        let Some(sub) = self.subscribers.get(&id) else {
            return;
        };
        let serving = |generation: u64, slot: &SlotKey| {
            sub.kinds.contains(&slot.kind)
                && self
                    .kinds
                    .get(&slot.kind)
                    .is_some_and(|f| f.serving == generation)
        };
        let mut unkept: Vec<SlotKey> = Vec::new();
        let mut updates: Vec<Update> = Vec::new();
        for ((generation, slot), state) in &self.states {
            if !serving(*generation, slot) {
                continue;
            }
            let store = self
                .stores
                .get(&(*generation, slot.clone()))
                .filter(|store| store.synced);
            if store.is_some() && !keeps(&slot.kind) {
                // Listed for it, which says its own states.
                unkept.push(slot.clone());
                continue;
            }
            updates.push(Update::State {
                slot: slot.clone(),
                state: state.clone(),
            });
            if let Some(store) = store {
                updates.push(Update::Whole {
                    slot: slot.clone(),
                    why: if sub.seen.contains(slot) {
                        Whole::Relist
                    } else {
                        Whole::Fresh
                    },
                    objects: unpacked(store.objects.values())
                        .into_iter()
                        .filter(|o| in_scope(sub.scope.as_deref(), o))
                        .collect(),
                });
            }
        }
        let Some(sub) = self.subscribers.get_mut(&id) else {
            return;
        };
        if sub.tx.capacity() < updates.len() {
            return;
        }
        for update in updates {
            if let Update::Whole { slot, .. } = &update {
                sub.seen.insert(slot.clone());
            }
            let _ = sub.tx.try_send(update);
        }
        sub.lagged = false;
        for slot in unkept {
            self.list_for(id, slot);
        }
    }

    /// Subscriber `id`'s namespaces moved: each slot it was handed is handed
    /// whole again within the new ones, from the store or by a list where
    /// the kind is kept as nothing. Changes only ever reached it within the
    /// old ones, so what the new ones hold arrives no other way.
    fn recut(&mut self, id: u64) {
        let Some(sub) = self.subscribers.get_mut(&id) else {
            return;
        };
        let scope = sub.scope.clone();
        for slot in std::mem::take(&mut sub.seen) {
            let held = self
                .kinds
                .get(&slot.kind)
                .and_then(|feed| self.stores.get(&(feed.serving, slot.clone())))
                .filter(|store| store.synced)
                .map(|store| keeps(&slot.kind).then(|| unpacked(store.objects.values())));
            match held {
                Some(Some(objects)) => self.send(
                    id,
                    Update::Whole {
                        slot,
                        why: Whole::Fresh,
                        objects: objects
                            .into_iter()
                            .filter(|o| in_scope(scope.as_deref(), o))
                            .collect(),
                    },
                ),
                Some(None) => self.list_for(id, slot),
                None => {}
            }
        }
    }

    /// Lists `slot` for subscriber `id` alone, once the lock is let go; the
    /// slot's changes wait in its queue until the set has arrived.
    fn list_for(&mut self, id: u64, slot: SlotKey) {
        let Some(sub) = self.subscribers.get_mut(&id) else {
            return;
        };
        if sub.pending.contains_key(&slot) {
            return;
        }
        sub.pending.insert(slot.clone(), Vec::new());
        let _ = sub.tx.try_send(Update::State {
            slot: slot.clone(),
            state: FeedState::Syncing,
        });
        self.to_list.push((id, slot));
    }

    /// The set listed for `id` arrived: handed whole, then each change
    /// that came meanwhile and is newer than the list.
    fn listed_for(
        &mut self,
        id: u64,
        slot: &SlotKey,
        objects: Vec<Arc<DynamicObject>>,
        at: Option<u64>,
    ) {
        let Some(sub) = self.subscribers.get_mut(&id) else {
            return;
        };
        let Some(waited) = sub.pending.remove(slot) else {
            return;
        };
        let why = if sub.seen.contains(slot) {
            Whole::Relist
        } else {
            Whole::Fresh
        };
        let scope = sub.scope.clone();
        let state = self
            .kinds
            .get(&slot.kind)
            .and_then(|feed| self.states.get(&(feed.serving, slot.clone())))
            .cloned()
            .unwrap_or(FeedState::Synced);
        self.send(
            id,
            Update::State {
                slot: slot.clone(),
                state,
            },
        );
        self.send(
            id,
            Update::Whole {
                slot: slot.clone(),
                why,
                objects: objects
                    .into_iter()
                    .filter(|o| in_scope(scope.as_deref(), o))
                    .collect(),
            },
        );
        for update in waited {
            let handed = match &update {
                Update::Applied { object, .. } => {
                    in_scope(scope.as_deref(), object)
                        && match (version_of(object), at) {
                            (Some(version), Some(at)) => version > at,
                            _ => true,
                        }
                }
                Update::Deleted { object, .. } => in_scope(scope.as_deref(), object),
                _ => true,
            };
            if handed {
                self.send(id, update);
            }
        }
    }

    /// A list for `id` failed: it is told, and the list is tried again. What
    /// waited on it is let go: the next list holds it.
    fn list_failed(&mut self, id: u64, slot: &SlotKey, message: String) {
        if let Some(sub) = self.subscribers.get_mut(&id) {
            if let Some(waited) = sub.pending.get_mut(slot) {
                waited.clear();
                let _ = sub.tx.try_send(Update::State {
                    slot: slot.clone(),
                    state: FeedState::Failed { message },
                });
            }
        }
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
                .map(|store| unpacked(store.objects.values()));
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
        if !keeps(kind) {
            for ((g, slot), store) in &mut self.stores {
                if *g == generation && slot.kind == *kind {
                    store.objects.clear();
                }
            }
        }
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
    page_within: Duration,
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
                    scope: ask.scope.clone().filter(|_| ask.narrow),
                    fallback: ask.scope.clone(),
                    narrow: ask.narrow,
                    binding: ask.binding,
                    touched: Instant::now(),
                    tx,
                    seen: BTreeSet::new(),
                    lagged: false,
                    pending: BTreeMap::new(),
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
                        .map(|store| unpacked(store.objects.values()));
                    (slot.clone(), state.clone(), objects)
                })
                .collect();
            for (slot, state, objects) in known {
                if objects.is_some() && !keeps(&slot.kind) {
                    inner.list_for(id, slot);
                    continue;
                }
                inner.send(
                    id,
                    Update::State {
                        slot: slot.clone(),
                        state,
                    },
                );
                if let Some(objects) = objects {
                    let scope = ask.scope.clone().filter(|_| ask.narrow);
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
            (id, std::mem::take(&mut inner.to_list))
        };
        let (id, lists) = id;
        for (subscriber, slot) in lists {
            self.spawn_list(subscriber, slot);
        }
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

    /// Lists `slot` for subscriber `id` on the client serving its kind, a
    /// page at a time, until it answers or the subscriber stops waiting.
    fn spawn_list(self: &Arc<Self>, id: u64, slot: SlotKey) {
        let context = self.clone();
        tokio::spawn(async move {
            let mut failures = 0;
            loop {
                let asked = {
                    let inner = context.inner.lock();
                    let waiting = inner
                        .subscribers
                        .get(&id)
                        .is_some_and(|sub| sub.pending.contains_key(&slot));
                    let feed = inner.kinds.get(&slot.kind);
                    match (
                        waiting,
                        feed.and_then(|f| inner.generations.get(&f.serving)),
                    ) {
                        (true, Some(generation)) => {
                            (generation.client.clone(), feed.map(|f| f.resource.clone()))
                        }
                        _ => return,
                    }
                };
                let (client, Some(resource)) = asked else {
                    return;
                };
                let listed = tokio::select! {
                    biased;
                    () = context.stop.cancelled() => return,
                    listed = list_slot(client, &resource, &slot, context.page_within) => listed,
                };
                match listed {
                    Ok((objects, at)) => {
                        context.inner.lock().listed_for(id, &slot, objects, at);
                        return;
                    }
                    Err(error) => {
                        failures += 1;
                        context.inner.lock().list_failed(id, &slot, error.said());
                        tokio::select! {
                            biased;
                            () = context.stop.cancelled() => return,
                            () = tokio::time::sleep(crate::watch::backoff_for(failures)) => {}
                        }
                    }
                }
            }
        });
    }

    /// Reads a kind refused across the cluster in every namespace a
    /// subscriber's scope names, in each generation that refused it, and
    /// lets go of a namespace no subscriber names any longer: a reader moving
    /// through namespaces would otherwise hold a watch in each it ever saw.
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
                .filter_map(|sub| sub.fallback.clone())
                .flatten()
                .collect();
            (
                inner.generations.values().cloned().collect::<Vec<_>>(),
                namespaces,
                feed.resource.clone(),
            )
        };
        for generation in generations {
            let unasked: Vec<SlotKey> = generation
                .slots
                .lock()
                .keys()
                .filter(|slot| {
                    slot.kind == *kind
                        && slot
                            .namespace
                            .as_ref()
                            .is_some_and(|namespace| !namespaces.contains(namespace))
                })
                .cloned()
                .collect();
            for slot in &unasked {
                generation.stop_slot(slot);
            }
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
                generation.spawn(&slot, resource.clone());
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
        let generations: Vec<Arc<Generation>> =
            self.inner.lock().generations.values().cloned().collect();
        for generation in generations {
            generation.overdue(chrono::Utc::now());
        }
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

/// Every object of `slot`, narrowed and cut as its watch is, and the
/// collection's resourceVersion the list was read at. Each page is given up
/// after `within`: the client's own deadline ends at the response head, and
/// a body that stalls part-way would hold the reader listing for good.
async fn list_slot(
    client: Client,
    resource: &ApiResource,
    slot: &SlotKey,
    within: Duration,
) -> Result<(Vec<Arc<DynamicObject>>, Option<u64>)> {
    let api: Api<DynamicObject> = match &slot.namespace {
        Some(namespace) => Api::namespaced_with(client, namespace, resource),
        None => Api::all_with(client, resource),
    };
    let mut params = ListParams::default().limit(LIST_PAGE);
    if let Some(fields) = self::params(&slot.kind).fields {
        params = params.fields(fields);
    }
    let mut objects = Vec::new();
    let mut at = None;
    loop {
        let page = tokio::time::timeout(within, api.list(&params))
            .await
            .map_err(|_| crate::error::Error::ReadDeadline {
                after_secs: within.as_secs(),
            })??;
        at = at.or_else(|| page.metadata.resource_version.as_deref()?.parse().ok());
        objects.extend(page.items.into_iter().map(|object| kept(slot, object)));
        match page.metadata.continue_.filter(|token| !token.is_empty()) {
            Some(token) => params = params.continue_token(&token),
            None => return Ok((objects, at)),
        }
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
        self.spawn(&slot, resource);
    }

    /// Starts reading `slot`; one left waiting for a watch says so, rather
    /// than nothing until its turn comes.
    fn spawn(self: &Arc<Self>, slot: &SlotKey, resource: ApiResource) {
        spawn_slot(self, slot.clone(), resource, RELIST_EVERY, PAGE_WITHIN);
        let slots = self.slots.lock();
        if matches!(slots.get(slot), Some(SlotState::Queued)) {
            let id = self.id;
            self.tell(|inner| {
                inner.state(id, slot, FeedState::Queued);
                Vec::new()
            });
        }
    }

    /// A slot read by its list alone whose next turn is long overdue is no
    /// longer the kind as it is: it says since when, as the ownership index
    /// says of the same slot.
    fn overdue(&self, now: chrono::DateTime<chrono::Utc>) {
        let slots = self.slots.lock();
        let id = self.id;
        for (slot, state) in slots.iter() {
            let SlotState::Listed { at } = state else {
                continue;
            };
            if now
                .signed_duration_since(*at)
                .to_std()
                .is_ok_and(|age| age > LISTED_FOR)
            {
                let blind = FeedState::Blind {
                    since: at.to_rfc3339(),
                };
                self.tell(|inner| {
                    inner.state(id, slot, blind);
                    Vec::new()
                });
            }
        }
    }

    /// Stops one slot and lets go of what it held.
    fn stop_slot(&self, slot: &SlotKey) {
        let mut slots = self.slots.lock();
        if let Some(stop) = self.stops.lock().remove(slot) {
            stop.cancel();
        }
        slots.remove(slot);
        let id = self.id;
        self.tell(|inner| {
            inner.stores.remove(&(id, slot.clone()));
            inner.states.remove(&(id, slot.clone()));
            Vec::new()
        });
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
        let (retired, lists) = {
            let mut inner = feeds.inner.lock();
            // A retired generation's last words are nobody's.
            if !inner.generations.contains_key(&self.id) {
                return;
            }
            let retired = change(&mut inner);
            (retired, std::mem::take(&mut inner.to_list))
        };
        for (id, slot) in lists {
            feeds.spawn_list(id, slot);
        }
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
                        listing.insert(uid, kept(slot, object));
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
                    let objects: Vec<Arc<DynamicObject>> = listed.values().cloned().collect();
                    store.synced = true;
                    // A kind kept as nothing holds its set only while a new
                    // client is to hand it over.
                    let serving = inner.serves(id, &slot.kind);
                    let store = inner.stores.entry((id, slot.clone())).or_default();
                    store.objects = if serving && !keeps(&slot.kind) {
                        HashMap::new()
                    } else {
                        listed
                            .iter()
                            .filter_map(|(uid, object)| Some((uid.clone(), pack(object)?)))
                            .collect()
                    };
                    inner.state(id, slot, FeedState::Synced);
                    if serving {
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
                    let object = kept(slot, object);
                    let serving = inner.serves(id, &slot.kind);
                    if keeps(&slot.kind) || !serving {
                        if let Some(text) = pack(&object) {
                            inner
                                .stores
                                .entry((id, slot.clone()))
                                .or_default()
                                .objects
                                .insert(uid, text);
                        }
                    }
                    if serving {
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
                    inner
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
                                object: kept(slot, object),
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
            narrow: true,
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

    /// Audit and the cluster map on screen together follow each kind they
    /// share through one watch: both pages reach the same context, and the
    /// slots opened are the kinds either asks for, not the sum of both asks.
    /// Would break if one of them spelled a kind other than the layer does,
    /// or reached a context of its own.
    #[tokio::test]
    async fn audit_and_the_map_together_open_one_watch_per_kind() {
        type Resolved = Vec<(KindKey, (ApiResource, bool))>;
        let feeds = feeds();
        let client = client().await;
        let context = feeds.context_for("prod", client.clone());
        let theirs = feeds.context_for("prod", client);
        assert!(Arc::ptr_eq(&context, &theirs));
        let audit = crate::audit::feed_ask(None);
        let map = crate::topology::ask(None);
        let resolved = |ask: &Ask| -> (Resolved, Vec<KindKey>) {
            let (known, unknown): (Vec<_>, Vec<_>) =
                ask.kinds.iter().partition(|kind| built_in(kind).is_some());
            (
                known
                    .into_iter()
                    .map(|kind| (kind.clone(), built_in(kind).expect("built in")))
                    .collect(),
                unknown.into_iter().cloned().collect(),
            )
        };
        let (audit_kinds, audit_unserved) = resolved(&audit);
        let (map_kinds, map_unserved) = resolved(&map);
        let _audit = context.join(&audit, &audit_kinds, &audit_unserved);
        let _map = theirs.join(&map, &map_kinds, &map_unserved);

        let shared = audit_kinds
            .iter()
            .filter(|(kind, _)| map_kinds.iter().any(|(other, _)| other == kind))
            .count();
        let either: BTreeSet<&KindKey> = audit_kinds
            .iter()
            .chain(&map_kinds)
            .map(|(kind, _)| kind)
            .collect();
        assert!(shared >= 8, "the two pages share {shared} kinds");
        // One resource spelled two ways would be two slots, or one and none.
        let mut spelled: BTreeMap<(&str, &str), BTreeSet<&KindKey>> = BTreeMap::new();
        for kind in audit.kinds.iter().chain(&map.kinds) {
            let stem = kind.plural.trim_end_matches('s');
            spelled
                .entry((kind.group.as_str(), stem))
                .or_default()
                .insert(kind);
        }
        let twice: Vec<_> = spelled.values().filter(|keys| keys.len() > 1).collect();
        assert!(twice.is_empty(), "{twice:?}");
        assert!(audit_unserved.is_empty(), "{audit_unserved:?}");
        let opened = context.serving().stops.lock().len();
        assert_eq!(
            opened,
            either.len(),
            "watches opened against kinds asked for"
        );
        context.end();
    }

    /// The timeline follows for the whole session kinds that Audit and the
    /// cluster map follow while on screen. With all three, each kind is one
    /// watch; with the two pages closed, every kind the timeline asks for is
    /// still watched and only the pages' own kinds stop. Would break if the
    /// timeline spelled a kind its own way, or a page's leaving took a watch
    /// a session subscriber still holds.
    #[tokio::test]
    async fn the_timeline_beside_audit_and_the_map_keeps_its_kinds_when_they_close() {
        let feeds = feeds().lingering(Duration::ZERO, Duration::ZERO, QUEUE);
        let context = feeds.context_for("prod", client().await);
        let split = |ask: &Ask| {
            let (known, unknown): (Vec<_>, Vec<_>) =
                ask.kinds.iter().partition(|kind| built_in(kind).is_some());
            let known: Vec<(KindKey, (ApiResource, bool))> = known
                .into_iter()
                .map(|kind| (kind.clone(), built_in(kind).expect("built in")))
                .collect();
            (known, unknown.into_iter().cloned().collect::<Vec<_>>())
        };
        let timeline = crate::timeline::follow::ask(None);
        let audit = crate::audit::feed_ask(None);
        let map = crate::topology::ask(None);
        let (timeline_kinds, timeline_unserved) = split(&timeline);
        let (audit_kinds, audit_unserved) = split(&audit);
        let (map_kinds, map_unserved) = split(&map);
        let _timeline = context.join(&timeline, &timeline_kinds, &timeline_unserved);
        let audit_page = context.join(&audit, &audit_kinds, &audit_unserved);
        let map_page = context.join(&map, &map_kinds, &map_unserved);

        let ours: BTreeSet<&KindKey> = timeline_kinds.iter().map(|(kind, _)| kind).collect();
        let either: BTreeSet<&KindKey> = timeline_kinds
            .iter()
            .chain(&audit_kinds)
            .chain(&map_kinds)
            .map(|(kind, _)| kind)
            .collect();
        let shared = audit_kinds
            .iter()
            .chain(&map_kinds)
            .filter(|(kind, _)| ours.contains(kind))
            .map(|(kind, _)| kind)
            .collect::<BTreeSet<_>>()
            .len();
        assert!(
            shared >= 8,
            "the timeline shares {shared} kinds with the pages"
        );
        let mut spelled: BTreeMap<(&str, &str), BTreeSet<&KindKey>> = BTreeMap::new();
        for kind in timeline.kinds.iter().chain(&audit.kinds).chain(&map.kinds) {
            let stem = kind.plural.trim_end_matches('s');
            spelled
                .entry((kind.group.as_str(), stem))
                .or_default()
                .insert(kind);
        }
        let twice: Vec<_> = spelled.values().filter(|keys| keys.len() > 1).collect();
        assert!(twice.is_empty(), "{twice:?}");
        let generation = context.serving();
        assert_eq!(generation.stops.lock().len(), either.len());

        drop(audit_page);
        drop(map_page);
        context.reap(Instant::now());
        for kind in &either {
            assert_eq!(
                generation.holds(&whole(kind)),
                ours.contains(kind),
                "{kind:?} after the pages closed"
            );
        }
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
        let other = context.join(
            &ask(Some(vec!["ops"]), Binding::Page),
            &[deployments()],
            &[],
        );
        assert!(generation.holds(&SlotKey {
            kind,
            namespace: Some("ops".to_string()),
        }));
        drop(other);
        context.end();
    }

    /// A namespace no reader asks for any longer stops being read on its
    /// own. Fails if a reader moving through namespaces keeps a watch in
    /// each it ever looked at, which spent the shared budget in twenty moves.
    #[tokio::test]
    async fn a_namespace_no_reader_asks_for_is_let_go() {
        let feeds = feeds();
        let context = feeds.context_for("prod", client().await);
        let sub = context.join(
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
        let held = |namespace: &str| {
            generation.holds(&SlotKey {
                kind: kind.clone(),
                namespace: Some(namespace.to_string()),
            })
        };
        let other = context.join(
            &ask(Some(vec!["ops"]), Binding::Page),
            &[deployments()],
            &[],
        );
        assert!(held("shop") && held("billing") && held("ops"));

        sub.lease.rescope(Some(vec!["shop".to_string()]));
        assert!(held("shop") && !held("billing") && held("ops"));
        drop(other);
        assert!(
            held("shop") && !held("ops"),
            "a reader that left kept its namespace read"
        );
        context.end();
    }

    /// A reader moved to other namespaces is handed, from the store, what is
    /// there now as a set to start from; only a real move hands anything.
    /// Fails if a namespace added to the scope reads as empty until the next
    /// break, which is what Audit said of it and why the Timeline wrote its
    /// objects as created when they changed.
    #[tokio::test]
    async fn a_reader_moved_to_other_namespaces_is_handed_what_is_there_now() {
        let feeds = feeds();
        let context = feeds.context_for("prod", client().await);
        let mut sub = context.join(
            &ask(Some(vec!["shop"]), Binding::Page),
            &[deployments()],
            &[],
        );
        let generation = context.serving();
        let slot = whole(&deployments().0);
        list(
            &generation,
            &slot,
            vec![
                deployment("shop", "web", "1"),
                deployment("payments", "api", "1"),
            ],
        );
        drain(&mut sub);
        let sets = |updates: Vec<Update>| -> Vec<(Whole, Vec<String>)> {
            updates
                .into_iter()
                .filter_map(|u| match u {
                    Update::Whole { why, objects, .. } => Some((why, names(&objects))),
                    _ => None,
                })
                .collect()
        };

        sub.lease.rescope(Some(vec!["payments".to_string()]));
        assert_eq!(
            sets(drain(&mut sub)),
            vec![(Whole::Fresh, vec!["api".to_string()])]
        );
        sub.lease.rescope(Some(vec!["payments".to_string()]));
        assert!(
            drain(&mut sub).is_empty(),
            "the same namespaces moved nothing"
        );
        sub.lease.rescope(None);
        assert_eq!(
            sets(drain(&mut sub)),
            vec![(Whole::Fresh, vec!["api".to_string(), "web".to_string()])]
        );
        apply(&generation, &slot, deployment("payments", "api", "2"));
        assert!(matches!(
            drain(&mut sub).as_slice(),
            [Update::Applied { .. }]
        ));
        context.end();
    }

    /// A kind kept as nothing has no store to hand from, so a moved reader
    /// is listed its set, said to be reading meanwhile. Fails if a moved
    /// reader of `ConfigMaps` is left with the old namespaces' set.
    #[tokio::test]
    async fn a_reader_moved_on_a_kind_kept_as_nothing_is_listed_its_new_namespaces() {
        let (client, hits) = answering(|path, _| {
            if path == "/api/v1/configmaps" {
                let item = |namespace: &str, name: &str| json!({ "metadata": { "name": name, "namespace": namespace, "uid": format!("{namespace}/{name}"), "resourceVersion": "450" } });
                let items = vec![item("shop", "app"), item("payments", "ledger")];
                (200, json!({ "apiVersion": "v1", "kind": "ConfigMapList", "metadata": { "resourceVersion": "500" }, "items": items }).to_string())
            } else {
                failure(404, "NotFound")
            }
        })
        .await;
        let feeds = feeds();
        let context = feeds.context_for("prod", client);
        let maps = (
            slot_of("", "configmaps").kind,
            (ApiResource::erase::<ConfigMap>(&()), true),
        );
        let mut ask = config_maps_of(&context);
        ask.scope = Some(vec!["shop".to_string()]);
        let mut sub = context.join(&ask, &[maps], &[]);
        let generation = context.serving();
        let slot = slot_of("", "configmaps");
        list(&generation, &slot, vec![config_map("app", "100")]);
        drain(&mut sub);

        sub.lease.rescope(Some(vec!["payments".to_string()]));
        let seen = whole_within(&mut sub).await;
        assert!(matches!(
            seen.first(),
            Some(Update::State {
                state: FeedState::Syncing,
                ..
            })
        ));
        let set = seen.iter().find_map(|u| match u {
            Update::Whole { why, objects, .. } => Some((*why, names(objects))),
            _ => None,
        });
        assert_eq!(set, Some((Whole::Fresh, vec!["ledger".to_string()])));
        assert_eq!(hits.lock().unwrap().get("/api/v1/configmaps"), Some(&1));
        context.end();
    }

    /// A kind left waiting for a watch says so at once. Fails if it reads
    /// as nothing at all until its turn, which the map drew as not installed.
    #[tokio::test]
    async fn a_kind_waiting_for_a_watch_says_it_is_queued() {
        let feeds = feeds();
        let context = feeds.context_for("prod", client().await);
        let mut sub = context.join(&ask(None, Binding::Page), &[deployments()], &[]);
        let slot = whole(&deployments().0);
        assert!(drain(&mut sub).iter().any(|u| matches!(
            u,
            Update::State { slot: at, state: FeedState::Queued } if *at == slot
        )));
        context.end();
    }

    /// A list whose next turn is long overdue says since when, as the
    /// ownership index says of the same slot. Fails if an old list reads as
    /// synced for good.
    #[tokio::test]
    async fn a_list_long_overdue_says_since_when() {
        let feeds = feeds();
        let context = feeds.context_for("prod", client().await);
        let mut sub = context.join(&ask(None, Binding::Page), &[deployments()], &[]);
        drain(&mut sub);
        let slot = whole(&deployments().0);
        let at = chrono::Utc::now()
            - chrono::Duration::from_std(LISTED_FOR + Duration::from_secs(1)).expect("a span");
        context
            .serving()
            .slots
            .lock()
            .insert(slot, SlotState::Listed { at });
        context.reap(Instant::now());
        let since = at.to_rfc3339();
        assert!(drain(&mut sub).iter().any(|u| matches!(
            u,
            Update::State { state: FeedState::Blind { since: said }, .. } if *said == since
        )));
        context.end();
    }

    /// With the window on `shop`, a page draws `shop` and the timeline records
    /// the cluster, whose span says it watched the whole of it. Fails if the
    /// timeline loses a rollout in `payments` the whole-cluster watch saw, a
    /// page is handed it, or the timeline stops falling back to its window's
    /// namespaces where the cluster refuses.
    #[tokio::test]
    async fn the_timeline_is_handed_the_whole_cluster_and_a_page_its_namespaces() {
        let feeds = feeds();
        let context = feeds.context_for("prod", client().await);
        let window = Some(vec!["shop".to_string()]);
        let mut page = context.join(
            &ask(Some(vec!["shop"]), Binding::Page),
            &[deployments()],
            &[],
        );
        let mut timeline = context.join(
            &crate::timeline::follow::ask(window.clone()),
            &[deployments()],
            &[],
        );
        let generation = context.serving();
        let slot = whole(&deployments().0);
        list(
            &generation,
            &slot,
            vec![
                deployment("shop", "web", "1"),
                deployment("payments", "api", "1"),
            ],
        );
        apply(&generation, &slot, deployment("payments", "api", "2"));
        let named = |updates: Vec<Update>| -> Vec<String> {
            updates
                .iter()
                .flat_map(|update| match update {
                    Update::Whole { objects, .. } => names(objects),
                    Update::Applied { object, .. } => {
                        vec![object.metadata.name.clone().unwrap_or_default()]
                    }
                    _ => Vec::new(),
                })
                .collect()
        };
        assert_eq!(named(drain(&mut page)), ["web"]);
        assert_eq!(named(drain(&mut timeline)), ["api", "web", "api"]);
        timeline.lease.rescope(Some(vec!["ops".to_string()]));
        apply(&generation, &slot, deployment("payments", "api", "3"));
        assert_eq!(named(drain(&mut timeline)), ["api"]);

        let refusing = feeds.context_for("staging", client().await);
        let _timeline = refusing.join(&crate::timeline::follow::ask(window), &[deployments()], &[]);
        let generation = refusing.serving();
        SlotHost::refused(
            &generation,
            &whole(&deployments().0),
            "deployments is forbidden".to_string(),
            None,
        );
        assert!(generation.holds(&SlotKey {
            kind: deployments().0,
            namespace: Some("shop".to_string()),
        }));
        context.end();
        refusing.end();
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
        drain(&mut sub);
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

    /// A reader that falls behind is handed its slot's state and whole set
    /// once there is room, not left holding half of the changes; a set it
    /// never received comes as its first. Fails if a watch that broke while
    /// it was behind still reads as synced, or if its first set comes as a
    /// relist, which the Timeline compared with nothing and wrote every
    /// object as created.
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
        let first = drain(&mut sub);
        assert!(
            !first.iter().any(|u| matches!(u, Update::Whole { .. })),
            "the queue held the first set: {first:?}"
        );
        generation.failed(
            &slot,
            "connection reset".to_string(),
            &CancellationToken::new(),
        );
        let caught_up = drain(&mut sub);
        assert!(
            matches!(
                caught_up.as_slice(),
                [
                    Update::State {
                        state: FeedState::Blind { .. },
                        ..
                    },
                    Update::Whole {
                        why: Whole::Fresh,
                        ..
                    }
                ]
            ),
            "{caught_up:?}"
        );
        let Update::Whole { objects, .. } = &caught_up[1] else {
            unreachable!()
        };
        assert_eq!(objects.len(), 6);
        apply(&generation, &slot, deployment("shop", "after", "1"));
        assert!(matches!(
            drain(&mut sub).as_slice(),
            [Update::Applied { .. }]
        ));
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

    /// Heap bytes a JSON tree holds, as the `BTreeMap` serde keeps an object
    /// in: each entry's key and value plus a node's share, each array's
    /// slots, each string's buffer.
    fn heap_bytes(value: &serde_json::Value) -> usize {
        use serde_json::Value;
        let slot = std::mem::size_of::<Value>();
        let entry = std::mem::size_of::<String>() + slot;
        match value {
            Value::String(text) => text.capacity(),
            Value::Array(items) => {
                items.capacity() * slot + items.iter().map(heap_bytes).sum::<usize>()
            }
            Value::Object(map) => map
                .iter()
                .map(|(key, value)| entry * 3 / 2 + key.capacity() + heap_bytes(value))
                .sum(),
            _ => 0,
        }
    }

    /// What the store of one slot holds, in heap bytes and as JSON.
    fn resident(context: &ContextFeeds, slot: &SlotKey) -> (usize, usize) {
        let inner = context.inner.lock();
        inner
            .stores
            .iter()
            .filter(|((_, held), _)| held == slot)
            .flat_map(|(_, store)| store.objects.iter())
            .map(|(uid, text)| {
                let entry = std::mem::size_of::<String>() + std::mem::size_of::<Box<str>>();
                (entry * 2 + uid.capacity() + text.len(), text.len())
            })
            .fold((0, 0), |(heap, json), (h, j)| (heap + h, json + j))
    }

    fn hex(n: usize, width: usize) -> String {
        format!("{n:0width$x}")
    }

    /// A pod as a Deployment stamps it out on a real cluster: two
    /// containers with env, probes and mounts, the projected token volume,
    /// five conditions and two container statuses.
    pub(crate) fn realistic_pod(n: usize) -> serde_json::Value {
        let mut env: Vec<serde_json::Value> = (0..8)
            .map(|e| json!({ "name": format!("SETTING_{e}"), "value": format!("value-for-setting-{e}-of-the-web-app") }))
            .collect();
        env.extend([
            json!({ "name": "DB_PASSWORD", "valueFrom": { "secretKeyRef": { "name": "web-db", "key": "password" } } }),
            json!({ "name": "FEATURE", "valueFrom": { "configMapKeyRef": { "name": "web-flags", "key": "feature", "optional": true } } }),
            json!({ "name": "POD_IP", "valueFrom": { "fieldRef": { "apiVersion": "v1", "fieldPath": "status.podIP" } } }),
        ]);
        let probe = json!({ "httpGet": { "path": "/healthz", "port": 8080, "scheme": "HTTP" },
            "timeoutSeconds": 1, "periodSeconds": 10, "successThreshold": 1, "failureThreshold": 3 });
        let container = |name: &str| {
            json!({
                "name": name, "image": format!("registry.example.com/team/{name}:1.4.2"),
                "ports": [{ "name": "http", "containerPort": 8080, "protocol": "TCP" }],
                "env": env, "envFrom": [{ "configMapRef": { "name": "web-env" } }],
                "args": ["--config=/etc/web/config.yaml", "--log-level=info"],
                "resources": { "requests": { "cpu": "100m", "memory": "128Mi" }, "limits": { "memory": "256Mi" } },
                "volumeMounts": [{ "name": "config", "mountPath": "/etc/web", "mountPropagation": "None" },
                    { "name": "kube-api-access-x2k9p", "readOnly": true, "mountPath": "/var/run/secrets/kubernetes.io/serviceaccount" }],
                "livenessProbe": probe, "readinessProbe": probe,
                "terminationMessagePath": "/dev/termination-log", "terminationMessagePolicy": "File",
                "imagePullPolicy": "IfNotPresent",
                "securityContext": { "allowPrivilegeEscalation": false, "runAsNonRoot": true, "capabilities": { "drop": ["ALL"] } }
            })
        };
        let condition = |kind: &str| json!({ "type": kind, "status": "True", "lastProbeTime": null, "lastTransitionTime": "2026-11-01T10:00:05Z" });
        let status = |name: &str| {
            json!({
                "name": name, "state": { "running": { "startedAt": "2026-11-01T10:00:03Z" } }, "lastState": {},
                "ready": true, "restartCount": 0, "image": format!("registry.example.com/team/{name}:1.4.2"),
                "imageID": format!("registry.example.com/team/{name}@sha256:{}", hex(n, 64)),
                "containerID": format!("containerd://{}", hex(n + 1, 64)), "started": true
            })
        };
        json!({
            "apiVersion": "v1", "kind": "Pod",
            "metadata": {
                "name": format!("web-7d9f8c6b5d-{n:05}"), "generateName": "web-7d9f8c6b5d-",
                "namespace": format!("team-{}", n % 50), "uid": format!("{}-pod", hex(n, 24)),
                "resourceVersion": format!("{}", 100_000 + n), "creationTimestamp": "2026-11-01T10:00:00Z",
                "labels": { "app": "web", "pod-template-hash": "7d9f8c6b5d", "app.kubernetes.io/name": "web",
                    "app.kubernetes.io/instance": "web", "app.kubernetes.io/version": "1.4.2" },
                "annotations": { "kubectl.kubernetes.io/restartedAt": "2026-11-01T10:00:00Z",
                    "prometheus.io/scrape": "true", "prometheus.io/port": "9090" },
                "ownerReferences": [{ "apiVersion": "apps/v1", "kind": "ReplicaSet", "name": "web-7d9f8c6b5d",
                    "uid": hex(n, 32), "controller": true, "blockOwnerDeletion": true }]
            },
            "spec": {
                "volumes": [
                    { "name": "config", "configMap": { "name": "web-config", "defaultMode": 420 } },
                    { "name": "kube-api-access-x2k9p", "projected": { "defaultMode": 420, "sources": [
                        { "serviceAccountToken": { "expirationSeconds": 3607, "path": "token" } },
                        { "configMap": { "name": "kube-root-ca.crt", "items": [{ "key": "ca.crt", "path": "ca.crt" }] } },
                        { "downwardAPI": { "items": [{ "path": "namespace", "fieldRef": { "apiVersion": "v1", "fieldPath": "metadata.namespace" } }] } }
                    ] } }
                ],
                "containers": [container("web"), container("proxy")],
                "restartPolicy": "Always", "terminationGracePeriodSeconds": 30, "dnsPolicy": "ClusterFirst",
                "serviceAccountName": "web", "serviceAccount": "web", "nodeName": format!("node-{}", n % 20),
                "securityContext": {}, "schedulerName": "default-scheduler",
                "tolerations": [
                    { "key": "node.kubernetes.io/not-ready", "operator": "Exists", "effect": "NoExecute", "tolerationSeconds": 300 },
                    { "key": "node.kubernetes.io/unreachable", "operator": "Exists", "effect": "NoExecute", "tolerationSeconds": 300 }
                ],
                "priority": 0, "enableServiceLinks": true, "preemptionPolicy": "PreemptLowerPriority"
            },
            "status": {
                "phase": "Running",
                "conditions": [condition("PodReadyToStartContainers"), condition("Initialized"), condition("Ready"),
                    condition("ContainersReady"), condition("PodScheduled")],
                "hostIP": "10.0.0.2", "hostIPs": [{ "ip": "10.0.0.2" }],
                "podIP": format!("10.244.{}.{}", n / 250 % 250, n % 250), "podIPs": [{ "ip": "10.244.0.5" }],
                "startTime": "2026-11-01T10:00:00Z",
                "containerStatuses": [status("web"), status("proxy")], "qosClass": "Burstable"
            }
        })
    }

    /// A `ConfigMap` of an app's settings, about a kilobyte and a half.
    fn realistic_config_map(n: usize) -> serde_json::Value {
        json!({ "apiVersion": "v1", "kind": "ConfigMap",
            "metadata": { "name": format!("settings-{n:05}"), "namespace": format!("team-{}", n % 50),
                "uid": format!("{}-cm", hex(n, 24)), "resourceVersion": format!("{}", 200_000 + n),
                "creationTimestamp": "2026-11-01T10:00:00Z", "labels": { "app": "web" } },
            "data": { "config.yaml": "x: 1\n".repeat(200), "feature-flags": "on,".repeat(100) } })
    }

    /// A Secret with three keys, about two kilobytes, built at run time.
    fn realistic_secret(n: usize) -> serde_json::Value {
        let value = "QUJD".repeat(160);
        json!({ "apiVersion": "v1", "kind": "Secret", "type": "Opaque",
            "metadata": { "name": format!("credentials-{n:05}"), "namespace": format!("team-{}", n % 50),
                "uid": format!("{}-s", hex(n, 24)), "resourceVersion": format!("{}", 300_000 + n),
                "creationTimestamp": "2026-11-01T10:00:00Z" },
            "data": { "one": value, "two": value, "three": value } })
    }

    fn slot_of(group: &str, plural: &str) -> SlotKey {
        SlotKey {
            kind: KindKey {
                group: group.to_string(),
                plural: plural.to_string(),
            },
            namespace: None,
        }
    }

    /// Lists `objects` on a slot whatever its kind.
    fn list_values(
        generation: &Generation,
        slot: &SlotKey,
        objects: impl Iterator<Item = serde_json::Value>,
    ) {
        let resource = deployments().1 .0;
        let stop = CancellationToken::new();
        generation.saw(slot, &resource, Event::Init, &stop);
        for object in objects {
            generation.saw(
                slot,
                &resource,
                Event::InitApply(serde_json::from_value(object).unwrap()),
                &stop,
            );
        }
        generation.saw(slot, &resource, Event::InitDone, &stop);
    }

    /// What the layer keeps of 10 000 pods, `ConfigMaps` and Secrets, beside
    /// what keeping each whole would cost. Fails if a `ConfigMap` or a Secret
    /// is kept between changes, or a pod is kept with what nobody reads.
    /// Run with `--nocapture` for the numbers.
    #[tokio::test]
    async fn ten_thousand_pods_config_maps_and_secrets_keep_what_readers_need() {
        let feeds = feeds();
        let context = feeds.context_for("prod", client().await);
        let _reader = context.join(
            &Ask {
                kinds: vec![
                    slot_of("", "pods").kind,
                    slot_of("", "configmaps").kind,
                    slot_of("", "secrets").kind,
                ],
                scope: None,
                narrow: true,
                binding: Binding::Session,
            },
            &[
                (
                    slot_of("", "pods").kind,
                    (ApiResource::erase::<Pod>(&()), true),
                ),
                (
                    slot_of("", "configmaps").kind,
                    (ApiResource::erase::<ConfigMap>(&()), true),
                ),
                (
                    slot_of("", "secrets").kind,
                    (ApiResource::erase::<Secret>(&()), true),
                ),
            ],
            &[],
        );
        let generation = context.serving();
        let mut report = Vec::new();
        for (slot, build) in [
            (
                slot_of("", "pods"),
                realistic_pod as fn(usize) -> serde_json::Value,
            ),
            (slot_of("", "configmaps"), realistic_config_map),
            (slot_of("", "secrets"), realistic_secret),
        ] {
            let whole: usize = (0..10_000)
                .map(|n| heap_bytes(&build(n)) + std::mem::size_of::<DynamicObject>())
                .sum();
            let whole_json: usize = (0..10_000).map(|n| build(n).to_string().len()).sum();
            list_values(&generation, &slot, (0..10_000).map(build));
            let (heap, json) = resident(&context, &slot);
            report.push(format!(
                "{}: {} MiB whole ({} MiB as JSON), {} MiB kept ({} MiB as JSON)",
                slot.kind.plural,
                whole >> 20,
                whole_json >> 20,
                heap >> 20,
                json >> 20
            ));
            eprintln!("{}", report.last().unwrap());
            match slot.kind.plural.as_str() {
                "pods" => {
                    assert!(heap * 4 < whole, "pods kept as trees");
                    assert!(
                        json * 5 < whole_json * 3,
                        "a pod kept with what nobody reads"
                    );
                }
                _ => assert_eq!(heap, 0, "{} kept between changes", slot.kind.plural),
            }
        }
        eprintln!("feeds, 10 000 each: {}", report.join("; "));
        context.end();
    }

    /// A pod is cut at arrival to what readers read, and readers are handed
    /// the cut copy. Fails if env, probes or mounts are kept, or if what a
    /// map draws from (owners, labels, node, images, ports, status) is lost.
    #[tokio::test]
    async fn a_pod_is_cut_at_arrival_to_what_readers_read() {
        let feeds = feeds();
        let context = feeds.context_for("prod", client().await);
        let pods = slot_of("", "pods");
        let mut sub = context.join(
            &Ask {
                kinds: vec![pods.kind.clone()],
                scope: None,
                narrow: true,
                binding: Binding::Session,
            },
            &[(pods.kind.clone(), (ApiResource::erase::<Pod>(&()), true))],
            &[],
        );
        list_values(&context.serving(), &pods, std::iter::once(realistic_pod(7)));
        let handed = drain(&mut sub)
            .into_iter()
            .find_map(|u| match u {
                Update::Whole { objects, .. } => objects.into_iter().next(),
                _ => None,
            })
            .expect("the pod is handed over");
        let container = &handed.data["spec"]["containers"][0];
        assert!(container.get("livenessProbe").is_none() && container.get("args").is_none());
        assert_eq!(
            container["env"],
            json!([
                { "name": "DB_PASSWORD", "valueFrom": { "secretKeyRef": { "name": "web-db", "key": "password" } } },
                { "name": "FEATURE", "valueFrom": { "configMapKeyRef": { "name": "web-flags", "key": "feature", "optional": true } } },
            ])
        );
        assert_eq!(
            container["envFrom"],
            json!([{ "configMapRef": { "name": "web-env" } }])
        );
        assert_eq!(
            container["volumeMounts"][0],
            json!({ "name": "config", "mountPath": "/etc/web" })
        );
        assert_eq!(container["image"], "registry.example.com/team/web:1.4.2");
        assert_eq!(container["ports"][0]["containerPort"], 8080);
        assert_eq!(handed.data["spec"]["nodeName"], "node-7");
        assert_eq!(handed.data["status"]["phase"], "Running");
        assert!(handed.data["status"]["containerStatuses"][0]
            .get("imageID")
            .is_none());
        assert_eq!(
            handed.metadata.owner_references.as_ref().map(Vec::len),
            Some(1)
        );
        assert_eq!(
            handed.metadata.labels.as_ref().map(|l| l["app"].as_str()),
            Some("web")
        );
        context.end();
    }

    /// What a pod reads from a `ConfigMap` or a `Secret` survives the trim as a
    /// reference, on containers and init containers alike, and no literal
    /// value does; an ephemeral container keeps none of it. Would break if a
    /// pod owned by a custom resource lost the edges the map draws from its
    /// environment, or a literal came back with them.
    #[test]
    fn a_trimmed_pod_keeps_the_references_its_containers_read_and_no_literal() {
        let literal = format!("lit-{}", "eral");
        let mut pod: DynamicObject = serde_json::from_value(json!({
            "apiVersion": "v1", "kind": "Pod", "metadata": { "name": "cart-0", "namespace": "shop" },
            "spec": {
                "initContainers": [{ "name": "migrate", "image": "cart:1",
                    "envFrom": [{ "secretRef": { "name": "cart-env" }, "prefix": "DB_" }],
                    "env": [{ "name": "MODE", "value": literal }] }],
                "containers": [{ "name": "cart", "image": "cart:1",
                    "env": [{ "name": "TOKEN", "valueFrom": { "secretKeyRef": { "name": "cart-api", "key": "token" } } },
                            { "name": "LIMIT", "valueFrom": { "resourceFieldRef": { "resource": "limits.memory" } } }],
                    "volumeMounts": [{ "name": "data", "mountPath": "/data", "subPath": "cart", "readOnly": true,
                                       "subPathExpr": "$(POD)" }] }],
                "ephemeralContainers": [{ "name": "debug", "image": "busybox",
                    "envFrom": [{ "secretRef": { "name": "cart-env" } }],
                    "volumeMounts": [{ "name": "data", "mountPath": "/data" }] }]
            }
        }))
        .unwrap();

        trim_pod(&mut pod);

        let spec = &pod.data["spec"];
        assert_eq!(
            spec["initContainers"][0]["envFrom"],
            json!([{ "secretRef": { "name": "cart-env" }, "prefix": "DB_" }])
        );
        assert!(spec["initContainers"][0].get("env").is_none());
        assert_eq!(
            spec["containers"][0]["env"],
            json!([{ "name": "TOKEN", "valueFrom": { "secretKeyRef": { "name": "cart-api", "key": "token" } } }])
        );
        assert_eq!(
            spec["containers"][0]["volumeMounts"],
            json!([{ "name": "data", "mountPath": "/data", "subPath": "cart", "readOnly": true }])
        );
        let debug = &spec["ephemeralContainers"][0];
        assert!(debug.get("envFrom").is_none() && debug.get("volumeMounts").is_none());
        assert!(!pod.data.to_string().contains(&literal));
    }

    fn config_map_list(at: &str, names: &[&str]) -> String {
        let items: Vec<serde_json::Value> = names
            .iter()
            .map(|name| json!({ "metadata": { "name": name, "namespace": "shop", "uid": format!("shop/{name}"), "resourceVersion": "450" }, "data": { "k": "v" } }))
            .collect();
        json!({ "apiVersion": "v1", "kind": "ConfigMapList", "metadata": { "resourceVersion": at }, "items": items }).to_string()
    }

    fn config_map(name: &str, version: &str) -> DynamicObject {
        serde_json::from_value(json!({ "apiVersion": "v1", "kind": "ConfigMap",
            "metadata": { "name": name, "namespace": "shop", "uid": format!("shop/{name}"), "resourceVersion": version } }))
        .unwrap()
    }

    fn config_maps_of(context: &Arc<ContextFeeds>) -> Ask {
        let _ = context;
        Ask {
            kinds: vec![slot_of("", "configmaps").kind],
            scope: None,
            narrow: true,
            binding: Binding::Session,
        }
    }

    async fn whole_within(sub: &mut Subscription) -> Vec<Update> {
        let mut seen = Vec::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while let Ok(Some(update)) = tokio::time::timeout_at(deadline, sub.updates.recv()).await {
            let done = matches!(update, Update::Whole { .. });
            seen.push(update);
            if done {
                break;
            }
        }
        while let Ok(update) = sub.updates.try_recv() {
            seen.push(update);
        }
        seen
    }

    /// A `ConfigMap` is kept by nobody between changes, so a reader joining
    /// late is served its set by one list, not the store and not a second
    /// watch; a change that came while the list was out is handed after it
    /// only where it is newer than the list. Fails if the late reader waits
    /// for good, is handed nothing, or is handed a change the list already held.
    #[tokio::test]
    async fn a_late_reader_of_a_kind_kept_as_nothing_is_served_by_one_list() {
        let (client, hits) = answering(|path, _| {
            if path == "/api/v1/configmaps" {
                (200, config_map_list("500", &["app", "db"]))
            } else {
                failure(404, "NotFound")
            }
        })
        .await;
        let feeds = feeds();
        let context = feeds.context_for("prod", client);
        let maps = (
            slot_of("", "configmaps").kind,
            (ApiResource::erase::<ConfigMap>(&()), true),
        );
        let mut first = context.join(&config_maps_of(&context), std::slice::from_ref(&maps), &[]);
        let generation = context.serving();
        let slot = slot_of("", "configmaps");
        list(&generation, &slot, vec![config_map("app", "100")]);
        drain(&mut first);
        assert_eq!(resident(&context, &slot).0, 0);

        let mut late = context.join(&config_maps_of(&context), &[maps], &[]);
        apply(&generation, &slot, config_map("db", "400"));
        apply(&generation, &slot, config_map("cache", "600"));
        let seen = whole_within(&mut late).await;
        let set = seen.iter().find_map(|u| match u {
            Update::Whole {
                why: Whole::Fresh,
                objects,
                ..
            } => Some(names(objects)),
            _ => None,
        });
        assert_eq!(set, Some(vec!["app".to_string(), "db".to_string()]));
        let after: Vec<String> = seen
            .iter()
            .filter_map(|u| match u {
                Update::Applied { object, .. } => object.metadata.name.clone(),
                _ => None,
            })
            .collect();
        assert_eq!(after, vec!["cache".to_string()]);
        assert_eq!(hits.lock().unwrap().get("/api/v1/configmaps"), Some(&1));
        assert_eq!(
            generation.stops.lock().len(),
            1,
            "a second watch was opened"
        );
        context.end();
    }

    /// A change that waited on a reader's own list is handed only within its
    /// namespaces, as the list is. Fails if a `ConfigMap` edited elsewhere
    /// during the list reaches it, which the Timeline wrote as created.
    #[tokio::test]
    async fn a_change_that_waited_on_a_list_is_handed_only_within_the_readers_namespaces() {
        let (client, _) = answering(|path, _| {
            if path == "/api/v1/configmaps" {
                (200, config_map_list("500", &["app"]))
            } else {
                failure(404, "NotFound")
            }
        })
        .await;
        let feeds = feeds();
        let context = feeds.context_for("prod", client);
        let maps = (
            slot_of("", "configmaps").kind,
            (ApiResource::erase::<ConfigMap>(&()), true),
        );
        let mut first = context.join(&config_maps_of(&context), std::slice::from_ref(&maps), &[]);
        let generation = context.serving();
        let slot = slot_of("", "configmaps");
        list(&generation, &slot, vec![config_map("app", "100")]);
        drain(&mut first);

        let mut ask = config_maps_of(&context);
        ask.scope = Some(vec!["shop".to_string()]);
        let mut late = context.join(&ask, &[maps], &[]);
        let elsewhere: DynamicObject = serde_json::from_value(json!({ "apiVersion": "v1", "kind": "ConfigMap",
            "metadata": { "name": "ledger", "namespace": "payments", "uid": "payments/ledger", "resourceVersion": "600" } }))
        .unwrap();
        apply(&generation, &slot, elsewhere.clone());
        let resource = ApiResource::erase::<ConfigMap>(&());
        generation.saw(
            &slot,
            &resource,
            Event::Delete(elsewhere),
            &CancellationToken::new(),
        );
        apply(&generation, &slot, config_map("cache", "700"));
        let seen = whole_within(&mut late).await;
        let changed: Vec<String> = seen
            .iter()
            .filter_map(|u| match u {
                Update::Applied { object, .. } | Update::Deleted { object, .. } => {
                    object.metadata.name.clone()
                }
                _ => None,
            })
            .collect();
        assert_eq!(changed, vec!["cache".to_string()]);
        context.end();
    }

    /// An API server whose `ConfigMap` list sends its head, half its body,
    /// and nothing more.
    async fn stalled_body() -> Client {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind");
        let url = format!("http://{}", listener.local_addr().expect("addr"));
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 8192];
                    let _ = socket.read(&mut buf).await;
                    let body = config_map_list("500", &["app", "db"]);
                    let head = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = socket.write_all(head.as_bytes()).await;
                    let _ = socket.write_all(&body.as_bytes()[..body.len() / 2]).await;
                    tokio::time::sleep(Duration::from_mins(10)).await;
                });
            }
        });
        Client::try_from(kube::Config::new(url.parse().expect("url"))).expect("client")
    }

    /// A reader's own list whose body stalls is given up within the page's
    /// deadline: the reader is told it failed, and the changes that waited
    /// on it are let go for the next list to hold. Fails if it reads as
    /// listing for good while those changes pile up.
    #[tokio::test]
    async fn a_readers_own_list_whose_body_stalls_reads_as_failed() {
        let feeds = feeds().listing_within(Duration::from_millis(200));
        let context = feeds.context_for("prod", stalled_body().await);
        let maps = (
            slot_of("", "configmaps").kind,
            (ApiResource::erase::<ConfigMap>(&()), true),
        );
        let mut first = context.join(&config_maps_of(&context), std::slice::from_ref(&maps), &[]);
        let generation = context.serving();
        let slot = slot_of("", "configmaps");
        list(&generation, &slot, vec![config_map("app", "100")]);
        drain(&mut first);

        let mut late = context.join(&config_maps_of(&context), &[maps], &[]);
        apply(&generation, &slot, config_map("db", "400"));
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        let mut failed = false;
        while let Ok(Some(update)) = tokio::time::timeout_at(deadline, late.updates.recv()).await {
            if matches!(
                update,
                Update::State {
                    state: FeedState::Failed { .. },
                    ..
                }
            ) {
                failed = true;
                break;
            }
        }
        assert!(failed, "the reader was never told its list failed");
        let waiting: Vec<usize> = context
            .inner
            .lock()
            .subscribers
            .values()
            .filter_map(|sub| sub.pending.get(&slot).map(Vec::len))
            .collect();
        assert_eq!(waiting, vec![0], "what waited on the list is held");
        context.end();
    }

    /// A reader of a kind kept as nothing that falls behind is listed its
    /// set again, there being no store to resend it from.
    #[tokio::test]
    async fn a_reader_that_falls_behind_on_a_kind_kept_as_nothing_is_listed_again() {
        let (client, _) = answering(|path, _| {
            if path == "/api/v1/configmaps" {
                (200, config_map_list("900", &["app", "db", "cache"]))
            } else {
                failure(404, "NotFound")
            }
        })
        .await;
        let feeds = feeds().lingering(LINGER, PAGE_IDLE, 2);
        let context = feeds.context_for("prod", client);
        let maps = (
            slot_of("", "configmaps").kind,
            (ApiResource::erase::<ConfigMap>(&()), true),
        );
        let mut sub = context.join(&config_maps_of(&context), &[maps], &[]);
        let generation = context.serving();
        let slot = slot_of("", "configmaps");
        list(&generation, &slot, vec![config_map("app", "100")]);
        for n in 0..5 {
            apply(&generation, &slot, config_map(&format!("burst-{n}"), "200"));
        }
        drain(&mut sub);
        apply(&generation, &slot, config_map("after", "300"));
        let seen = whole_within(&mut sub).await;
        let set = seen.iter().find_map(|u| match u {
            Update::Whole { objects, .. } => Some(names(objects)),
            _ => None,
        });
        assert_eq!(
            set,
            Some(vec![
                "app".to_string(),
                "cache".to_string(),
                "db".to_string()
            ])
        );
        context.end();
    }
}
