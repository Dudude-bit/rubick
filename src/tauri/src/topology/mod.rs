//! The cluster map's held lists, per context: what a watch source hands it,
//! kept stripped, and how well each kind and namespace was read.
//!
//! The map holds no watch of its own. A source feeds [`Feed`]s into a
//! [`ClusterMap`]; every stream drawing that cluster reads its lists from
//! here and rebuilds a namespace when a feed touched it.

mod feed;
mod stream;

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use chrono::{DateTime, Utc};
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, ReplicaSet, StatefulSet};
use k8s_openapi::api::autoscaling::v2::HorizontalPodAutoscaler;
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{Event, PersistentVolumeClaim, Pod, Service};
use k8s_openapi::api::discovery::v1::EndpointSlice;
use k8s_openapi::api::networking::v1::{Ingress, NetworkPolicy};
use k8s_openapi::api::policy::v1::PodDisruptionBudget;
use kube::Resource;
use parking_lot::RwLock;
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;

use crate::commands::connections::map::{Held, Named};
use crate::resources::topology::{MapKindReading, MapKindState};
use crate::resources::{GatewayInfo, ListenerSetInfo, OtherPolicies, RouteInfo, UnexploredKind};

pub use feed::{ask, pump, types_of, Resolve, RESOLVE_AGAIN};
pub use stream::{run, Drawn, Opening, Reread, SessionCheck, ASK_AT_MOST, TOUCH_EVERY};

/// How one slot of a kind is being read, as the watch layer says it.
pub use crate::feeds::FeedState as Reading;

/// What a source hands the map, in order.
#[derive(Debug, Clone)]
pub enum Feed {
    Applied(Object),
    Deleted(Object),
    /// A relist of one slot, marked: what it holds now, whole.
    Relisted {
        kind: Kind,
        namespace: Option<String>,
        objects: Vec<Object>,
    },
    Read {
        kind: Kind,
        namespace: Option<String>,
        reading: Reading,
    },
}

/// Which namespaces a feed changed; `all` where a cluster-wide slot did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Touched {
    pub namespaces: BTreeSet<String>,
    pub all: bool,
    /// A kind's reading changed, which the rail draws.
    pub reads: bool,
}

impl Touched {
    pub fn merge(&mut self, other: Touched) {
        self.namespaces.extend(other.namespaces);
        self.all |= other.all;
        self.reads |= other.reads;
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.namespaces.is_empty() && !self.all && !self.reads
    }
}

macro_rules! kinds {
    ($($variant:ident($ty:ty) => $field:ident, $name:literal, $version:literal;)*) => {
        /// The kinds the map reads.
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub enum Kind { $($variant),* }

        impl Kind {
            pub const ALL: &'static [Kind] = &[$(Kind::$variant),*];

            #[must_use]
            pub fn name(self) -> &'static str {
                match self { $(Kind::$variant => $name),* }
            }

            #[must_use]
            pub fn version(self) -> &'static str {
                match self { $(Kind::$variant => $version),* }
            }
        }

        /// One object as the map keeps it.
        #[derive(Debug, Clone)]
        pub enum Object { $($variant(Box<$ty>)),* }

        impl Object {
            #[must_use]
            pub fn kind(&self) -> Kind {
                match self { $(Object::$variant(_) => Kind::$variant),* }
            }

            fn key(&self) -> (String, String) {
                match self { $(Object::$variant(object) => key_of(object.as_ref())),* }
            }
        }

        #[derive(Default)]
        struct Objects { $($field: BTreeMap<(String, String), Arc<$ty>>),* }

        impl Objects {
            fn put(&mut self, object: Object) {
                let key = object.key();
                match object { $(Object::$variant(object) => { self.$field.insert(key, Arc::from(object)); }),* }
            }

            fn remove(&mut self, object: &Object) {
                let key = object.key();
                match object { $(Object::$variant(_) => { self.$field.remove(&key); }),* }
            }

            /// Drops every object of `kind`, in `namespace` or everywhere, and
            /// names the namespaces it held them in.
            fn clear(&mut self, kind: Kind, namespace: Option<&str>) -> BTreeSet<String> {
                match kind { $(Kind::$variant => drain(&mut self.$field, namespace)),* }
            }

            /// Every namespace any object of any kind was read in.
            fn seen(&self) -> BTreeSet<String> {
                let mut seen = BTreeSet::new();
                $(seen.extend(self.$field.keys().map(|(ns, _)| ns.clone()));)*
                seen.remove("");
                seen
            }
        }
    };
}

kinds! {
    Namespace(Named) => namespaces, "Namespace", "v1";
    Pod(Pod) => pods, "Pod", "v1";
    Deployment(Deployment) => deployments, "Deployment", "apps/v1";
    StatefulSet(StatefulSet) => stateful_sets, "StatefulSet", "apps/v1";
    DaemonSet(DaemonSet) => daemon_sets, "DaemonSet", "apps/v1";
    ReplicaSet(ReplicaSet) => replica_sets, "ReplicaSet", "apps/v1";
    Job(Job) => jobs, "Job", "batch/v1";
    CronJob(CronJob) => cron_jobs, "CronJob", "batch/v1";
    Service(Service) => services, "Service", "v1";
    EndpointSlice(EndpointSlice) => slices, "EndpointSlice", "discovery.k8s.io/v1";
    Ingress(Ingress) => ingresses, "Ingress", "networking.k8s.io/v1";
    Claim(PersistentVolumeClaim) => claims, "PersistentVolumeClaim", "v1";
    Autoscaler(HorizontalPodAutoscaler) => autoscalers, "HorizontalPodAutoscaler", "autoscaling/v2";
    Budget(PodDisruptionBudget) => budgets, "PodDisruptionBudget", "policy/v1";
    Policy(NetworkPolicy) => policies, "NetworkPolicy", "networking.k8s.io/v1";
    Event(Event) => warnings, "Event", "v1";
    ConfigMap(Named) => config_maps, "ConfigMap", "v1";
    Secret(Named) => secrets, "Secret", "v1";
    ServiceAccount(Named) => accounts, "ServiceAccount", "v1";
    HttpRoute(RouteInfo) => http_routes, "HTTPRoute", "gateway.networking.k8s.io/v1";
    GrpcRoute(RouteInfo) => grpc_routes, "GRPCRoute", "gateway.networking.k8s.io/v1";
    TlsRoute(RouteInfo) => tls_routes, "TLSRoute", "gateway.networking.k8s.io/v1alpha2";
    TcpRoute(RouteInfo) => tcp_routes, "TCPRoute", "gateway.networking.k8s.io/v1alpha2";
    UdpRoute(RouteInfo) => udp_routes, "UDPRoute", "gateway.networking.k8s.io/v1alpha2";
    Gateway(GatewayInfo) => gateways, "Gateway", "gateway.networking.k8s.io/v1";
    ListenerSet(ListenerSetInfo) => listener_sets, "ListenerSet", "gateway.networking.k8s.io/v1";
}

impl Kind {
    /// Whether one of these changing changes what other namespaces draw: a
    /// route names Gateways and Services across namespaces, and the set of
    /// namespaces is the map itself.
    #[must_use]
    pub fn reaches_across(self) -> bool {
        self.optional() || self == Kind::Namespace
    }

    /// The Gateway API kinds, which a cluster may simply not serve.
    #[must_use]
    pub fn optional(self) -> bool {
        matches!(
            self,
            Kind::HttpRoute
                | Kind::GrpcRoute
                | Kind::TlsRoute
                | Kind::TcpRoute
                | Kind::UdpRoute
                | Kind::Gateway
                | Kind::ListenerSet
        )
    }
}

fn key_of<K: KeyOf>(object: &K) -> (String, String) {
    object.key_of()
}

trait KeyOf {
    fn key_of(&self) -> (String, String);
}

impl<K: Resource> KeyOf for K {
    fn key_of(&self) -> (String, String) {
        let meta = self.meta();
        (
            meta.namespace.clone().unwrap_or_default(),
            meta.name.clone().unwrap_or_default(),
        )
    }
}

impl KeyOf for Named {
    fn key_of(&self) -> (String, String) {
        (self.namespace.clone(), self.name.clone())
    }
}

impl KeyOf for RouteInfo {
    fn key_of(&self) -> (String, String) {
        (self.namespace.clone(), self.name.clone())
    }
}

impl KeyOf for GatewayInfo {
    fn key_of(&self) -> (String, String) {
        (self.namespace.clone(), self.name.clone())
    }
}

impl KeyOf for ListenerSetInfo {
    fn key_of(&self) -> (String, String) {
        (self.namespace.clone(), self.name.clone())
    }
}

fn drain<V>(
    map: &mut BTreeMap<(String, String), Arc<V>>,
    namespace: Option<&str>,
) -> BTreeSet<String> {
    let mut held = BTreeSet::new();
    map.retain(|(ns, _), _| {
        let goes = namespace.is_none_or(|only| only == ns);
        if goes {
            held.insert(ns.clone());
        }
        !goes
    });
    held
}

const LAST_APPLIED: &str = "kubectl.kubernetes.io/last-applied-configuration";
/// A Helm release's own record, held as a Secret: never one a workload names.
const HELM_RELEASE: &str = "helm.sh/release.v1";

fn stripped_meta(meta: &mut kube::core::ObjectMeta) {
    meta.managed_fields = None;
    if let Some(annotations) = meta.annotations.as_mut() {
        annotations.remove(LAST_APPLIED);
    }
}

fn named(meta: &kube::core::ObjectMeta) -> Named {
    Named {
        namespace: meta.namespace.clone().unwrap_or_default(),
        name: meta.name.clone().unwrap_or_default(),
        labels: meta.labels.clone().unwrap_or_default(),
    }
}

impl Object {
    /// A `ConfigMap` as the map keeps it: its name and labels, never its data.
    #[must_use]
    pub fn config_map(map: &k8s_openapi::api::core::v1::ConfigMap) -> Self {
        Object::ConfigMap(Box::new(named(&map.metadata)))
    }

    /// A Secret's name and labels; `None` for a Helm release record.
    #[must_use]
    pub fn secret(secret: &k8s_openapi::api::core::v1::Secret) -> Option<Self> {
        (secret.type_.as_deref() != Some(HELM_RELEASE))
            .then(|| Object::Secret(Box::new(named(&secret.metadata))))
    }

    #[must_use]
    pub fn service_account(account: &k8s_openapi::api::core::v1::ServiceAccount) -> Self {
        Object::ServiceAccount(Box::new(named(&account.metadata)))
    }

    #[must_use]
    pub fn namespace(namespace: &k8s_openapi::api::core::v1::Namespace) -> Self {
        Object::Namespace(Box::new(named(&namespace.metadata)))
    }

    /// A Warning event, stripped; `None` for any other.
    #[must_use]
    pub fn warning(mut event: Event) -> Option<Self> {
        (event.type_.as_deref() == Some("Warning")).then(|| {
            stripped_meta(&mut event.metadata);
            Object::Event(Box::new(event))
        })
    }

    /// A pod as the watch layer cut it: what a pod with no workload above it
    /// uses is read off its own spec, so its volumes and the references its
    /// containers name are kept.
    #[must_use]
    pub fn pod(mut pod: Pod) -> Self {
        stripped_meta(&mut pod.metadata);
        Object::Pod(Box::new(pod))
    }

    /// Any other object, without its managed fields and last-applied copy.
    #[must_use]
    pub fn stripped(mut self) -> Self {
        match &mut self {
            Object::Deployment(o) => stripped_meta(&mut o.metadata),
            Object::StatefulSet(o) => stripped_meta(&mut o.metadata),
            Object::DaemonSet(o) => stripped_meta(&mut o.metadata),
            Object::ReplicaSet(o) => stripped_meta(&mut o.metadata),
            Object::Job(o) => stripped_meta(&mut o.metadata),
            Object::CronJob(o) => stripped_meta(&mut o.metadata),
            Object::Service(o) => stripped_meta(&mut o.metadata),
            Object::EndpointSlice(o) => stripped_meta(&mut o.metadata),
            Object::Ingress(o) => stripped_meta(&mut o.metadata),
            Object::Claim(o) => stripped_meta(&mut o.metadata),
            Object::Autoscaler(o) => stripped_meta(&mut o.metadata),
            Object::Budget(o) => stripped_meta(&mut o.metadata),
            Object::Policy(o) => stripped_meta(&mut o.metadata),
            _ => {}
        }
        self
    }
}

/// One cluster's held lists and the readings of their slots.
#[derive(Default)]
pub struct Stores {
    objects: Objects,
    reads: BTreeMap<(Kind, Option<String>), Reading>,
    /// Fed only the namespaces a scope names: no list here is the cluster's.
    scoped: bool,
}

/// A kind's answer in one namespace.
enum Answer {
    Read,
    /// The cluster's words, and the code a reader tells a refusal by.
    Unread(String, &'static str),
    NotServed,
}

const REFUSED: &str = "PERMISSION_DENIED";
const UNANSWERED: &str = "NO_ANSWER";

impl Stores {
    /// Takes one feed; the namespaces it changed.
    pub fn apply(&mut self, feed: Feed) -> Touched {
        let mut touched = Touched::default();
        let across = match &feed {
            Feed::Applied(object) | Feed::Deleted(object) => object.kind(),
            Feed::Relisted { kind, .. } | Feed::Read { kind, .. } => *kind,
        }
        .reaches_across();
        match feed {
            Feed::Applied(object) => {
                touched.namespaces.insert(object.key().0);
                self.objects.put(object);
            }
            Feed::Deleted(object) => {
                touched.namespaces.insert(object.key().0);
                self.objects.remove(&object);
            }
            Feed::Relisted {
                kind,
                namespace,
                objects,
            } => {
                touched.namespaces = self.objects.clear(kind, namespace.as_deref());
                for object in objects.into_iter().filter(|object| object.kind() == kind) {
                    touched.namespaces.insert(object.key().0);
                    self.objects.put(object);
                }
            }
            Feed::Read {
                kind,
                namespace,
                reading,
            } => {
                let slot = (kind, namespace.clone());
                if self.reads.get(&slot) != Some(&reading) {
                    touched.reads = true;
                    match namespace {
                        Some(namespace) => {
                            touched.namespaces.insert(namespace);
                        }
                        None => touched.all = true,
                    }
                    self.reads.insert(slot, reading);
                }
            }
        }
        if across && (touched.all || touched.reads || !touched.namespaces.is_empty()) {
            touched.all = true;
        }
        touched.namespaces.remove("");
        touched
    }

    fn answer(&self, kind: Kind, namespace: &str) -> Answer {
        let cluster = self.reads.get(&(kind, None));
        if matches!(cluster, Some(Reading::Synced | Reading::Blind { .. })) {
            return Answer::Read;
        }
        if let Some(here) = self.reads.get(&(kind, Some(namespace.to_string()))) {
            return Self::answer_of(kind, here);
        }
        // No reading at all is a kind still waiting for a watch: the layer
        // says `Unserved` of every kind the cluster does not serve.
        match cluster {
            Some(reading) => Self::answer_of(kind, reading),
            None => Answer::Unread(String::new(), UNANSWERED),
        }
    }

    /// A slot's reading as an answer. A kind the cluster does not serve is
    /// none of it only where that is a finding: Gateway API not installed.
    /// An `EndpointSlice` a cluster does not serve is a list not read.
    fn answer_of(kind: Kind, reading: &Reading) -> Answer {
        match reading {
            Reading::Synced | Reading::Blind { .. } => Answer::Read,
            Reading::Refused { message } => Answer::Unread(message.clone(), REFUSED),
            Reading::Failed { message } => Answer::Unread(message.clone(), UNANSWERED),
            Reading::Unserved if kind.optional() => Answer::NotServed,
            Reading::Unserved | Reading::Syncing | Reading::Queued => {
                Answer::Unread(String::new(), UNANSWERED)
            }
        }
    }

    fn read_in<V: Clone>(
        &self,
        kind: Kind,
        map: &BTreeMap<(String, String), Arc<V>>,
        namespace: &str,
    ) -> std::result::Result<Vec<V>, crate::resources::ListUnread> {
        match self.answer(kind, namespace) {
            Answer::Read => Ok(map
                .range((namespace.to_string(), String::new())..)
                .take_while(|((ns, _), _)| ns == namespace)
                .map(|(_, object)| object.as_ref().clone())
                .collect()),
            Answer::Unread(said, code) => Err(crate::resources::ListUnread { code, said }),
            Answer::NotServed => Ok(Vec::new()),
        }
    }

    fn said_in<V: Clone>(
        &self,
        kind: Kind,
        map: &BTreeMap<(String, String), Arc<V>>,
        namespace: &str,
    ) -> std::result::Result<Vec<V>, String> {
        self.read_in(kind, map, namespace)
            .map_err(|unread| unread.said)
    }

    fn everywhere<V: Clone>(map: &BTreeMap<(String, String), Arc<V>>) -> Vec<V> {
        map.values().map(|object| object.as_ref().clone()).collect()
    }

    /// One namespace's lists, as the map builds from them. A kind still
    /// listing is unread with no words of its own: the rail names it by its
    /// reading.
    #[must_use]
    pub fn held(&self, namespace: &str, others: OtherPolicies, now: DateTime<Utc>) -> Held {
        let o = &self.objects;
        let mut routes = Vec::new();
        let mut routes_read = Vec::new();
        let mut gateway_unread = Vec::new();
        for (kind, map) in [
            (Kind::HttpRoute, &o.http_routes),
            (Kind::GrpcRoute, &o.grpc_routes),
            (Kind::TlsRoute, &o.tls_routes),
            (Kind::TcpRoute, &o.tcp_routes),
            (Kind::UdpRoute, &o.udp_routes),
        ] {
            match self.answer(kind, namespace) {
                Answer::Read => {
                    routes.extend(Self::everywhere(map));
                    routes_read.push(kind.name());
                }
                Answer::NotServed => {}
                Answer::Unread(said, _) => {
                    gateway_unread.push(UnexploredKind::unanswered(
                        kind.name(),
                        kind.version(),
                        &said,
                    ));
                }
            }
        }
        let merged = |mut gateways: Vec<GatewayInfo>| {
            let sets = matches!(self.answer(Kind::ListenerSet, namespace), Answer::Read)
                .then(|| Self::everywhere(&o.listener_sets));
            for gateway in &mut gateways {
                gateway.merge_listener_sets(sets.as_deref());
            }
            gateways
        };
        // Every Gateway, or none: a route's parent is ordinarily in another
        // namespace, and a list of only some would call every Gateway
        // outside it missing. Only the whole cluster's slot, fed unscoped,
        // is every Gateway.
        let gateways = (!self.scoped
            && matches!(
                self.reads.get(&(Kind::Gateway, None)),
                Some(Reading::Synced | Reading::Blind { .. })
            ))
        .then(|| merged(Self::everywhere(&o.gateways)));
        // Every set, or none, by the same rule: a route's set may stand in
        // a namespace the scope left out. A cluster that serves none has none.
        let listener_sets = (!self.scoped)
            .then(|| self.reads.get(&(Kind::ListenerSet, None)))
            .flatten()
            .and_then(|reading| match reading {
                Reading::Synced | Reading::Blind { .. } => Some(Self::everywhere(&o.listener_sets)),
                Reading::Unserved => Some(Vec::new()),
                _ => None,
            });
        let gateways_here = match self.answer(Kind::Gateway, namespace) {
            Answer::Read => Some(merged(
                o.gateways
                    .range((namespace.to_string(), String::new())..)
                    .take_while(|((ns, _), _)| ns == namespace)
                    .map(|(_, gateway)| gateway.as_ref().clone())
                    .collect(),
            )),
            Answer::NotServed => None,
            Answer::Unread(said, _) => {
                gateway_unread.push(UnexploredKind::unanswered(
                    "Gateway",
                    Kind::Gateway.version(),
                    &said,
                ));
                None
            }
        };
        Held {
            namespace: namespace.to_string(),
            pods: self.said_in(Kind::Pod, &o.pods, namespace),
            services: self.said_in(Kind::Service, &o.services, namespace),
            ingresses: self.said_in(Kind::Ingress, &o.ingresses, namespace),
            claims: self.said_in(Kind::Claim, &o.claims, namespace),
            autoscalers: self.said_in(Kind::Autoscaler, &o.autoscalers, namespace),
            budgets: self.said_in(Kind::Budget, &o.budgets, namespace),
            deployments: self.said_in(Kind::Deployment, &o.deployments, namespace),
            stateful_sets: self.said_in(Kind::StatefulSet, &o.stateful_sets, namespace),
            daemon_sets: self.said_in(Kind::DaemonSet, &o.daemon_sets, namespace),
            replica_sets: self.said_in(Kind::ReplicaSet, &o.replica_sets, namespace),
            jobs: self.said_in(Kind::Job, &o.jobs, namespace),
            cron_jobs: self.said_in(Kind::CronJob, &o.cron_jobs, namespace),
            warnings: self.said_in(Kind::Event, &o.warnings, namespace),
            policies: self.read_in(Kind::Policy, &o.policies, namespace),
            others,
            slices: self.said_in(Kind::EndpointSlice, &o.slices, namespace),
            config_maps: self.said_in(Kind::ConfigMap, &o.config_maps, namespace),
            secrets: self.said_in(Kind::Secret, &o.secrets, namespace),
            accounts: self.said_in(Kind::ServiceAccount, &o.accounts, namespace),
            gateway_routes: routes,
            gateways,
            gateways_here,
            listener_sets,
            routes_read,
            gateway_unread,
            taken_at: now,
        }
    }

    /// The namespaces the map draws for `scope`: those named, or every one
    /// the cluster listed — and where it would not list them, every one an
    /// object was read in.
    #[must_use]
    pub fn namespaces(&self, scope: Option<&[String]>) -> BTreeSet<String> {
        if let Some(scope) = scope {
            return scope.iter().cloned().collect();
        }
        if matches!(
            self.reads.get(&(Kind::Namespace, None)),
            Some(Reading::Synced | Reading::Blind { .. })
        ) {
            return self
                .objects
                .namespaces
                .keys()
                .map(|(_, name)| name.clone())
                .collect();
        }
        // Any kind read in a namespace says it is there: a StatefulSet
        // scaled to zero, or a lone CronJob or Ingress, as much as a pod.
        self.objects.seen()
    }

    /// Whether any kind is still waiting for its first answer, one the
    /// layer has said nothing of yet included.
    #[must_use]
    pub fn syncing(&self) -> bool {
        Kind::ALL
            .iter()
            .any(|kind| !self.reads.keys().any(|(of, _)| of == kind))
            || self
                .reads
                .values()
                .any(|reading| matches!(reading, Reading::Syncing | Reading::Queued))
    }

    /// Whether any kind's read failed or went stale, which an expired
    /// session looks like from here.
    #[must_use]
    pub fn failing(&self) -> bool {
        self.reads
            .values()
            .any(|reading| matches!(reading, Reading::Failed { .. } | Reading::Blind { .. }))
    }

    /// How each kind is read, for the rail.
    #[must_use]
    pub fn kinds(&self) -> Vec<MapKindState> {
        Kind::ALL
            .iter()
            .filter(|kind| **kind != Kind::Namespace)
            .map(|&kind| MapKindState {
                kind: kind.name().to_string(),
                reading: self.reading_of(kind),
            })
            .collect()
    }

    fn reading_of(&self, kind: Kind) -> MapKindReading {
        let read_in: Vec<String> = self
            .reads
            .iter()
            .filter(|((of, ns), reading)| {
                *of == kind
                    && ns.is_some()
                    && matches!(reading, Reading::Synced | Reading::Blind { .. })
            })
            .filter_map(|((_, ns), _)| ns.clone())
            .collect();
        match self.reads.get(&(kind, None)) {
            Some(Reading::Synced) => MapKindReading::Live,
            Some(Reading::Blind { since }) => MapKindReading::Stale {
                since: since.clone(),
            },
            Some(Reading::Refused { message }) if !read_in.is_empty() => {
                MapKindReading::NamespacesOnly {
                    namespaces: read_in,
                    said: message.clone(),
                }
            }
            Some(Reading::Refused { message }) => MapKindReading::Refused {
                said: message.clone(),
            },
            Some(Reading::Failed { message }) => MapKindReading::Failed {
                said: message.clone(),
            },
            Some(Reading::Unserved) if kind.optional() => MapKindReading::NotServed,
            Some(Reading::Unserved) => MapKindReading::Unserved,
            None if !read_in.is_empty() => MapKindReading::NamespacesOnly {
                namespaces: read_in,
                said: String::new(),
            },
            Some(Reading::Syncing) => MapKindReading::Syncing,
            Some(Reading::Queued) | None => MapKindReading::Queued,
        }
    }
}

/// One stream's map: its stores, where their changes are told, and the
/// token that ends every stream on it when what feeds it stops.
pub struct ClusterMap {
    stores: RwLock<Stores>,
    changes: broadcast::Sender<Touched>,
    ended: CancellationToken,
}

impl Default for ClusterMap {
    fn default() -> Self {
        Self {
            stores: RwLock::new(Stores::default()),
            changes: broadcast::channel(256).0,
            ended: CancellationToken::new(),
        }
    }
}

impl ClusterMap {
    /// A map fed only the namespaces a scope names.
    #[must_use]
    pub fn scoped() -> Self {
        let map = Self::default();
        map.stores.write().scoped = true;
        map
    }

    /// Takes feeds from a source, and tells every stream what they touched.
    pub fn feed(&self, feeds: impl IntoIterator<Item = Feed>) {
        let mut touched = Touched::default();
        {
            let mut stores = self.stores.write();
            for feed in feeds {
                touched.merge(stores.apply(feed));
            }
        }
        if !touched.is_empty() {
            let _ = self.changes.send(touched);
        }
    }

    pub fn stores(&self) -> parking_lot::RwLockReadGuard<'_, Stores> {
        self.stores.read()
    }

    #[must_use]
    pub fn changes(&self) -> broadcast::Receiver<Touched> {
        self.changes.subscribe()
    }

    /// Fires when what feeds the map stopped: the cluster was let go.
    #[must_use]
    pub fn ended(&self) -> CancellationToken {
        self.ended.clone()
    }

    pub fn end(&self) {
        self.ended.cancel();
    }
}

#[cfg(test)]
mod tests;
