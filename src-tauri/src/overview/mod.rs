//! The overview's inputs, held from watches instead of listed every round.
//!
//! Every ten seconds the window asked for the overview once per namespace in
//! scope and once more for the rail, and each answer was a full pod LIST,
//! with a cluster-wide one beside every namespaced one for the scheduler
//! view: four namespaces was five full lists a round on a cluster of ten
//! thousand pods. A watch per kind, kept in a store, answers the same
//! question from memory; a request only projects its namespace out.
//!
//! The store serves only while every watch it holds is healthy. A refused or
//! broken watch is not stale data quietly served as fresh: the request falls
//! back to listing, exactly as before, and the cache is retried later.

use std::collections::BTreeSet;
use std::fmt::Debug;
use std::hash::Hash;
use std::sync::Arc;
use std::time::{Duration, Instant};

use dashmap::DashMap;
use futures::StreamExt;
use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::batch::v1::Job;
use k8s_openapi::api::core::v1::{Container, Event, Node, Pod};
use kube::runtime::reflector::{self, Store};
use kube::runtime::watcher::{self, Config as WatcherConfig};
use kube::runtime::WatchStreamExt;
use kube::{Api, Client, Resource};
use parking_lot::Mutex;
use serde::de::DeserializeOwned;
use tokio_util::sync::CancellationToken;

/// Errors in a row before a kind counts as broken and the cache stops serving.
const BROKEN_STREAK: u32 = 3;
/// Errors in a row before the whole cluster's watches are dropped.
const GIVE_UP_STREAK: u32 = 10;
/// How long a dropped cluster waits before a request may start it again.
const COOLDOWN: Duration = Duration::from_mins(5);
/// Watches nobody has asked for this long are stopped.
const IDLE_AFTER: Duration = Duration::from_mins(3);
const REAP_EVERY: Duration = Duration::from_secs(30);
/// The first request waits this long for the stores to fill before listing.
const READY_TIMEOUT: Duration = Duration::from_secs(60);
/// Just under the five minutes kube used to enforce; see `watch::WATCH_TIMEOUT_SECS`.
const WATCH_TIMEOUT_SECS: u32 = 290;
const PAGE_SIZE: u32 = 500;

/// Watches per connected cluster, started on the first overview request.
#[derive(Default)]
pub struct OverviewCache {
    clusters: Arc<DashMap<String, Arc<ClusterWatch>>>,
    cooldown: Arc<DashMap<String, Instant>>,
}

/// What the stores held at one moment. Arcs, not clones: ten thousand pods
/// are looked at, not copied, on every request.
pub struct Snapshot {
    pub pods: Vec<Arc<Pod>>,
    pub nodes: Vec<Arc<Node>>,
    pub deployments: Vec<Arc<Deployment>>,
    pub jobs: Vec<Arc<Job>>,
    /// Warning events only; the watch is field-selected to them.
    pub events: Vec<Arc<Event>>,
}

struct ClusterWatch {
    pods: Store<Pod>,
    nodes: Store<Node>,
    deployments: Store<Deployment>,
    jobs: Store<Job>,
    events: Store<Event>,
    health: Arc<Mutex<Health>>,
    stop: CancellationToken,
}

/// Which watches are failing, and when the cache was last asked.
#[derive(Debug)]
pub struct Health {
    streaks: [(&'static str, u32); 5],
    last_used: Instant,
}

impl Health {
    fn new(kinds: [&'static str; 5]) -> Self {
        Self {
            streaks: kinds.map(|kind| (kind, 0)),
            last_used: Instant::now(),
        }
    }

    /// One more error for `kind`; the streak it is now on.
    fn failed(&mut self, kind: &str) -> u32 {
        let slot = self.slot(kind);
        slot.1 += 1;
        slot.1
    }

    fn recovered(&mut self, kind: &str) {
        self.slot(kind).1 = 0;
    }

    fn slot(&mut self, kind: &str) -> &mut (&'static str, u32) {
        self.streaks
            .iter_mut()
            .find(|(name, _)| *name == kind)
            .expect("a kind this cache watches")
    }

    /// Every kind is either healthy or recovering; nothing is known broken.
    #[must_use]
    pub fn serves(&self) -> bool {
        self.broken().is_empty()
    }

    fn broken(&self) -> BTreeSet<&'static str> {
        self.streaks
            .iter()
            .filter(|(_, streak)| *streak >= BROKEN_STREAK)
            .map(|(kind, _)| *kind)
            .collect()
    }
}

impl OverviewCache {
    /// The stores' contents for `context`, or `None` when they cannot be
    /// trusted: not started and in cooldown, still filling past the wait,
    /// or a watch is broken. `None` means "list instead".
    pub async fn snapshot(
        &self,
        context: &str,
        client: impl FnOnce() -> Client,
    ) -> Option<Snapshot> {
        if self.cooling_down(context) {
            return None;
        }
        let watch = self
            .clusters
            .entry(context.to_string())
            .or_insert_with(|| Arc::new(self.start(context, client())))
            .clone();
        let ready = tokio::time::timeout(READY_TIMEOUT, watch.wait_until_ready()).await;
        match ready {
            Ok(true) => {}
            Ok(false) | Err(_) => return None,
        }
        let mut health = watch.health.lock();
        health.last_used = Instant::now();
        if !health.serves() {
            tracing::debug!(context, broken = ?health.broken(), "overview cache not serving");
            return None;
        }
        drop(health);
        Some(Snapshot {
            pods: watch.pods.state(),
            nodes: watch.nodes.state(),
            deployments: watch.deployments.state(),
            jobs: watch.jobs.state(),
            events: watch.events.state(),
        })
    }

    /// Stop and drop the watches of one cluster; the next request starts them again.
    pub fn forget(&self, context: &str) {
        if let Some((_, watch)) = self.clusters.remove(context) {
            watch.stop.cancel();
        }
    }

    pub fn forget_all(&self) {
        for entry in self.clusters.iter() {
            entry.value().stop.cancel();
        }
        self.clusters.clear();
    }

    /// The watches this process holds, for diagnostics.
    #[must_use]
    pub fn watching(&self) -> Vec<String> {
        self.clusters.iter().map(|e| e.key().clone()).collect()
    }

    fn cooling_down(&self, context: &str) -> bool {
        // The read guard is released before `remove` asks for the write
        // lock on the same shard; holding both is a deadlock, not a race.
        let until = self.cooldown.get(context).map(|until| *until);
        match until {
            Some(until) if Instant::now() < until => true,
            Some(_) => {
                self.cooldown.remove(context);
                false
            }
            None => false,
        }
    }

    fn start(&self, context: &str, client: Client) -> ClusterWatch {
        let health = Arc::new(Mutex::new(Health::new([
            "Pod",
            "Node",
            "Deployment",
            "Job",
            "Event",
        ])));
        let stop = CancellationToken::new();
        let cluster = WatchConfigs {
            context: context.to_string(),
            health: health.clone(),
            stop: stop.clone(),
            clusters: self.clusters.clone(),
            cooldown: self.cooldown.clone(),
        };
        let watcher_config = || {
            WatcherConfig::default()
                .timeout(WATCH_TIMEOUT_SECS)
                .page_size(PAGE_SIZE)
        };

        let pods = cluster.spawn("Pod", Api::all(client.clone()), watcher_config(), strip_pod);
        let nodes = cluster.spawn(
            "Node",
            Api::all(client.clone()),
            watcher_config(),
            strip_node,
        );
        let deployments = cluster.spawn(
            "Deployment",
            Api::all(client.clone()),
            watcher_config(),
            strip_deployment,
        );
        let jobs = cluster.spawn("Job", Api::all(client.clone()), watcher_config(), strip_job);
        let events = cluster.spawn(
            "Event",
            Api::all(client),
            watcher_config().fields("type=Warning"),
            strip_event,
        );

        cluster.spawn_reaper(IDLE_AFTER);
        tracing::info!(context, "overview watches started");
        ClusterWatch {
            pods,
            nodes,
            deployments,
            jobs,
            events,
            health,
            stop,
        }
    }
}

impl ClusterWatch {
    /// True once every store has its first list; false when a writer was
    /// dropped, which is the cluster being forgotten mid-wait.
    async fn wait_until_ready(&self) -> bool {
        let all = tokio::join!(
            self.pods.wait_until_ready(),
            self.nodes.wait_until_ready(),
            self.deployments.wait_until_ready(),
            self.jobs.wait_until_ready(),
            self.events.wait_until_ready(),
        );
        all.0.is_ok() && all.1.is_ok() && all.2.is_ok() && all.3.is_ok() && all.4.is_ok()
    }
}

/// What every kind's driver shares.
#[derive(Clone)]
struct WatchConfigs {
    context: String,
    health: Arc<Mutex<Health>>,
    stop: CancellationToken,
    clusters: Arc<DashMap<String, Arc<ClusterWatch>>>,
    cooldown: Arc<DashMap<String, Instant>>,
}

impl WatchConfigs {
    fn spawn<K>(
        &self,
        kind: &'static str,
        api: Api<K>,
        config: WatcherConfig,
        strip: fn(&mut K),
    ) -> Store<K>
    where
        K: Resource + Clone + DeserializeOwned + Debug + Send + Sync + 'static,
        K::DynamicType: Default + Eq + Hash + Clone,
    {
        let (store, writer) = reflector::store();
        let health = self.health.clone();
        let stop = self.stop.clone();
        let context = self.context.clone();
        let clusters = self.clusters.clone();
        let cooldown = self.cooldown.clone();
        tokio::spawn(async move {
            let events = reflector::reflector(
                writer,
                watcher::watcher(api, config)
                    .modify(strip)
                    .default_backoff(),
            );
            futures::pin_mut!(events);
            loop {
                let next = tokio::select! {
                    biased;
                    () = stop.cancelled() => break,
                    next = events.next() => next,
                };
                match next {
                    Some(Ok(_)) => health.lock().recovered(kind),
                    Some(Err(error)) => {
                        let streak = health.lock().failed(kind);
                        if streak == BROKEN_STREAK {
                            tracing::warn!(context, kind, %error, "overview watch broken; listing instead");
                        }
                        if streak >= GIVE_UP_STREAK {
                            tracing::warn!(
                                context,
                                kind,
                                "overview watch given up; retry after cooldown"
                            );
                            cooldown.insert(context.clone(), Instant::now() + COOLDOWN);
                            if let Some((_, watch)) = clusters.remove(&context) {
                                watch.stop.cancel();
                            }
                            stop.cancel();
                            break;
                        }
                    }
                    None => break,
                }
            }
        });
        store
    }

    /// Stops the cluster's watches once nothing has asked for them in `idle`.
    fn spawn_reaper(&self, idle: Duration) {
        let health = self.health.clone();
        let stop = self.stop.clone();
        let clusters = self.clusters.clone();
        let context = self.context.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    biased;
                    () = stop.cancelled() => break,
                    () = tokio::time::sleep(REAP_EVERY) => {}
                }
                if health.lock().last_used.elapsed() > idle {
                    tracing::info!(context, "overview watches idle; stopped");
                    if let Some((_, watch)) = clusters.remove(&context) {
                        watch.stop.cancel();
                    }
                    stop.cancel();
                    break;
                }
            }
        });
    }
}

fn strip_container(container: &mut Container) {
    container.env = None;
    container.env_from = None;
    container.volume_mounts = None;
    container.volume_devices = None;
    container.command = None;
    container.args = None;
    container.lifecycle = None;
    container.liveness_probe = None;
    container.readiness_probe = None;
    container.startup_probe = None;
    container.security_context = None;
}

/// What the overview never reads, dropped before the object is stored: the
/// store holds every pod in the cluster, and a pod's env, mounts and probes
/// are most of its bytes.
pub fn strip_pod(pod: &mut Pod) {
    pod.metadata.managed_fields = None;
    pod.metadata.annotations = None;
    if let Some(spec) = pod.spec.as_mut() {
        spec.volumes = None;
        spec.affinity = None;
        spec.tolerations = None;
        spec.containers.iter_mut().for_each(strip_container);
        if let Some(init) = spec.init_containers.as_mut() {
            init.iter_mut().for_each(strip_container);
        }
        if let Some(ephemeral) = spec.ephemeral_containers.as_mut() {
            ephemeral.clear();
        }
    }
}

pub fn strip_node(node: &mut Node) {
    node.metadata.managed_fields = None;
    node.metadata.annotations = None;
    if let Some(status) = node.status.as_mut() {
        status.images = None;
        status.volumes_attached = None;
        status.volumes_in_use = None;
    }
}

pub fn strip_deployment(deployment: &mut Deployment) {
    deployment.metadata.managed_fields = None;
    deployment.metadata.annotations = None;
    if let Some(spec) = deployment.spec.as_mut() {
        spec.template.spec = None;
        spec.template.metadata = None;
    }
}

pub fn strip_job(job: &mut Job) {
    job.metadata.managed_fields = None;
    job.metadata.annotations = None;
    if let Some(spec) = job.spec.as_mut() {
        spec.template.spec = None;
        spec.template.metadata = None;
    }
}

pub fn strip_event(event: &mut Event) {
    event.metadata.managed_fields = None;
    event.metadata.annotations = None;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One broken watch is enough: an overview built from four fresh stores and one stale one is one stale overview.
    #[test]
    fn one_broken_kind_stops_the_cache_from_serving() {
        let mut health = Health::new(["Pod", "Node", "Deployment", "Job", "Event"]);
        assert!(health.serves());
        for _ in 0..BROKEN_STREAK - 1 {
            health.failed("Node");
        }
        assert!(health.serves(), "a blip is not a break");
        health.failed("Node");
        assert!(!health.serves());
        assert_eq!(health.broken().into_iter().collect::<Vec<_>>(), ["Node"]);
        health.recovered("Node");
        assert!(health.serves());
    }

    /// A cluster in cooldown is not restarted by the next request.
    #[test]
    fn a_cluster_that_gave_up_is_not_restarted_until_the_cooldown_passes() {
        let cache = OverviewCache::default();
        assert!(!cache.cooling_down("prod"));
        cache
            .cooldown
            .insert("prod".to_string(), Instant::now() + COOLDOWN);
        assert!(cache.cooling_down("prod"));
        let passed = Instant::now()
            .checked_sub(Duration::from_secs(1))
            .expect("a second ago exists");
        cache.cooldown.insert("prod".to_string(), passed);
        assert!(!cache.cooling_down("prod"));
        assert!(
            cache.cooldown.get("prod").is_none(),
            "an expired cooldown is forgotten"
        );
    }
}
