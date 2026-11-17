//! What Audit holds of the kinds it judges whole, followed through the
//! shared feeds: one watch per cluster and kind, however many features
//! read it. Audit opens none of its own.
//!
//! Pods are not followed here: their metadata is the ownership index's.
//! An object is judged once per change of its `resourceVersion`; a change
//! marks its namespace, and only marked namespaces are read again beside
//! their Services, budgets, autoscalers and `LimitRanges`.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use dashmap::DashMap;
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, StatefulSet};
use k8s_openapi::api::autoscaling::v2::HorizontalPodAutoscaler;
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{
    ConfigMap, LimitRange, Pod, PodSpec, PodTemplateSpec, Service, ServiceAccount,
};
use k8s_openapi::api::networking::v1::NetworkPolicy;
use k8s_openapi::api::policy::v1::PodDisruptionBudget;
use k8s_openapi::api::rbac::v1::{ClusterRole, ClusterRoleBinding, Role, RoleBinding};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::{LabelSelector, ObjectMeta};
use kube::api::{Api, DynamicObject};
use kube::discovery::ApiResource;
use kube::Client;
use parking_lot::{Mutex, RwLock};
use tokio::sync::{broadcast, mpsc, oneshot, Notify, Semaphore};
use tokio_util::sync::CancellationToken;

use super::context::{beside, Beside, Defaults, Replicated, Scales};
use super::template::{judge, TemplateFacts};
use super::{is_system, objects, AuditFinding, Subject, Unchecked, Why};
use crate::error::Result;
use crate::feeds::{Ask, Binding, FeedState, Lease, Update};
use crate::ownership::{KindKey, SlotKey};
use crate::resources::OtherPolicies;
use crate::state::{AppEvent, AppState};

const IDLE_AFTER: Duration = Duration::from_mins(3);
const REAP_EVERY: Duration = Duration::from_secs(30);
/// The fastest the page is told to read again under churn.
const ANNOUNCE_EVERY: Duration = Duration::from_secs(1);
/// How often the upgrade rules read again while the page is on screen.
const UPGRADE_EVERY: Duration = Duration::from_mins(2);
/// The page on screen asks at least this often (its slowest re-read, 30 s,
/// and a slow read's grace): longer quiet means it is not on screen.
const ASKED_WITHIN: Duration = Duration::from_secs(45);

/// The kinds Audit reads whole, and whether each lives in a namespace.
pub(super) fn audited() -> Vec<(ApiResource, bool)> {
    vec![
        (ApiResource::erase::<Deployment>(&()), true),
        (ApiResource::erase::<StatefulSet>(&()), true),
        (ApiResource::erase::<DaemonSet>(&()), true),
        (ApiResource::erase::<Job>(&()), true),
        (ApiResource::erase::<CronJob>(&()), true),
        (ApiResource::erase::<PodDisruptionBudget>(&()), true),
        (ApiResource::erase::<HorizontalPodAutoscaler>(&()), true),
        (ApiResource::erase::<NetworkPolicy>(&()), true),
        (ApiResource::erase::<ConfigMap>(&()), true),
        (ApiResource::erase::<ServiceAccount>(&()), true),
        (ApiResource::erase::<LimitRange>(&()), true),
        (ApiResource::erase::<Service>(&()), true),
        (ApiResource::erase::<Role>(&()), true),
        (ApiResource::erase::<RoleBinding>(&()), true),
        (ApiResource::erase::<ClusterRole>(&()), false),
        (ApiResource::erase::<ClusterRoleBinding>(&()), false),
    ]
}

/// Every kind Audit follows through the shared feeds, for as long as its
/// page touches them.
#[must_use]
pub fn feed_ask(scope: Option<Vec<String>>) -> Ask {
    Ask {
        kinds: audited()
            .iter()
            .map(|(resource, _)| key_of(resource))
            .collect(),
        scope,
        narrow: true,
        binding: Binding::Page,
    }
}

pub(super) fn key_of(resource: &ApiResource) -> KindKey {
    KindKey {
        group: resource.group.clone(),
        plural: resource.plural.clone(),
    }
}

/// What one judged object leaves beside its findings for its namespace's rules.
#[derive(Debug, Clone)]
pub(super) enum Body {
    Workload {
        facts: TemplateFacts,
        replicas: Replicated,
    },
    Service(BTreeMap<String, String>),
    Budget(Option<LabelSelector>),
    Autoscaler(Scales),
    Limits(Defaults),
    Account(Option<bool>),
    Policy,
    Plain,
}

#[derive(Debug, Clone)]
pub(super) struct Entry {
    pub subject: Subject,
    pub version: String,
    pub system: bool,
    pub own: Vec<AuditFinding>,
    pub body: Body,
}

/// One namespace's workloads, by uid, as their neighbours judge them.
pub(super) type Besides = HashMap<String, (Vec<AuditFinding>, Vec<Unchecked>)>;

/// Every object read, by uid, and which slot read it.
#[derive(Default)]
pub(super) struct Store {
    pub entries: HashMap<String, Entry>,
    slots: HashMap<SlotKey, HashSet<String>>,
    /// Namespaces whose rules beside their neighbours are to be read again.
    dirty: BTreeSet<String>,
    dirty_all: bool,
    /// Each namespace's findings beside its neighbours, by uid.
    pub beside: HashMap<String, Besides>,
    /// How many objects were judged since the index started.
    pub judged: u64,
    /// How many namespaces were read beside their neighbours since.
    pub besides: u64,
}

impl Store {
    fn touch(&mut self, namespace: Option<&str>) {
        match namespace {
            Some(namespace) => {
                self.dirty.insert(namespace.to_string());
            }
            None => self.dirty_all = true,
        }
    }

    pub(super) fn apply(&mut self, slot: &SlotKey, uid: String, entry: Entry) {
        self.touch(entry.subject.namespace.as_deref());
        self.slots
            .entry(slot.clone())
            .or_default()
            .insert(uid.clone());
        self.entries.insert(uid, entry);
    }

    /// Whether `uid` is held at `version` already, so judging it again
    /// would give what is there.
    pub(super) fn holds(&self, uid: &str, version: &str) -> bool {
        self.entries
            .get(uid)
            .is_some_and(|entry| !version.is_empty() && entry.version == version)
    }

    pub(super) fn delete(&mut self, slot: &SlotKey, uid: &str) {
        if let Some(entry) = self.entries.remove(uid) {
            self.touch(entry.subject.namespace.as_deref());
        }
        if let Some(members) = self.slots.get_mut(slot) {
            members.remove(uid);
        }
    }

    /// Reads the marked namespaces again beside their neighbours: one pass
    /// over the entries, and the rules of the marked namespaces alone.
    pub(super) fn refresh(&mut self, beside_of: &dyn Fn(&[&Entry], &str) -> Beside) {
        let all = std::mem::take(&mut self.dirty_all);
        let marked = std::mem::take(&mut self.dirty);
        if !all && marked.is_empty() {
            return;
        }
        let mut by_namespace: HashMap<&str, Vec<(&String, &Entry)>> = HashMap::new();
        for (uid, entry) in &self.entries {
            let Some(namespace) = entry.subject.namespace.as_deref() else {
                continue;
            };
            if all || marked.contains(namespace) {
                by_namespace
                    .entry(namespace)
                    .or_default()
                    .push((uid, entry));
            }
        }
        let mut found: HashMap<String, Besides> = HashMap::new();
        for (namespace, members) in &by_namespace {
            let entries: Vec<&Entry> = members.iter().map(|(_, entry)| *entry).collect();
            let ns = beside_of(&entries, namespace);
            let judged: Besides = members
                .iter()
                .filter_map(|(uid, entry)| match &entry.body {
                    Body::Workload { facts, replicas } => Some((
                        (*uid).clone(),
                        beside(
                            &entry.subject.kind,
                            &entry.subject.name,
                            facts,
                            *replicas,
                            &ns,
                        ),
                    )),
                    _ => None,
                })
                .collect();
            self.besides += 1;
            found.insert((*namespace).to_string(), judged);
        }
        if all {
            self.beside.clear();
        } else {
            for namespace in &marked {
                self.beside.remove(namespace);
            }
        }
        self.beside.extend(found);
    }
}

fn meta_subject(kind: &str, meta: &ObjectMeta) -> Subject {
    Subject {
        kind: kind.to_string(),
        namespace: meta.namespace.clone(),
        name: meta.name.clone().unwrap_or_default(),
    }
}

fn workload(
    template: Option<&PodTemplateSpec>,
    replicas: Replicated,
    minor: Option<u32>,
) -> (Vec<AuditFinding>, Body) {
    let Some(spec) = template.and_then(|t| t.spec.as_ref()) else {
        return (Vec::new(), Body::Plain);
    };
    let judged = judge(template.and_then(|t| t.metadata.as_ref()), spec, minor);
    (
        judged.findings,
        Body::Workload {
            facts: judged.facts,
            replicas,
        },
    )
}

/// One object as Audit holds it, or `None` for one it skips: a Job its
/// `CronJob` is judged for, or an object that would not parse.
pub(super) fn entry_of(kind: &str, object: DynamicObject, minor: Option<u32>) -> Option<Entry> {
    let meta = object.metadata.clone();
    let version = meta.resource_version.clone().unwrap_or_default();
    let subject = meta_subject(kind, &meta);
    let mut installers = false;
    let (own, body) = match kind {
        "Deployment" => {
            let it: Deployment = object.try_parse().ok()?;
            let spec = it.spec.as_ref();
            let replicas = Replicated(Some(spec.and_then(|s| s.replicas).unwrap_or(1)));
            workload(spec.map(|s| &s.template), replicas, minor)
        }
        "StatefulSet" => {
            let it: StatefulSet = object.try_parse().ok()?;
            let spec = it.spec.as_ref();
            let replicas = Replicated(Some(spec.and_then(|s| s.replicas).unwrap_or(1)));
            workload(spec.map(|s| &s.template), replicas, minor)
        }
        "DaemonSet" => {
            let it: DaemonSet = object.try_parse().ok()?;
            workload(
                it.spec.as_ref().map(|s| &s.template),
                Replicated(None),
                minor,
            )
        }
        "Job" => {
            let controlled_by_cron = meta
                .owner_references
                .iter()
                .flatten()
                .any(|owner| owner.controller == Some(true) && owner.kind == "CronJob");
            if controlled_by_cron {
                return None;
            }
            let it: Job = object.try_parse().ok()?;
            workload(
                it.spec.as_ref().map(|s| &s.template),
                Replicated(None),
                minor,
            )
        }
        "CronJob" => {
            let it: CronJob = object.try_parse().ok()?;
            let template = it
                .spec
                .as_ref()
                .and_then(|s| s.job_template.spec.as_ref())
                .map(|s| &s.template);
            workload(template, Replicated(None), minor)
        }
        "PodDisruptionBudget" => {
            let it: PodDisruptionBudget = object.try_parse().ok()?;
            let selector = it.spec.as_ref().and_then(|s| s.selector.clone());
            (objects::budget(&it), Body::Budget(selector))
        }
        "HorizontalPodAutoscaler" => {
            let it: HorizontalPodAutoscaler = object.try_parse().ok()?;
            let spec = it.spec.as_ref()?;
            let scales = Scales {
                name: subject.name.clone(),
                kind: spec.scale_target_ref.kind.clone(),
                target: spec.scale_target_ref.name.clone(),
                min: spec.min_replicas.unwrap_or(1),
            };
            (objects::autoscaler(&it), Body::Autoscaler(scales))
        }
        "NetworkPolicy" => (Vec::new(), Body::Policy),
        "ConfigMap" => {
            let it: ConfigMap = object.try_parse().ok()?;
            (objects::config_map(&it), Body::Plain)
        }
        "ServiceAccount" => {
            if subject.name != "default" {
                return None;
            }
            let it: ServiceAccount = object.try_parse().ok()?;
            (
                Vec::new(),
                Body::Account(it.automount_service_account_token),
            )
        }
        "LimitRange" => {
            let it: LimitRange = object.try_parse().ok()?;
            (Vec::new(), Body::Limits(Defaults::of([&it])))
        }
        "Service" => {
            let it: Service = object.try_parse().ok()?;
            let selector = it.spec.and_then(|s| s.selector).unwrap_or_default();
            (Vec::new(), Body::Service(selector))
        }
        "Role" => {
            let it: Role = object.try_parse().ok()?;
            (objects::role(it.rules.as_ref()), Body::Plain)
        }
        "ClusterRole" => {
            let it: ClusterRole = object.try_parse().ok()?;
            (objects::role(it.rules.as_ref()), Body::Plain)
        }
        "RoleBinding" => {
            let it: RoleBinding = object.try_parse().ok()?;
            let found = objects::binding(
                &it.role_ref,
                it.subjects.as_ref(),
                meta.namespace.as_deref(),
            );
            (found, Body::Plain)
        }
        "ClusterRoleBinding" => {
            let it: ClusterRoleBinding = object.try_parse().ok()?;
            installers = objects::an_installers_own(&it);
            (
                objects::binding(&it.role_ref, it.subjects.as_ref(), None),
                Body::Plain,
            )
        }
        _ => return None,
    };
    Some(Entry {
        system: installers || is_system(&subject, meta.labels.as_ref()),
        subject,
        version,
        own,
        body,
    })
}

/// A pod read whole because nothing Audit judges stamped it: one with no
/// controller, or a controller of a kind Audit does not read.
#[derive(Debug, Clone)]
pub(super) struct PodJudged {
    pub subject: Subject,
    pub system: bool,
    pub own: Vec<AuditFinding>,
    pub facts: TemplateFacts,
}

/// A pod read whole, or why it is not yet.
#[derive(Debug, Clone)]
pub(super) enum PodRead {
    /// The read is on its way.
    Reading,
    Judged(PodJudged),
    /// The cluster did not hand it over: said with the namespace's unread
    /// kinds, and asked again once `POD_READ_AGAIN` has passed.
    Unread {
        namespace: String,
        why: Why,
        at: Instant,
    },
}

/// How long a pod the cluster would not hand over is said not checked
/// before it is asked for again.
pub(super) const POD_READ_AGAIN: Duration = Duration::from_secs(30);

/// How one pod is judged: on its own, or for the controller that stamped it.
#[must_use]
pub(super) fn pod_judged(pod: &Pod, minor: Option<u32>) -> Option<PodJudged> {
    let spec: &PodSpec = pod.spec.as_ref()?;
    let judged = judge(Some(&pod.metadata), spec, minor);
    let controller = pod
        .metadata
        .owner_references
        .iter()
        .flatten()
        .find(|owner| owner.controller == Some(true) && owner.kind != "Node");
    let subject = match controller {
        Some(owner) => Subject {
            kind: owner.kind.clone(),
            namespace: pod.metadata.namespace.clone(),
            name: owner.name.clone(),
        },
        None => meta_subject("Pod", &pod.metadata),
    };
    Some(PodJudged {
        system: is_system(&subject, None),
        subject,
        own: judged.findings,
        facts: judged.facts,
    })
}

pub struct AuditIndex {
    pub(super) context: String,
    client: Client,
    stop: CancellationToken,
    /// Held while the page asks; dropping the index lets the feeds go.
    lease: Mutex<Option<Lease>>,
    /// To the reader: move the feeds to these namespaces, and say when what
    /// they handed for them is taken.
    recuts: Mutex<Option<mpsc::UnboundedSender<Recut>>>,
    scope: Mutex<Option<Vec<String>>>,
    last_used: Mutex<Instant>,
    /// Each audited kind's name, by the key the feeds hand it under.
    kinds: HashMap<KindKey, String>,
    /// How each slot the feeds hand over is read.
    states: Mutex<BTreeMap<SlotKey, FeedState>>,
    pub(super) minor: Option<u32>,
    pub(super) store: RwLock<Store>,
    pub(super) revision: AtomicU64,
    changed: Arc<Notify>,
    /// Pods read whole, by the key they are held under: `pod/<uid>` or
    /// `controller/<uid>`.
    pub(super) pods: Mutex<HashMap<String, PodRead>>,
    pub(super) pod_reads: Arc<Semaphore>,
    /// The upgrade rules' last pass; `None` before the first ends.
    pub(super) upgrade: RwLock<Option<Arc<super::upgrade::Read>>>,
    /// Other engines' policy kinds that may hold over each namespace's pods,
    /// and the scope they were read for; `None` before the first read.
    pub(super) others: RwLock<Option<(Option<Vec<String>>, OtherPolicies)>>,
    /// The webhooks that may change pods on admission; `None` before the
    /// first read.
    pub(super) admission: RwLock<Option<super::admitted::Admission>>,
    /// The scope moved: the upgrade rules read again at once.
    rescoped: Notify,
    /// The reader asked again: a source that failed is read at once.
    again: Notify,
    /// The page asked: an upgrade pass held while it was off screen goes.
    asked: Notify,
}

impl AuditIndex {
    fn new(
        context: String,
        client: Client,
        scope: Option<Vec<String>>,
        minor: Option<u32>,
    ) -> Self {
        Self {
            context,
            client,
            stop: CancellationToken::new(),
            lease: Mutex::new(None),
            recuts: Mutex::new(None),
            scope: Mutex::new(scope),
            last_used: Mutex::new(Instant::now()),
            kinds: audited()
                .iter()
                .map(|(resource, _)| (key_of(resource), resource.kind.clone()))
                .collect(),
            states: Mutex::new(BTreeMap::new()),
            minor,
            store: RwLock::new(Store::default()),
            revision: AtomicU64::new(0),
            changed: Arc::new(Notify::new()),
            pods: Mutex::new(HashMap::new()),
            pod_reads: Arc::new(Semaphore::new(4)),
            upgrade: RwLock::new(None),
            others: RwLock::new(None),
            admission: RwLock::new(None),
            rescoped: Notify::new(),
            again: Notify::new(),
            asked: Notify::new(),
        }
    }

    /// How every slot the feeds handed over reads now.
    pub(super) fn slot_states(&self) -> BTreeMap<SlotKey, FeedState> {
        self.states.lock().clone()
    }

    /// The page asked again, in `scope`. Where that moved, the feeds are
    /// moved with it, and this returns once the reader has taken what they
    /// handed, so the answer read next is never the old namespaces' set
    /// read as the new ones'.
    async fn asked_again(&self, scope: Option<Vec<String>>) {
        *self.last_used.lock() = Instant::now();
        self.asked.notify_one();
        let moved = {
            let mut held = self.scope.lock();
            let moved = *held != scope;
            held.clone_from(&scope);
            moved
        };
        if let Some(lease) = self.lease.lock().as_ref() {
            lease.touch();
        }
        if !moved {
            return;
        }
        let (taken, done) = oneshot::channel();
        let sent = self
            .recuts
            .lock()
            .as_ref()
            .is_some_and(|recuts| recuts.send((scope, taken)).is_ok());
        if sent {
            let _ = done.await;
        }
        self.rescoped.notify_one();
    }

    fn changed(&self) {
        self.revision.fetch_add(1, Ordering::Relaxed);
        self.changed.notify_one();
    }

    /// One object of `slot` as the feeds hand it: judged again only where
    /// its version moved.
    fn hold(&self, store: &mut Store, slot: &SlotKey, object: &DynamicObject) -> Option<String> {
        let uid = object.metadata.uid.clone()?;
        let version = object.metadata.resource_version.clone().unwrap_or_default();
        if store.holds(&uid, &version) {
            store
                .slots
                .entry(slot.clone())
                .or_default()
                .insert(uid.clone());
            return Some(uid);
        }
        let kind = self.kinds.get(&slot.kind)?;
        match entry_of(kind, object.clone(), self.minor) {
            Some(entry) => {
                store.judged += 1;
                store.apply(slot, uid.clone(), entry);
            }
            None => store.delete(slot, &uid),
        }
        Some(uid)
    }

    /// What the feeds say, taken into the store.
    pub(super) fn take(&self, update: Update) {
        match update {
            Update::Whole { slot, objects, .. } => {
                let mut store = self.store.write();
                let listed: HashSet<String> = objects
                    .iter()
                    .filter_map(|object| self.hold(&mut store, &slot, object))
                    .collect();
                // What the slot held and the set does not was deleted meanwhile.
                let held = store.slots.get(&slot).cloned().unwrap_or_default();
                for uid in held.difference(&listed) {
                    store.delete(&slot, uid);
                }
                store.dirty_all = true;
            }
            Update::Applied { slot, object } => {
                self.hold(&mut self.store.write(), &slot, &object);
            }
            Update::Deleted { slot, object } => {
                if let Some(uid) = object.metadata.uid.as_deref() {
                    self.store.write().delete(&slot, uid);
                }
            }
            Update::State { slot, state } => {
                self.states.lock().insert(slot, state);
                self.store.write().dirty_all = true;
            }
            Update::HandedOver => return,
        }
        self.changed();
    }

    /// Reads one pod whole and judges it, at most a few at once.
    pub(super) fn read_pod(self: &Arc<Self>, key: String, namespace: String, name: String) {
        {
            let mut pods = self.pods.lock();
            if matches!(pods.get(&key), Some(PodRead::Reading | PodRead::Judged(_))) {
                return;
            }
            pods.insert(key.clone(), PodRead::Reading);
        }
        let index = self.clone();
        tokio::spawn(async move {
            let Ok(_permit) = index.pod_reads.clone().acquire_owned().await else {
                return;
            };
            if index.stop.is_cancelled() {
                return;
            }
            let api: Api<Pod> = Api::namespaced(index.client.clone(), &namespace);
            let read = tokio::select! {
                biased;
                () = index.stop.cancelled() => return,
                read = api.get_opt(&name) => read,
            };
            let held = match read {
                Ok(found) => {
                    let Some(judged) = found.as_ref().and_then(|pod| pod_judged(pod, index.minor))
                    else {
                        // Gone: asked again if it is seen again.
                        index.pods.lock().remove(&key);
                        return;
                    };
                    PodRead::Judged(judged)
                }
                Err(error) => {
                    let error: crate::error::Error = error.into();
                    PodRead::Unread {
                        namespace,
                        why: super::why_of(&error),
                        at: Instant::now(),
                    }
                }
            };
            index.pods.lock().insert(key, held);
            index.changed();
        });
    }
}

/// Why a kind is not read in `namespace`, from the slots the feeds handed
/// over: `None` where it is (a blind read is read, and said late
/// elsewhere). `namespace` is `None` for a cluster-scoped kind.
#[must_use]
pub(super) fn why_unread(
    slots: &BTreeMap<SlotKey, FeedState>,
    kind: &KindKey,
    namespace: Option<&str>,
) -> Option<Why> {
    let of = |state: &FeedState| match state {
        FeedState::Synced | FeedState::Blind { .. } => None,
        FeedState::Syncing => Some(Why::Reading),
        FeedState::Queued => Some(Why::Queued),
        FeedState::Failed { message } => Some(Why::Failed {
            message: message.clone(),
        }),
        FeedState::Refused { message } => Some(Why::Refused {
            message: message.clone(),
        }),
        FeedState::Unserved => Some(Why::Unserved),
    };
    let whole = slots.get(&SlotKey {
        kind: kind.clone(),
        namespace: None,
    });
    match whole {
        None => Some(Why::Reading),
        Some(FeedState::Refused { message }) => {
            let Some(namespace) = namespace else {
                return Some(Why::Refused {
                    message: message.clone(),
                });
            };
            match slots.get(&SlotKey {
                kind: kind.clone(),
                namespace: Some(namespace.to_string()),
            }) {
                Some(state) => of(state),
                None => Some(Why::Refused {
                    message: message.clone(),
                }),
            }
        }
        Some(state) => of(state),
    }
}

pub struct AuditIndexes {
    clusters: Arc<DashMap<String, Arc<AuditIndex>>>,
    events: broadcast::Sender<AppEvent>,
    /// What a detail page read of its namespace, kept a little while so
    /// walking from object to object does not list it again.
    pub(super) besides: DashMap<(String, String), (Instant, Arc<Beside>)>,
    /// Each cluster's namespaces that enforce a Pod Security level, and when read.
    pub(super) enforced: DashMap<String, (Instant, Vec<super::Enforced>)>,
    /// What the upgrade rules decoded per cluster, kept across visits so a
    /// return to the page fetches only what changed.
    decoded: DashMap<String, Arc<tokio::sync::Mutex<super::upgrade::Decoded>>>,
    /// How many times each context's client was let go, and all of them:
    /// a read that began before is not kept after.
    eras: DashMap<String, u64>,
    all_eras: std::sync::atomic::AtomicU64,
}

impl AuditIndexes {
    #[must_use]
    pub fn new(events: broadcast::Sender<AppEvent>) -> Self {
        Self {
            clusters: Arc::new(DashMap::new()),
            events,
            besides: DashMap::new(),
            enforced: DashMap::new(),
            decoded: DashMap::new(),
            eras: DashMap::new(),
            all_eras: std::sync::atomic::AtomicU64::new(0),
        }
    }

    /// Which of `context`'s clients a read begins on, to be asked again
    /// before what it found is kept.
    pub(super) fn era(&self, context: &str) -> (u64, u64) {
        (
            self.all_eras.load(Ordering::SeqCst),
            self.eras.get(context).map_or(0, |era| *era),
        )
    }

    /// Keeps what a read of `context`'s namespace that began at `era` found,
    /// unless the client it read through was let go meanwhile.
    pub(super) fn keep_beside(&self, era: (u64, u64), key: (String, String), read: Arc<Beside>) {
        if self.era(&key.0) == era {
            self.besides.insert(key, (Instant::now(), read));
        }
    }

    /// Keeps the Pod Security labels read of `context` at `era`, as above.
    pub(super) fn keep_enforced(&self, era: (u64, u64), context: &str, read: Vec<super::Enforced>) {
        if self.era(context) == era {
            self.enforced
                .insert(context.to_string(), (Instant::now(), read));
        }
    }

    /// The current cluster's index, started on the first call: only the
    /// Audit page asks this. It follows its kinds through the shared feeds,
    /// page-bound, and touches its lease each time it is asked.
    pub(super) async fn ensure(
        &self,
        state: &AppState,
        here: &crate::state::Here<'_>,
        scope: Option<Vec<String>>,
        minor: Option<u32>,
    ) -> Result<Arc<AuditIndex>> {
        let context = here.context.clone();
        if let Some(index) = self.clusters.get(&context).map(|held| held.clone()) {
            index.asked_again(scope).await;
            return Ok(index);
        }
        let index = Arc::new(AuditIndex::new(
            context.clone(),
            (*here.client).clone(),
            scope.clone(),
            minor,
        ));
        let subscription = state.feeds.subscribe(here, feed_ask(scope)).await?;
        let index = self
            .clusters
            .entry(context.clone())
            .or_insert(index)
            .clone();
        let mut lease = index.lease.lock();
        if lease.is_some() {
            return Ok(index.clone());
        }
        *lease = Some(subscription.lease);
        drop(lease);
        spawn_reader(index.clone(), subscription.updates);
        let decoded = self.decoded.entry(context.clone()).or_default().clone();
        spawn_upgrade(
            index.clone(),
            state.client_manager.clone(),
            state.port_forward_sessions.clone(),
            decoded,
        );
        spawn_announcer(index.clone(), self.events.clone());
        spawn_reaper(self.clusters.clone(), context, index.clone());
        Ok(index)
    }

    /// Reads the upgrade rules' sources again at once, where the page has
    /// the index running: what a reader asks for after a source came back.
    pub fn read_again(&self, context: &str) {
        if let Some(index) = self.running(context) {
            index.again.notify_one();
        }
    }

    /// A context's index where one is already running; none is started.
    #[must_use]
    pub fn running(&self, context: &str) -> Option<Arc<AuditIndex>> {
        self.clusters.get(context).map(|held| held.clone())
    }

    pub fn forget(&self, context: &str) {
        self.decoded.remove(context);
        self.renewed(context);
    }

    /// The context's client was renewed: the index on the old one stops, and
    /// the releases decoded, which hold no client and are kept by each
    /// Secret's `resourceVersion`, are kept for the next.
    pub fn renewed(&self, context: &str) {
        *self.eras.entry(context.to_string()).or_default() += 1;
        self.besides.retain(|(held, _), _| held != context);
        self.enforced.remove(context);
        if let Some((_, index)) = self.clusters.remove(context) {
            index.stop.cancel();
            index.lease.lock().take();
        }
    }

    pub fn forget_all(&self) {
        self.all_eras.fetch_add(1, Ordering::SeqCst);
        self.besides.clear();
        self.enforced.clear();
        self.decoded.clear();
        for entry in self.clusters.iter() {
            entry.stop.cancel();
            entry.lease.lock().take();
        }
        self.clusters.clear();
    }
}

type Recut = (Option<Vec<String>>, oneshot::Sender<()>);

/// Takes what the feeds say into the index until either lets go.
fn spawn_reader(index: Arc<AuditIndex>, mut updates: mpsc::Receiver<Update>) {
    let (recuts, mut recut) = mpsc::unbounded_channel::<Recut>();
    *index.recuts.lock() = Some(recuts);
    tokio::spawn(async move {
        loop {
            tokio::select! {
                biased;
                () = index.stop.cancelled() => break,
                Some((scope, taken)) = recut.recv() => {
                    if let Some(lease) = index.lease.lock().as_ref() {
                        lease.rescope(scope);
                    }
                    while let Ok(update) = updates.try_recv() {
                        index.take(update);
                    }
                    let _ = taken.send(());
                }
                update = updates.recv() => match update {
                    Some(update) => index.take(update),
                    None => break,
                },
            }
        }
    });
}

/// Reads the upgrade rules' kinds on start, every few minutes after, and
/// at once when the scope moves.
fn spawn_upgrade(
    index: Arc<AuditIndex>,
    clients: Arc<crate::client::K8sClientManager>,
    tunnels: Arc<DashMap<String, crate::state::PortForwardSession>>,
    decoded: Arc<tokio::sync::Mutex<super::upgrade::Decoded>>,
) {
    tokio::spawn(async move {
        loop {
            let scope = index.scope.lock().clone();
            let prometheus = prometheus_of(&index.context, &tunnels).await;
            let mut decoded = decoded.lock().await;
            let pass = super::upgrade::read(
                &index.client,
                clients.served(),
                &index.context,
                scope.as_deref(),
                index.minor,
                &mut decoded,
                &prometheus,
            );
            let read = tokio::select! {
                biased;
                () = index.stop.cancelled() => break,
                read = pass => read,
            };
            drop(decoded);
            let discovery = crate::commands::other_policies::Discovery {
                served: clients.served(),
                context: &index.context,
            };
            let others = tokio::select! {
                biased;
                () = index.stop.cancelled() => break,
                others = others_over(discovery, &index.client, scope.as_deref()) => others,
            };
            let admission = tokio::select! {
                biased;
                () = index.stop.cancelled() => break,
                admission = super::admitted::read(&index.client, scope.as_deref()) => admission,
            };
            *index.admission.write() = Some(admission);
            *index.others.write() = Some((scope, others));
            *index.upgrade.write() = Some(Arc::new(read));
            index.changed();
            if !next_pass(&index, UPGRADE_EVERY, ASKED_WITHIN).await {
                break;
            }
        }
    });
}

/// The other engines' policy kinds that may hold over `scope`'s pods: read
/// across the cluster where the scope is, else a namespace at a time, as the
/// `NetworkPolicy` screens read them for a reader bound to namespaces.
async fn others_over(
    discovery: crate::commands::other_policies::Discovery<'_>,
    client: &Client,
    scope: Option<&[String]>,
) -> OtherPolicies {
    let Some(names) = scope else {
        return discovery.other_policies(client, None).await;
    };
    let reads = futures::future::join_all(
        names
            .iter()
            .map(|namespace| discovery.other_policies(client, Some(namespace))),
    )
    .await;
    let mut others = OtherPolicies::none();
    for (namespace, found) in names.iter().zip(reads) {
        for kind in found.over(namespace) {
            others.within(namespace, &kind);
        }
    }
    others
}

/// This cluster's Prometheus as Settings holds it, read again each pass so
/// one connected while the page is open is asked from the next.
async fn prometheus_of(
    context: &str,
    tunnels: &DashMap<String, crate::state::PortForwardSession>,
) -> super::deprecated::Prometheus {
    use super::deprecated::Prometheus;
    match crate::integrations::prometheus::connection_for(context, tunnels).await {
        Ok(None) => Prometheus::NotConnected,
        Ok(Some(Ok(entry))) => Prometheus::Connected(entry),
        Ok(Some(Err(reason))) => Prometheus::Unusable(Why::Failed { message: reason }),
        Err(error) => Prometheus::Unusable(super::why_of(&error)),
    }
}

/// Waits for the next upgrade pass: a few minutes on, or at once when the
/// scope moves, and never while the page is off screen. A page on screen
/// asks every half minute at the slowest; when it stops asking, the pass
/// waits for it to ask again. `false` once the index stops.
async fn next_pass(index: &AuditIndex, every: Duration, asked_within: Duration) -> bool {
    tokio::select! {
        biased;
        () = index.stop.cancelled() => return false,
        () = index.rescoped.notified() => return true,
        () = index.again.notified() => return true,
        () = tokio::time::sleep(every) => {}
    }
    while index.last_used.lock().elapsed() > asked_within {
        tokio::select! {
            biased;
            () = index.stop.cancelled() => return false,
            () = index.asked.notified() => {}
        }
    }
    true
}

/// Tells the page to read again after a change, at most once a second.
fn spawn_announcer(index: Arc<AuditIndex>, events: broadcast::Sender<AppEvent>) {
    tokio::spawn(async move {
        loop {
            tokio::select! {
                biased;
                () = index.stop.cancelled() => break,
                () = index.changed.notified() => {}
            }
            tokio::select! {
                biased;
                () = index.stop.cancelled() => break,
                () = tokio::time::sleep(ANNOUNCE_EVERY) => {}
            }
            let _ = events.send(AppEvent::AuditChanged {
                context: index.context.clone(),
                revision: index.revision.load(Ordering::Relaxed),
            });
        }
    });
}

fn spawn_reaper(
    clusters: Arc<DashMap<String, Arc<AuditIndex>>>,
    context: String,
    index: Arc<AuditIndex>,
) {
    tokio::spawn(async move {
        loop {
            tokio::select! {
                biased;
                () = index.stop.cancelled() => break,
                () = tokio::time::sleep(REAP_EVERY) => {}
            }
            if index.last_used.lock().elapsed() > IDLE_AFTER {
                tracing::info!(context, "audit idle; its feeds let go");
                clusters.remove_if(&context, |_, held| Arc::ptr_eq(held, &index));
                index.stop.cancel();
                index.lease.lock().take();
                break;
            }
        }
    });
}

#[cfg(test)]
impl AuditIndex {
    /// An index no feed serves, every audited kind read and empty: the test
    /// hands it what the feeds would.
    pub(super) fn holding(client: Client, scope: Option<Vec<String>>) -> Arc<Self> {
        let mut index = Self::new("test".to_string(), client, scope, Some(32));
        index.pod_reads = Arc::new(Semaphore::new(0));
        *index.others.write() = Some((None, OtherPolicies::none()));
        *index.admission.write() =
            Some(super::admitted::Admission::of(Vec::new(), BTreeMap::new()));
        let index = Arc::new(index);
        for (resource, _) in audited() {
            index.set(&resource, None, FeedState::Synced);
        }
        index
    }

    pub(super) fn set(&self, resource: &ApiResource, namespace: Option<&str>, state: FeedState) {
        self.take(Update::State {
            slot: SlotKey {
                kind: key_of(resource),
                namespace: namespace.map(str::to_string),
            },
            state,
        });
    }

    pub(super) fn stop_for_test(&self) {
        self.stop.cancel();
    }

    /// A change the feed of `resource` across the cluster would hand over.
    pub(super) fn feed(&self, resource: &ApiResource, object: serde_json::Value) {
        let slot = SlotKey {
            kind: key_of(resource),
            namespace: None,
        };
        let object: DynamicObject = serde_json::from_value(object).expect("an object");
        self.take(Update::Applied {
            slot,
            object: Arc::new(object),
        });
    }

    /// The whole set the feed of `resource` would hand over after a relist.
    pub(super) fn relist(&self, resource: &ApiResource, objects: Vec<serde_json::Value>) {
        let slot = SlotKey {
            kind: key_of(resource),
            namespace: None,
        };
        let objects = objects
            .into_iter()
            .map(|object| Arc::new(serde_json::from_value(object).expect("an object")))
            .collect();
        self.take(Update::Whole {
            slot,
            why: crate::feeds::Whole::Relist,
            objects,
        });
    }
}

#[cfg(test)]
pub(super) mod tests {
    use serde_json::{json, Value};

    use super::*;
    use crate::audit::answer::{page, world, AuditQuery, AuditRow, Grouping, Owners};
    use crate::audit::RuleId;
    use crate::client::served::test_server::answering;
    use crate::ownership::ClusterIndex;
    use crate::state::perf::{wire_len, IPC_TARGET_BYTES};

    pub(crate) async fn client() -> Client {
        answering(|_, _| (404, "{}".to_string())).await.0
    }

    pub(crate) fn deployment(namespace: &str, name: &str, version: &str, image: &str) -> Value {
        json!({
            "apiVersion": "apps/v1", "kind": "Deployment",
            "metadata": { "name": name, "namespace": namespace, "uid": format!("{namespace}-{name}"), "resourceVersion": version },
            "spec": {
                "replicas": 3,
                "selector": { "matchLabels": { "app": name } },
                "template": {
                    "metadata": { "labels": { "app": name } },
                    "spec": {
                        "containers": [
                            { "name": "app", "image": image, "env": [{ "name": "DB_PASSWORD", "value": "x-y-z" }] },
                            { "name": "proxy", "image": "envoy:v1.30.1", "securityContext": { "privileged": true } },
                            { "name": "metrics", "image": "exporter", "resources": { "requests": { "cpu": "10m" } } }
                        ]
                    }
                }
            }
        })
    }

    pub(crate) fn deployments() -> ApiResource {
        ApiResource::erase::<Deployment>(&())
    }

    fn query(by: Grouping) -> AuditQuery {
        AuditQuery {
            by,
            categories: Vec::new(),
            severities: Vec::new(),
            rules: Vec::new(),
            rule: None,
            system: false,
            offset: 0,
            limit: None,
        }
    }

    /// 500 Deployments of three containers in 50 namespaces, 20 pods each:
    /// 10 000 pods the ownership index holds. Fails if the first read is
    /// slow, if one change judges more than its object or reads more than
    /// its namespace, or if any page is over the IPC target. Run with
    /// `--nocapture` for the numbers.
    #[tokio::test]
    async fn ten_thousand_pods_under_five_hundred_workloads_stay_proportional_and_in_budget() {
        let client = client().await;
        let index = AuditIndex::holding(client.clone(), None);
        let owners = ClusterIndex::holding(client, &[]);
        let pods = KindKey {
            group: String::new(),
            plural: "pods".to_string(),
        };
        let sets = KindKey {
            group: "apps".to_string(),
            plural: "replicasets".to_string(),
        };
        let started = Instant::now();
        for n in 0..500 {
            let namespace = format!("team-{}", n % 50);
            let name = format!("web-{n}");
            index.feed(
                &deployments(),
                deployment(&namespace, &name, "1", "registry.local/web:1.0"),
            );
            let set_uid = format!("rs-{n}");
            owners.hold(
                &sets,
                "ReplicaSet",
                &set_uid,
                (&format!("{name}-7d9f"), Some(&namespace)),
                Some(&format!("{namespace}-{name}")),
            );
            for p in 0..20 {
                owners.hold(
                    &pods,
                    "Pod",
                    &format!("pod-{n}-{p}"),
                    (&format!("{name}-7d9f-{p}"), Some(&namespace)),
                    Some(&set_uid),
                );
            }
        }
        let fed = started.elapsed();
        let owners: Owners<'_> = Ok(&owners);
        let started = Instant::now();
        let seen = world(&index, owners, None);
        let first = started.elapsed();
        let (judged, besides) = {
            let store = index.store.read();
            (store.judged, store.besides)
        };
        assert_eq!(judged, 500);
        assert_eq!(
            seen.unattributed + seen.reading,
            0,
            "every pod is its Deployment's"
        );

        let mut biggest = 0;
        let mut pages = 0;
        for by in [Grouping::Rule, Grouping::Object] {
            let mut q = query(by);
            loop {
                let answer = page(&seen, &q, 1, Vec::new());
                biggest = biggest.max(wire_len(&answer));
                pages += 1;
                match answer.next {
                    Some(next) => q.offset = next,
                    None => break,
                }
            }
        }
        for rule in [
            RuleId::EnvSecretLiteral,
            RuleId::PssPrivileged,
            RuleId::NoCpuRequest,
        ] {
            let mut q = query(Grouping::Rule);
            q.rule = Some(rule);
            loop {
                let answer = page(&seen, &q, 1, Vec::new());
                biggest = biggest.max(wire_len(&answer));
                pages += 1;
                match answer.next {
                    Some(next) => q.offset = next,
                    None => break,
                }
            }
        }

        index.feed(
            &deployments(),
            deployment("team-7", "web-7", "2", "registry.local/web:latest"),
        );
        let started = Instant::now();
        let again = world(&index, owners, None);
        let after_one = started.elapsed();
        let store = index.store.read();
        eprintln!(
            "audit 500 workloads / 10 000 pods: judged in {fed:?}, first answer {first:?}, \
             answer after one change {after_one:?}, {pages} pages, largest {biggest} bytes"
        );
        assert_eq!(
            store.judged - judged,
            1,
            "one change judged more than its object"
        );
        assert_eq!(
            store.besides - besides,
            1,
            "one change read more than its namespace"
        );
        assert!(biggest < IPC_TARGET_BYTES, "a page of {biggest} bytes");
        assert!(again.objects.iter().any(|o| o.subject.name == "web-7"
            && o.findings.iter().any(|f| f.rule == RuleId::ImageTagLatest)));
        assert!(first < Duration::from_secs(2) && after_one < Duration::from_secs(2));
    }

    /// The upgrade rules' re-read is bound to the page: due every few minutes
    /// while the page asks, held while it has not asked for longer than an
    /// on-screen page waits, and released by the next ask. Would break if
    /// the pass kept reading a cluster for a page nobody has on screen.
    #[tokio::test]
    async fn the_upgrade_pass_waits_while_the_page_is_off_screen() {
        let (every, within) = (Duration::from_millis(40), Duration::from_millis(400));
        let index = AuditIndex::holding(client().await, None);
        let on_screen = tokio::spawn({
            let index = index.clone();
            async move { next_pass(&index, every, within).await }
        });
        tokio::time::sleep(every * 10).await;
        assert!(on_screen.is_finished(), "a page on screen is read again");

        *index.last_used.lock() = Instant::now().checked_sub(within * 2).expect("an instant");
        let off_screen = tokio::spawn({
            let index = index.clone();
            async move { next_pass(&index, every, within).await }
        });
        tokio::time::sleep(every * 5).await;
        assert!(!off_screen.is_finished(), "a page off screen is not read");

        *index.last_used.lock() = Instant::now();
        index.asked.notify_one();
        let released = tokio::time::timeout(Duration::from_secs(1), off_screen).await;
        assert!(released.expect("the ask releases it").expect("joined"));
    }

    /// A reader asking again after a source came back is read at once, not
    /// at the next pass minutes on. Fails if "ask again" waited out the
    /// interval, which leaves a failed line standing.
    #[tokio::test]
    async fn asking_again_reads_the_sources_at_once() {
        let index = AuditIndex::holding(client().await, None);
        let waiting = tokio::spawn({
            let index = index.clone();
            async move { next_pass(&index, Duration::from_secs(600), Duration::from_secs(600)).await }
        });
        tokio::task::yield_now().await;
        index.again.notify_one();
        let read = tokio::time::timeout(Duration::from_secs(1), waiting).await;
        assert!(read.expect("read at once").expect("joined"));
    }

    /// Every `Deployment`, `StatefulSet`, `Pod` and `CronJob` in the Audit fixture,
    /// as it would be judged once applied.
    fn fixture_templates() -> Vec<(String, DynamicObject)> {
        use serde::Deserialize;
        const FIXTURE: &str = include_str!("../../../../tests/manifests/audit.yaml");
        serde_yaml::Deserializer::from_str(FIXTURE)
            .filter_map(|document| {
                let value = Value::deserialize(document).ok()?;
                let kind = value["kind"].as_str()?.to_string();
                ["Deployment", "StatefulSet", "Pod", "CronJob"]
                    .contains(&kind.as_str())
                    .then(|| (kind, serde_json::from_value(value).expect("an object")))
            })
            .collect()
    }

    fn pod_spec(kind: &str, object: &DynamicObject) -> Value {
        match kind {
            "Pod" => object.data["spec"].clone(),
            "CronJob" => object.data["spec"]["jobTemplate"]["spec"]["template"]["spec"].clone(),
            _ => object.data["spec"]["template"]["spec"].clone(),
        }
    }

    /// The fixture is what a real API server takes and a real kubelet does
    /// not loop on: with `hostNetwork` each host port equals its container
    /// port, and a template the kubelet rejects for an unsafe sysctl makes
    /// no pods, since its controller makes another for every rejected one.
    /// It still breaks what it was written to break. Fails if the fixture
    /// is refused on apply, floods the cluster, or stops showing the rules.
    #[test]
    fn the_audit_fixture_applies_runs_no_rejected_pods_and_still_breaks_its_rules() {
        let mut tripped: Vec<(String, RuleId)> = Vec::new();
        for (kind, object) in fixture_templates() {
            let name = object.metadata.name.clone().unwrap_or_default();
            let spec = pod_spec(&kind, &object);
            if spec["hostNetwork"] == json!(true) {
                for container in spec["containers"].as_array().into_iter().flatten() {
                    for port in container["ports"].as_array().into_iter().flatten() {
                        if let Some(host) = port.get("hostPort") {
                            assert_eq!(Some(host), port.get("containerPort"), "{name}");
                        }
                    }
                }
            }
            let own = if kind == "Pod" {
                let pod: Pod = object.clone().try_parse().expect("a pod");
                pod_judged(&pod, Some(37)).expect("judged").own
            } else {
                entry_of(&kind, object.clone(), Some(37))
                    .expect("judged")
                    .own
            };
            let rejected = own.iter().any(|f| f.rule == RuleId::PssSysctls);
            if rejected {
                let makes_none = match kind.as_str() {
                    "CronJob" => object.data["spec"]["suspend"] == json!(true),
                    "Pod" => false,
                    _ => object.data["spec"]["replicas"] == json!(0),
                };
                assert!(
                    makes_none,
                    "{name} would be made again for every rejected pod"
                );
            }
            tripped.extend(own.iter().map(|f| (name.clone(), f.rule)));
        }
        for (name, rule) in [
            ("everything-wrong", RuleId::PssHostPorts),
            ("everything-wrong", RuleId::PssPrivileged),
            ("everything-wrong", RuleId::PssHostNamespaces),
            ("everything-wrong", RuleId::RuntimeSocket),
            ("everything-wrong", RuleId::EnvSecretLiteral),
            ("kernel-and-volumes", RuleId::PssSysctls),
            ("kernel-and-volumes", RuleId::PssSelinux),
            ("kernel-and-volumes", RuleId::PssVolumeTypes),
            ("as-root", RuleId::PssRunAsUserRoot),
        ] {
            assert!(
                tripped.contains(&(name.to_string(), rule)),
                "{name} no longer breaks {rule:?}"
            );
        }
    }

    /// The same object seen again at the same version is not judged again.
    /// Fails if a resync, which re-applies every object, judges the cluster.
    #[tokio::test]
    async fn an_object_seen_again_at_its_version_is_not_judged_again() {
        let index = AuditIndex::holding(client().await, None);
        index.feed(&deployments(), deployment("shop", "web", "5", "web:1"));
        index.feed(&deployments(), deployment("shop", "web", "5", "web:1"));
        assert_eq!(index.store.read().judged, 1);
        index.feed(&deployments(), deployment("shop", "web", "6", "web:1"));
        assert_eq!(index.store.read().judged, 2);
    }

    /// A `CronJob`'s runs are judged on the `CronJob`. Fails if every run's Job
    /// is judged again beside it.
    #[test]
    fn a_job_its_cronjob_runs_is_judged_on_the_cronjob() {
        let job: DynamicObject = serde_json::from_value(json!({
            "apiVersion": "batch/v1", "kind": "Job",
            "metadata": { "name": "nightly-29001", "namespace": "ops", "uid": "j1",
                "ownerReferences": [{ "apiVersion": "batch/v1", "kind": "CronJob", "name": "nightly", "uid": "c1", "controller": true }] },
            "spec": { "template": { "spec": { "containers": [{ "name": "run", "image": "x" }] } } }
        }))
        .unwrap();
        assert!(entry_of("Job", job, Some(32)).is_none());
    }

    /// Across the cluster refused, a namespace of the selection is read on
    /// its own; one outside it is still refused. Fails if a namespace nobody
    /// read is taken for read, or one that was is not.
    #[test]
    fn a_kind_refused_across_the_cluster_reads_as_its_namespaces_read_it() {
        let kind = key_of(&deployments());
        let mut slots = BTreeMap::new();
        let refused = FeedState::Refused {
            message: "forbidden".to_string(),
        };
        slots.insert(
            SlotKey {
                kind: kind.clone(),
                namespace: None,
            },
            refused,
        );
        slots.insert(
            SlotKey {
                kind: kind.clone(),
                namespace: Some("shop".to_string()),
            },
            FeedState::Synced,
        );
        assert_eq!(why_unread(&slots, &kind, Some("shop")), None);
        let shop = SlotKey {
            kind: kind.clone(),
            namespace: Some("shop".to_string()),
        };
        slots.insert(shop.clone(), FeedState::Syncing);
        assert_eq!(why_unread(&slots, &kind, Some("shop")), Some(Why::Reading));
        slots.insert(shop, FeedState::Synced);
        assert!(matches!(
            why_unread(&slots, &kind, Some("billing")),
            Some(Why::Refused { .. })
        ));
        assert!(matches!(
            why_unread(&slots, &kind, None),
            Some(Why::Refused { .. })
        ));
        slots.insert(
            SlotKey {
                kind: kind.clone(),
                namespace: Some("shop".to_string()),
            },
            FeedState::Blind {
                since: "2026-11-14T10:00:00Z".to_string(),
            },
        );
        assert_eq!(why_unread(&slots, &kind, Some("shop")), None);
    }

    /// Moved to a namespace the feeds already watch, the page reads what it
    /// holds at once: the feeds hand it, and the answer waits until the
    /// reader has taken it. Fails if a namespace added to the scope reads as
    /// holding nothing, which Audit said of it until the next break.
    #[tokio::test]
    async fn a_namespace_added_to_the_scope_is_read_with_what_it_holds() {
        use crate::ownership::slots::SlotHost;
        use kube::runtime::watcher::Event;
        let client = client().await;
        let feeds =
            crate::feeds::Feeds::new((Arc::new(Semaphore::new(0)), Arc::new(Semaphore::new(0))));
        let shop = Some(vec!["shop".to_string()]);
        let index = AuditIndex::holding(client.clone(), shop.clone());
        let subscription = feeds.joined("prod", client, &feed_ask(shop));
        *index.lease.lock() = Some(subscription.lease);
        spawn_reader(index.clone(), subscription.updates);
        let generation = feeds.context("prod").expect("a context").serving();
        let slot = SlotKey {
            kind: key_of(&deployments()),
            namespace: None,
        };
        let never = CancellationToken::new();
        generation.saw(&slot, &deployments(), Event::Init, &never);
        for (namespace, name) in [("shop", "web"), ("payments", "api")] {
            let object = serde_json::from_value(deployment(namespace, name, "1", "web:1"))
                .expect("an object");
            generation.saw(&slot, &deployments(), Event::InitApply(object), &never);
        }
        generation.saw(&slot, &deployments(), Event::InitDone, &never);
        let held = |index: &AuditIndex| -> Vec<String> {
            let mut names: Vec<String> = index
                .store
                .read()
                .entries
                .values()
                .map(|entry| entry.subject.name.clone())
                .collect();
            names.sort();
            names
        };
        tokio::task::yield_now().await;
        assert_eq!(held(&index), vec!["web"]);
        index.asked_again(Some(vec!["payments".to_string()])).await;
        assert_eq!(held(&index), vec!["api"]);
        index.stop.cancel();
    }

    /// A read that began on a client let go meanwhile is not kept: every
    /// later read of the namespace would take the old client's answer.
    /// Fails if a neighbour read in flight across a reconnect is kept.
    #[test]
    fn a_read_begun_before_the_client_was_let_go_is_not_kept() {
        let (events, _) = broadcast::channel(4);
        let indexes = AuditIndexes::new(events);
        let key = ("prod".to_string(), "shop".to_string());
        let unread = || {
            Arc::new(Beside {
                namespace: "shop".to_string(),
                services: Err(Why::Reading),
                budgets: Err(Why::Reading),
                autoscalers: Err(Why::Reading),
                limits: Err(Why::Reading),
                account: Err(Why::Reading),
            })
        };
        let before = indexes.era("prod");
        indexes.forget("prod");
        indexes.keep_beside(before, key.clone(), unread());
        indexes.keep_enforced(before, "prod", Vec::new());
        assert!(indexes.besides.is_empty() && indexes.enforced.is_empty());
        let other = indexes.era("staging");
        indexes.forget_all();
        indexes.keep_enforced(other, "staging", Vec::new());
        assert!(indexes.enforced.is_empty());
        indexes.keep_beside(indexes.era("prod"), key, unread());
        assert_eq!(indexes.besides.len(), 1);
    }

    /// A renewal keeps the releases Audit decoded; a reconnect, which may put
    /// another cluster behind the name, lets them go. Fails if every token
    /// renewal sent the page back to reading and fetching each release.
    #[test]
    fn a_renewal_keeps_the_releases_decoded_and_a_reconnect_does_not() {
        let (events, _) = broadcast::channel(4);
        let indexes = AuditIndexes::new(events);
        indexes.decoded.entry("prod".to_string()).or_default();
        indexes.renewed("prod");
        assert!(
            indexes.decoded.contains_key("prod"),
            "a renewal let them go"
        );
        indexes.forget("prod");
        assert!(!indexes.decoded.contains_key("prod"));
    }

    /// A relist hands the whole set again; what the index held and the set
    /// lacks was deleted while nobody watched. Fails if a Deployment deleted
    /// during a break stays judged.
    #[tokio::test]
    async fn a_relist_drops_what_was_deleted_while_nobody_watched() {
        let index = AuditIndex::holding(client().await, None);
        index.feed(&deployments(), deployment("shop", "web", "1", "web:1"));
        index.feed(&deployments(), deployment("shop", "gone", "1", "web:1"));
        index.relist(
            &deployments(),
            vec![deployment("shop", "web", "1", "web:1")],
        );
        let store = index.store.read();
        let names: Vec<&str> = store
            .entries
            .values()
            .map(|entry| entry.subject.name.as_str())
            .collect();
        assert_eq!(names, vec!["web"]);
        assert_eq!(store.judged, 2, "the unchanged one was judged again");
    }

    /// The answer's rows are what the page draws.
    #[test]
    fn an_answer_row_names_its_shape() {
        let row = AuditRow::Rule {
            rule: RuleId::PssPrivileged,
            worst: Some(crate::audit::AuditSeverity::High),
            objects: 1,
            unchecked: 0,
        };
        let wire = serde_json::to_value(row).unwrap();
        assert_eq!(wire["row"], "rule");
        assert_eq!(wire["rule"], "pss-privileged");
    }
}
