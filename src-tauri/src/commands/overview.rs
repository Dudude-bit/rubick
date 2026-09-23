//! Cluster overview — the "do I need to do something right now?" query.
//!
//! Deliberately not a count-the-objects endpoint: how many of each kind
//! exist is not something anyone acts on. This one answers "what is
//! broken, how tight is the scheduler, and what is this cluster" in a
//! single round trip.
//!
//! The aggregation lives here rather than in the frontend because the
//! inputs are the full pod / node / deployment / event lists: shipping
//! all of that over IPC to reduce it to a dozen rows in JS wastes both
//! the transfer and the main thread, and the reduction has to re-run on
//! every watch event.

use crate::commands::helpers::{api_in, reaches, scope_of};
use crate::error::{Error, Result};
use crate::metrics::{MetricsStatusKind, NodeMetricsResponse};
use crate::state::AppState;
use crate::utils::quantities::{parse_cpu, parse_memory};
use crate::utils::Moment;
use chrono::{DateTime, Utc};
use futures::future::join_all;
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, StatefulSet};
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{ConfigMap, Event, Namespace, Node, Pod, Secret, Service};
use k8s_openapi::api::networking::v1::Ingress;
use kube::api::ListParams;
use kube::{Api, Client};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt::Debug;
use std::sync::Arc;
use tauri::State;

use crate::overview::Snapshot;

/// How far back an event still counts as "recent" for the warnings feed.
const RECENT_WARNING_WINDOW_MINUTES: i64 = 60;

/// Server-side page size for the event list. Events are the largest collection
/// in most clusters and this query re-runs every couple of seconds, so pulling
/// the full list to keep one hour of it is the wrong trade.
const EVENT_FETCH_LIMIT: u32 = 500;

/// How many event pages to walk at most. The API returns events in etcd key
/// order, not newest first, so a single page can miss the entire last hour on
/// a cluster with thousands of warnings — following `continue` widens the
/// window. The cap keeps the trade: four pages cover 2000 warnings, and a
/// pathological cluster cannot stall a query that re-runs every few seconds.
const MAX_EVENT_PAGES: usize = 4;

/// Page size for the count probe in [`count_of`]. One page is the whole
/// cost of a count, so this is only "how many objects a small cluster is
/// counted in a single round trip" — big enough that most kinds never need
/// the apiserver's own tally, small enough to be nothing next to the
/// collection it replaces.
const COUNT_PAGE_SIZE: u32 = 500;

/// Longest a pod may sit Pending before it counts as a problem. Scheduling
/// and image pulls take seconds; without this grace every `CronJob` tick
/// paints the panel red and the signal is gone.
const PENDING_GRACE_SECONDS: i64 = 60;

/// Cap on the problems list. A node outage produces one row per pod on it,
/// and neither the IPC payload nor the two-second re-render survives that.
/// Applied once to the whole scope, however many namespaces it adds up.
const MAX_PROBLEMS: usize = 50;

/// Restart count above which a pod is called out even while it is Running.
/// A pod that restarted a few times hours ago is noise; one climbing past
/// this is worth a look before it starts flapping.
const RESTART_ATTENTION_THRESHOLD: i32 = 5;

/// How recently the last restart has to have been for the pod to still count
/// as restarting.
///
/// The comment above says a pod that restarted hours ago is noise, and the
/// rule did not implement it: a restart count is a running total that never
/// falls, so once a pod crossed the threshold it was reported for the rest
/// of its life. Somebody rebooted a bare-metal cluster, every pod on it
/// restarted, and two days later the Overview badge still said one problem
/// about a pod that was `Running`, `7/7 ready` and had not restarted since.
///
/// An hour is far longer than a crash loop takes to come round again —
/// `CrashLoopBackOff` caps its wait at five minutes — so nothing that is
/// actually flapping escapes, and an incident that is over stops being news.
const RESTART_RECENT_SECONDS: i64 = 3600;

/// Waiting-state reasons that mean the pod is stuck, not starting up.
const STUCK_WAITING_REASONS: &[&str] = &[
    "CrashLoopBackOff",
    "ImagePullBackOff",
    "ErrImagePull",
    "CreateContainerConfigError",
    "CreateContainerError",
    "InvalidImageName",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProblemSeverity {
    /// Workload is down or cannot start.
    Critical,
    /// Degraded or trending bad, but still serving.
    Warning,
}

/// What the detail line on a problem row says.
///
/// Two unlike things arrived in this one field and only one of them may be
/// translated: most rows quote the object's own status message, which is the
/// cluster's wording and stays as written, while three are sentences this app
/// composes. Naming the variant is what lets the reader see the second kind
/// in their own language without the app rewriting the first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "says", rename_all = "camelCase")]
pub enum ProblemDetail {
    /// The object's own words, quoted.
    Said { text: String },
    /// A pod restarting more than the screen tolerates.
    Restarts { n: i32 },
    /// A Deployment short of replicas whose own condition said nothing.
    ReplicasReady { ready: i32, desired: i32 },
    /// A node marked unschedulable.
    Unschedulable,
}

impl ProblemDetail {
    /// The cluster's own message, where it wrote one.
    fn said(message: Option<String>) -> Option<Self> {
        message.map(|text| Self::Said { text })
    }
}

/// One actionable row in the problems list. `kind` + `namespace` + `name`
/// is enough for the frontend to build a deep link to the detail page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterProblem {
    pub severity: ProblemSeverity,
    pub kind: String,
    pub name: String,
    pub namespace: Option<String>,
    /// Short machine-ish label: `CrashLoopBackOff`, `Pending`, `NotReady`.
    pub reason: String,
    /// Why, named rather than written — see [`ProblemDetail`].
    pub detail: Option<ProblemDetail>,
    /// RFC3339 timestamp the condition started, for "N minutes ago".
    pub since: Option<String>,
    pub restarts: Option<i32>,
}

/// Requested vs allocatable for one resource dimension, plus live usage.
///
/// `requested` is the number that decides whether the next pod schedules;
/// `usage` is the one people look at. Both are returned so the UI can lead
/// with the former and keep the latter as context.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourcePressure {
    pub requested: f64,
    pub allocatable: f64,
    pub usage: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerPressure {
    /// Millicores.
    pub cpu: ResourcePressure,
    /// Bytes.
    pub memory: ResourcePressure,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeSummary {
    pub name: String,
    pub ready: bool,
    pub schedulable: bool,
    pub roles: Vec<String>,
    pub pod_count: usize,
    pub pod_capacity: Option<i64>,
    pub cpu: ResourcePressure,
    pub memory: ResourcePressure,
}

/// Warning events collapsed by reason. Twenty `FailedScheduling` lines are
/// one problem, not twenty.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WarningGroup {
    pub reason: String,
    pub count: i32,
    pub last_seen: Option<String>,
    /// Most recent message for this reason.
    pub sample: Option<String>,
    /// The object the most recent event referred to, kept apart the way
    /// `ClusterProblem` keeps it. It used to be one `"Kind/name"` string with
    /// the namespace thrown away, which is why the panel above this one could
    /// link a message and this one could not: the same sentence needs a kind,
    /// a name *and* a namespace to be resolved against, and two thirds of one
    /// is a guess.
    pub object_kind: Option<String>,
    pub object_name: Option<String>,
    /// The involved object's namespace, not the event's: an event about a
    /// pod is recorded beside it, but a cluster-scoped object's event is not.
    pub namespace: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamespaceLoad {
    pub name: String,
    pub pod_count: usize,
    /// Counted before the list is cut to `MAX_PROBLEMS`: on a cluster with
    /// fifty critical problems elsewhere, a namespace with only warnings has
    /// problems, not none.
    pub problem_count: usize,
}

/// How many objects of each kind live in the requested scope.
///
/// Every count is optional, and `None` is not `Some(0)`: RBAC denies one kind
/// at a time, and a token that may not list Secrets must not make the UI
/// announce that the namespace has none. "Nothing there" and "not allowed to
/// look" are different facts and the UI renders them differently.
///
/// Namespaced kinds follow the selected namespace; `nodes` and `namespaces`
/// are cluster-wide because they have no namespace to be scoped to.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceCounts {
    pub pods: Option<usize>,
    pub deployments: Option<usize>,
    pub stateful_sets: Option<usize>,
    pub daemon_sets: Option<usize>,
    pub jobs: Option<usize>,
    pub cron_jobs: Option<usize>,
    pub nodes: Option<usize>,
    pub namespaces: Option<usize>,
    pub services: Option<usize>,
    pub ingresses: Option<usize>,
    pub config_maps: Option<usize>,
    pub secrets: Option<usize>,
    /// Events the apiserver still holds. Events expire on the cluster's own
    /// TTL — an hour on most installs — so this is a recent-activity count,
    /// not a lifetime total.
    pub events: Option<usize>,
}

/// Pods by phase, plus the one sub-phase that matters.
///
/// Phase is the only pod field that separates "serving" from "ran and
/// finished", and without it a completed Job pod is indistinguishable from a
/// healthy one — which is how the Workloads block came to count backups as
/// running workload. The fields sum to the scoped pod count.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PodComposition {
    pub running: usize,
    pub pending: usize,
    pub succeeded: usize,
    pub failed: usize,
    /// Phase absent or a value this build does not know.
    pub unknown: usize,
    /// A subset of `running`, not an addition to it: a pod whose containers
    /// are looping in a back-off reports phase Running while serving nothing,
    /// and a composition bar that hides that is the bar's whole failure mode.
    pub crash_looping: usize,
}

/// Jobs by outcome. `active` covers both running and not-yet-started Jobs:
/// neither has an outcome yet, and splitting them would put a Job that is
/// one second from starting in a different bucket from one mid-run.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobComposition {
    pub completed: usize,
    pub active: usize,
    pub failed: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterOverview {
    /// Sorted worst-first, then oldest-first: the top row is where to look.
    /// Capped at `MAX_PROBLEMS`.
    pub problems: Vec<ClusterProblem>,
    /// How many problems were dropped by the cap, so the UI can say "+N more"
    /// rather than quietly understate an outage.
    pub problems_truncated: usize,
    pub scheduler: SchedulerPressure,
    /// Uncapped: node counts are bounded in practice (hundreds at worst, and
    /// unlike pods they do not multiply per workload), and a truncated node
    /// list would hide exactly the node someone is looking for.
    pub nodes: Vec<NodeSummary>,
    /// False when the cluster-wide node/pod reads the capacity view needs were
    /// refused — a namespace-scoped token has no cluster read rights. `nodes`
    /// and `scheduler` are then empty and mean "unknown", not "no capacity":
    /// the panels say so rather than drawing a cluster with zero headroom.
    pub nodes_known: bool,
    pub warnings: Vec<WarningGroup>,
    pub namespaces: Vec<NamespaceLoad>,
    /// Objects per kind in the requested scope, for the sidebar and the
    /// composition bars.
    pub counts: ResourceCounts,
    /// Phase breakdown of the pods in the requested scope.
    pub pods: PodComposition,
    /// `None` when the Job list was refused — the same distinction
    /// `ResourceCounts` makes, for the one kind whose bar needs status.
    pub jobs: Option<JobComposition>,
    /// False when the metrics API is unavailable, so the UI can say so
    /// instead of rendering an empty usage bar that reads as "idle".
    pub metrics_available: bool,
    /// Whether this answer came from the watch-fed stores or from listing.
    pub served_from: OverviewSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OverviewSource {
    Watch,
    List,
}

/// Pods in these phases hold no scheduler reservation, so they are excluded
/// from resource accounting. They are still examined for problems.
fn is_terminal(pod: &Pod) -> bool {
    pod.status
        .as_ref()
        .and_then(|s| s.phase.as_deref())
        .is_some_and(|p| p == "Succeeded" || p == "Failed")
}

/// What the scheduler holds for this pod, by the one rule in
/// `resources::reservation` — sidecars, the largest init container, overhead
/// and pod-level requests included.
pub(crate) fn pod_requests(pod: &Pod) -> (f64, u64) {
    let Some(spec) = pod.spec.as_ref() else {
        return (0.0, 0);
    };
    let held = crate::resources::reservation::pod_reservation(spec);
    (
        held.requests.get("cpu").copied().unwrap_or(0.0),
        held.requests.get("memory").copied().unwrap_or(0.0) as u64,
    )
}

fn node_is_ready(node: &Node) -> bool {
    node.status
        .as_ref()
        .and_then(|s| s.conditions.as_ref())
        .is_some_and(|cs| cs.iter().any(|c| c.type_ == "Ready" && c.status == "True"))
}

fn node_roles(node: &Node) -> Vec<String> {
    node.metadata
        .labels
        .as_ref()
        .map(|labels| {
            labels
                .keys()
                .filter_map(|k| k.strip_prefix("node-role.kubernetes.io/"))
                .filter(|r| !r.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Collect every pod-level problem: stuck containers, failed pods,
/// unschedulable pods, and restart storms. `now` is injected so the Pending
/// grace period is testable.
fn pod_problems<'a>(
    pods: impl IntoIterator<Item = &'a Pod>,
    now: DateTime<Utc>,
) -> Vec<ClusterProblem> {
    pods.into_iter()
        .filter_map(|pod| pod_problem(pod, now))
        .collect()
}

/// Reason and message of the first container stuck in a back-off / image-pull
/// loop rather than starting up. The single most common real incident, and the
/// reason string the API gives for it is already precise.
fn stuck_reason(pod: &Pod) -> Option<(String, Option<String>)> {
    pod.status
        .as_ref()?
        .container_statuses
        .as_ref()?
        .iter()
        .find_map(|c| {
            let waiting = c.state.as_ref()?.waiting.as_ref()?;
            let reason = waiting.reason.as_deref()?;
            STUCK_WAITING_REASONS
                .contains(&reason)
                .then(|| (reason.to_string(), waiting.message.clone()))
        })
}

/// The single worst thing to say about one pod, or `None` if it is fine.
fn pod_problem(pod: &Pod, now: DateTime<Utc>) -> Option<ClusterProblem> {
    let name = pod.metadata.name.clone().unwrap_or_default();
    let namespace = pod.metadata.namespace.clone();
    let created = pod
        .metadata
        .creation_timestamp
        .as_ref()
        .map(|t| t.moment().to_rfc3339());
    let status = pod.status.as_ref()?;
    let phase = status.phase.as_deref().unwrap_or("");

    // The same count the pod list shows, and the time of the last one. This
    // used to sum `container_statuses` here and nowhere else, which left
    // init containers and sidecars out — so a pod whose sidecar was flapping
    // had one restart count on the Pods page and a different one here.
    let (restarts, last_restart_at) = crate::resources::restarts(pod);

    if let Some((reason, message)) = stuck_reason(pod) {
        return Some(ClusterProblem {
            severity: ProblemSeverity::Critical,
            kind: "Pod".to_string(),
            name,
            namespace,
            reason,
            detail: ProblemDetail::said(message),
            since: created,
            restarts: Some(restarts),
        });
    }

    // A pod that ran and lost is the whole reason this screen exists, and
    // nothing else reports it: terminal pods are skipped by the resource
    // accounting and produce no waiting-state reason.
    if phase == "Failed" {
        return Some(ClusterProblem {
            severity: ProblemSeverity::Critical,
            kind: "Pod".to_string(),
            name,
            namespace,
            reason: status
                .reason
                .clone()
                .unwrap_or_else(|| "Failed".to_string()),
            detail: ProblemDetail::said(status.message.clone()),
            since: created,
            restarts: (restarts > 0).then_some(restarts),
        });
    }

    if phase == "Pending" {
        // `PodScheduled=False` carries the scheduler's own explanation
        // ("0/3 nodes are available: Insufficient memory"), which is
        // far more useful than the word "Pending".
        let scheduled = status
            .conditions
            .as_ref()
            .and_then(|cs| cs.iter().find(|c| c.type_ == "PodScheduled"));
        let pending_since = scheduled
            .and_then(|c| c.last_transition_time.as_ref())
            .or(pod.metadata.creation_timestamp.as_ref())
            .map(Moment::moment);
        // Undated pods fall through and get reported: an unknown age is not
        // evidence that the pod is young.
        if pending_since.is_some_and(|t| now - t < chrono::Duration::seconds(PENDING_GRACE_SECONDS))
        {
            return None;
        }
        return Some(ClusterProblem {
            severity: ProblemSeverity::Critical,
            kind: "Pod".to_string(),
            name,
            namespace,
            reason: "Pending".to_string(),
            detail: ProblemDetail::said(
                scheduled
                    .and_then(|c| c.message.clone())
                    .or_else(|| status.message.clone()),
            ),
            since: pending_since.map(|t| t.to_rfc3339()),
            restarts: None,
        });
    }

    // Undated restarts still report, the way an undated Pending pod does:
    // not knowing when it happened is not evidence that it is over.
    let restarted_recently = last_restart_at
        .is_none_or(|at| now - at < chrono::Duration::seconds(RESTART_RECENT_SECONDS));

    if restarts >= RESTART_ATTENTION_THRESHOLD && phase == "Running" && restarted_recently {
        return Some(ClusterProblem {
            severity: ProblemSeverity::Warning,
            kind: "Pod".to_string(),
            name,
            namespace,
            reason: "Restarting".to_string(),
            detail: Some(ProblemDetail::Restarts { n: restarts }),
            // Dated by the restart, not by the pod. `since: created` put a
            // twelve-day-old date on something that happened minutes ago.
            since: last_restart_at.map(|t| t.to_rfc3339()).or(created),
            restarts: Some(restarts),
        });
    }

    None
}

fn deployment_problems<'a>(
    deployments: impl IntoIterator<Item = &'a Deployment>,
) -> Vec<ClusterProblem> {
    deployments
        .into_iter()
        .filter_map(|d| {
            let desired = d.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
            // A deliberately scaled-to-zero deployment is not degraded.
            if desired == 0 {
                return None;
            }
            let ready = d
                .status
                .as_ref()
                .and_then(|s| s.ready_replicas)
                .unwrap_or(0);
            if ready >= desired {
                return None;
            }
            let condition = d.status.as_ref().and_then(|s| {
                s.conditions
                    .as_ref()?
                    .iter()
                    .find(|c| c.type_ == "Available" && c.status != "True")
                    .cloned()
            });
            Some(ClusterProblem {
                severity: if ready == 0 {
                    ProblemSeverity::Critical
                } else {
                    ProblemSeverity::Warning
                },
                kind: "Deployment".to_string(),
                name: d.metadata.name.clone().unwrap_or_default(),
                namespace: d.metadata.namespace.clone(),
                reason: "NotAvailable".to_string(),
                detail: ProblemDetail::said(condition.as_ref().and_then(|c| c.message.clone()))
                    .or(Some(ProblemDetail::ReplicasReady { ready, desired })),
                since: condition
                    .as_ref()
                    .and_then(|c| c.last_transition_time.as_ref())
                    .map(|t| t.moment().to_rfc3339()),
                restarts: None,
            })
        })
        .collect()
}

fn node_problems<'a>(nodes: impl IntoIterator<Item = &'a Node>) -> Vec<ClusterProblem> {
    nodes
        .into_iter()
        .filter_map(|n| {
            let name = n.metadata.name.clone().unwrap_or_default();
            if !node_is_ready(n) {
                let condition = n.status.as_ref().and_then(|s| {
                    s.conditions
                        .as_ref()?
                        .iter()
                        .find(|c| c.type_ == "Ready")
                        .cloned()
                });
                return Some(ClusterProblem {
                    severity: ProblemSeverity::Critical,
                    kind: "Node".to_string(),
                    name,
                    namespace: None,
                    reason: "NotReady".to_string(),
                    detail: ProblemDetail::said(condition.as_ref().and_then(|c| c.message.clone())),
                    since: condition
                        .as_ref()
                        .and_then(|c| c.last_transition_time.as_ref())
                        .map(|t| t.moment().to_rfc3339()),
                    restarts: None,
                });
            }
            // Cordoned nodes are usually intentional, but a node left
            // cordoned after a maintenance window silently shrinks capacity.
            if n.spec
                .as_ref()
                .and_then(|s| s.unschedulable)
                .unwrap_or(false)
            {
                return Some(ClusterProblem {
                    severity: ProblemSeverity::Warning,
                    kind: "Node".to_string(),
                    name,
                    namespace: None,
                    reason: "Cordoned".to_string(),
                    detail: Some(ProblemDetail::Unschedulable),
                    since: None,
                    restarts: None,
                });
            }
            None
        })
        .collect()
}

fn recent_warnings<'a>(events: impl IntoIterator<Item = &'a Event>) -> Vec<WarningGroup> {
    let cutoff = chrono::Utc::now() - chrono::Duration::minutes(RECENT_WARNING_WINDOW_MINUTES);
    let mut grouped: BTreeMap<String, WarningGroup> = BTreeMap::new();

    for event in events {
        if event.type_.as_deref() != Some("Warning") {
            continue;
        }
        let last = event
            .last_timestamp
            .as_ref()
            .map(Moment::moment)
            .or_else(|| event.event_time.as_ref().map(Moment::moment));
        if last.is_some_and(|t| t < cutoff) {
            continue;
        }
        let reason = event
            .reason
            .clone()
            .unwrap_or_else(|| "Unknown".to_string());
        let entry = grouped.entry(reason.clone()).or_insert(WarningGroup {
            reason,
            count: 0,
            last_seen: None,
            sample: None,
            object_kind: None,
            object_name: None,
            namespace: None,
        });
        entry.count += event.count.unwrap_or(1);
        let last_rfc = last.map(|t| t.to_rfc3339());
        // Keep the newest occurrence as the representative sample.
        if entry.last_seen.is_none() || last_rfc > entry.last_seen {
            entry.last_seen = last_rfc;
            entry.sample.clone_from(&event.message);
            entry.object_kind.clone_from(&event.involved_object.kind);
            entry.object_name.clone_from(&event.involved_object.name);
            // Deliberately not `event.metadata.namespace`, which is `default`
            // for an event about a Node — inheriting it would file a
            // cluster-scoped object inside a namespace it does not live in.
            entry.namespace.clone_from(&event.involved_object.namespace);
        }
    }

    let mut groups: Vec<_> = grouped.into_values().collect();
    groups.sort_by_key(|group| std::cmp::Reverse(group.count));
    groups
}

/// Live usage keyed by node name, or `None` when there is no usage to show.
///
/// `get_node_metrics` reports a missing or forbidden metrics-server as an
/// `Ok` response carrying a non-`Available` status and an empty list, so the
/// `Result` says nothing about availability. Reading it as "available with
/// zero usage" is how the UI ended up stating "actually using 0m (0%)" as
/// fact on every cluster without metrics-server.
///
/// An empty data set is the same claim by another route — a metrics-server
/// that answered but knows nothing about any node measures nothing — so it is
/// unavailable too, not zero.
fn usage_index(response: Option<NodeMetricsResponse>) -> Option<BTreeMap<String, (f64, u64)>> {
    let response = response?;
    if !matches!(response.status.status, MetricsStatusKind::Available) || response.data.is_empty() {
        return None;
    }
    Some(
        response
            .data
            .into_iter()
            .map(|n| {
                (
                    n.name,
                    (n.cpu_millicores.unwrap_or(0.0), n.memory_bytes.unwrap_or(0)),
                )
            })
            .collect(),
    )
}

struct NodeAggregate {
    summaries: Vec<NodeSummary>,
    scheduler: SchedulerPressure,
}

fn summarize_nodes<'a>(
    nodes: impl IntoIterator<Item = &'a Node>,
    requests_by_node: &BTreeMap<String, (f64, u64)>,
    pods_by_node: &BTreeMap<String, usize>,
    usage_by_node: Option<&BTreeMap<String, (f64, u64)>>,
) -> NodeAggregate {
    let metrics_available = usage_by_node.is_some();
    let mut summaries = Vec::new();
    let mut cluster_cpu = ResourcePressure {
        requested: 0.0,
        allocatable: 0.0,
        usage: metrics_available.then_some(0.0),
    };
    let mut cluster_memory = ResourcePressure {
        requested: 0.0,
        allocatable: 0.0,
        usage: metrics_available.then_some(0.0),
    };

    for node in nodes {
        let name = node.metadata.name.clone().unwrap_or_default();
        // Allocatable, not capacity: capacity includes what the kubelet and
        // the OS reserve, which the scheduler will never hand to a pod.
        let allocatable = node.status.as_ref().and_then(|s| s.allocatable.as_ref());
        let cpu_allocatable = allocatable
            .and_then(|a| a.get("cpu"))
            .map_or(0.0, |q| parse_cpu(&q.0));
        let memory_allocatable = allocatable
            .and_then(|a| a.get("memory"))
            .map_or(0.0, |q| parse_memory(&q.0) as f64);
        let pod_capacity = allocatable
            .and_then(|a| a.get("pods"))
            .and_then(|q| q.0.parse::<i64>().ok());

        let (cpu_requested, memory_requested) =
            requests_by_node.get(&name).copied().unwrap_or((0.0, 0));
        let usage = usage_by_node.and_then(|u| u.get(&name).copied());

        cluster_cpu.requested += cpu_requested;
        cluster_cpu.allocatable += cpu_allocatable;
        cluster_memory.requested += memory_requested as f64;
        cluster_memory.allocatable += memory_allocatable;
        if let Some((cpu_usage, memory_usage)) = usage {
            if let Some(total) = cluster_cpu.usage.as_mut() {
                *total += cpu_usage;
            }
            if let Some(total) = cluster_memory.usage.as_mut() {
                *total += memory_usage as f64;
            }
        }

        summaries.push(NodeSummary {
            ready: node_is_ready(node),
            schedulable: !node
                .spec
                .as_ref()
                .and_then(|s| s.unschedulable)
                .unwrap_or(false),
            roles: node_roles(node),
            pod_count: pods_by_node.get(&name).copied().unwrap_or(0),
            pod_capacity,
            cpu: ResourcePressure {
                requested: cpu_requested,
                allocatable: cpu_allocatable,
                usage: usage.map(|(cpu, _)| cpu),
            },
            memory: ResourcePressure {
                requested: memory_requested as f64,
                allocatable: memory_allocatable,
                usage: usage.map(|(_, memory)| memory as f64),
            },
            name,
        });
    }

    NodeAggregate {
        summaries,
        scheduler: SchedulerPressure {
            cpu: cluster_cpu,
            memory: cluster_memory,
        },
    }
}

#[derive(Default)]
struct NodeAccounting {
    requests: BTreeMap<String, (f64, u64)>,
    pods: BTreeMap<String, usize>,
}

/// Attribute pod requests to the node each pod landed on, so a single full
/// node can be shown as such while the cluster average still looks roomy.
fn account_by_node<'a>(pods: impl IntoIterator<Item = &'a Pod>) -> NodeAccounting {
    let mut accounting = NodeAccounting::default();
    for pod in pods {
        if is_terminal(pod) {
            continue;
        }
        let Some(node_name) = pod.spec.as_ref().and_then(|s| s.node_name.clone()) else {
            continue;
        };
        let (cpu, memory) = pod_requests(pod);
        let entry = accounting
            .requests
            .entry(node_name.clone())
            .or_insert((0.0, 0));
        entry.0 += cpu;
        entry.1 += memory;
        *accounting.pods.entry(node_name).or_insert(0) += 1;
    }
    accounting
}

fn pod_composition<'a>(pods: impl IntoIterator<Item = &'a Pod>) -> PodComposition {
    let mut composition = PodComposition::default();
    for pod in pods {
        match pod
            .status
            .as_ref()
            .and_then(|s| s.phase.as_deref())
            .unwrap_or_default()
        {
            "Running" => {
                composition.running += 1;
                if stuck_reason(pod).is_some() {
                    composition.crash_looping += 1;
                }
            }
            "Pending" => composition.pending += 1,
            "Succeeded" => composition.succeeded += 1,
            "Failed" => composition.failed += 1,
            _ => composition.unknown += 1,
        }
    }
    composition
}

/// A Job is only failed once its controller gave up: a pod that died while the
/// Job still has retries left is a retry, and calling that a failed Job paints
/// every backoff-and-recover as an incident.
fn job_composition<'a>(jobs: impl IntoIterator<Item = &'a Job>) -> JobComposition {
    let mut composition = JobComposition::default();
    for job in jobs {
        let condition = |wanted: &str| {
            job.status.as_ref().is_some_and(|s| {
                s.conditions
                    .as_ref()
                    .is_some_and(|cs| cs.iter().any(|c| c.type_ == wanted && c.status == "True"))
            })
        };
        if condition("Complete") {
            composition.completed += 1;
        } else if condition("Failed") {
            composition.failed += 1;
        } else {
            composition.active += 1;
        }
    }
    composition
}

/// What one page of a limited list says about the size of the whole
/// collection, or `None` for "cannot say" — see [`count_of`].
fn tally(meta: &kube::core::ListMeta, seen: usize) -> Option<usize> {
    // A continue token is the apiserver saying there is more; without one
    // this page is the whole collection and has counted itself.
    if meta.continue_.as_deref().unwrap_or_default().is_empty() {
        return Some(seen);
    }
    let rest = meta.remaining_item_count?;
    Some(seen + usize::try_from(rest).unwrap_or(0))
}

/// Count objects of one kind without pulling the collection.
///
/// `list_metadata` keeps the bodies out of the response, which is the
/// difference between counting Secrets and shipping every Secret's payload.
/// What it does not do is make the *list* smaller: counting Events meant the
/// metadata of every Event in the cluster — the largest collection there is,
/// see [`EVENT_FETCH_LIMIT`] — pulled every ten seconds, in up to four
/// scopes at once, to produce one integer for the rail.
///
/// A limited list answers it in one page: alongside the page the apiserver
/// returns `remainingItemCount`, which is the rest of the tally it has
/// already done. So the cost is a fixed page regardless of how many objects
/// there are.
///
/// An apiserver that fills the page but leaves `remainingItemCount` unset
/// (pre-1.15, or something in the middle that drops it) leaves us knowing
/// only "at least a page", and the rail draws `None` as nothing at all
/// rather than a number that is wrong.
async fn count_of<K>(api: &Api<K>) -> Option<usize>
where
    K: Clone + DeserializeOwned + Debug,
{
    // A list that could not be read is not an empty list: every caller here
    // is counting a kind the screen can do without, so a refusal degrades
    // that one number to "unknown" instead of stating as fact that the
    // namespace holds none of them.
    let page = api
        .list_metadata(&ListParams::default().limit(COUNT_PAGE_SIZE))
        .await
        .ok()?;
    tally(&page.metadata, page.items.len())
}

fn namespace_loads<'a>(
    pods: impl IntoIterator<Item = &'a Pod>,
    problems: &[ClusterProblem],
) -> Vec<NamespaceLoad> {
    let mut counts: BTreeMap<&str, (usize, usize)> = BTreeMap::new();
    for namespace in pods
        .into_iter()
        .filter_map(|p| p.metadata.namespace.as_deref())
    {
        counts.entry(namespace).or_default().0 += 1;
    }
    // A namespace can have a problem and no pod: a Deployment whose pods
    // were never created.
    for namespace in problems.iter().filter_map(|p| p.namespace.as_deref()) {
        counts.entry(namespace).or_default().1 += 1;
    }
    let mut loads: Vec<_> = counts
        .into_iter()
        .map(|(name, (pod_count, problem_count))| NamespaceLoad {
            name: name.to_string(),
            pod_count,
            problem_count,
        })
        .collect();
    loads.sort_by_key(|load| std::cmp::Reverse(load.pod_count));
    loads
}

/// Worst first, then oldest first — the top row is both the most severe and
/// the one that has been broken longest — then cut to `MAX_PROBLEMS`.
/// Returns the list and how many rows the cut dropped.
fn rank_and_cap(mut problems: Vec<ClusterProblem>) -> (Vec<ClusterProblem>, usize) {
    problems.sort_by(|a, b| {
        (a.severity == ProblemSeverity::Warning)
            .cmp(&(b.severity == ProblemSeverity::Warning))
            .then_with(|| a.since.cmp(&b.since))
    });
    let truncated = problems.len().saturating_sub(MAX_PROBLEMS);
    problems.truncate(MAX_PROBLEMS);
    (problems, truncated)
}

/// Warning events from the last pages the API will hand over cheaply.
///
/// Failures degrade to whatever was already collected: events are the one
/// input this screen can lose without becoming wrong.
async fn list_warning_events(events_api: &Api<Event>) -> Vec<Event> {
    let mut items = Vec::new();
    let mut token: Option<String> = None;

    for _ in 0..MAX_EVENT_PAGES {
        // Filtering warnings server-side turns the largest collection in the
        // cluster into a small one.
        let mut params = ListParams::default()
            .fields("type=Warning")
            .limit(EVENT_FETCH_LIMIT);
        if let Some(token) = token.as_deref() {
            params = params.continue_token(token);
        }
        let Ok(mut page) = events_api.list(&params).await else {
            break;
        };
        token = page.metadata.continue_.take().filter(|t| !t.is_empty());
        items.append(&mut page.items);
        if token.is_none() {
            break;
        }
    }

    items
}

/// Borrowed from the watch stores or from a fresh list alike: `Arc`s so the
/// ten thousand pods a store holds are looked at, never copied, per request.
struct OverviewInputs<'a> {
    /// Pods in the requested scope: problems, namespace breakdown, counts.
    scoped_pods: &'a [Arc<Pod>],
    /// Cluster-wide pods, driving everything that is divided by node
    /// allocatable. Same slice as `scoped_pods` when nothing is selected.
    accounting_pods: &'a [Arc<Pod>],
    nodes: &'a [Arc<Node>],
    /// False when the node list (or the cluster-wide accounting pods) was
    /// refused: the capacity view is unknown, not empty.
    nodes_known: bool,
    /// Every Deployment the scope handed over. Their problems stand whether
    /// or not another namespace refused its list; the count does not.
    deployments: &'a [Arc<Deployment>],
    /// False when a namespace in scope refused its Deployment list.
    deployments_known: bool,
    /// `None` when a namespace in scope refused its Job list.
    jobs: Option<&'a [Arc<Job>]>,
    events: &'a [Arc<Event>],
    usage_by_node: Option<BTreeMap<String, (f64, u64)>>,
    /// Counts for the kinds this query does not otherwise need to read.
    counts: ResourceCounts,
    /// The namespaces asked about, or `None` for the whole cluster.
    scope: Option<&'a [String]>,
    now: DateTime<Utc>,
    served_from: OverviewSource,
}

fn refs<T>(items: &[Arc<T>]) -> impl Iterator<Item = &T> {
    items.iter().map(Arc::as_ref)
}

fn build_overview(input: &OverviewInputs<'_>) -> ClusterOverview {
    let metrics_available = input.usage_by_node.is_some();
    // A refused capacity read is unknown, not an empty cluster: draw from no
    // nodes so the scheduler headroom is not a confident zero, and let the
    // `nodes_known` flag below tell the panels to say "no access" instead.
    let nodes: &[Arc<Node>] = if input.nodes_known { input.nodes } else { &[] };
    let accounting = account_by_node(refs(input.accounting_pods));
    let aggregate = summarize_nodes(
        refs(nodes),
        &accounting.requests,
        &accounting.pods,
        input.usage_by_node.as_ref(),
    );

    let mut problems = pod_problems(refs(input.scoped_pods), input.now);
    problems.extend(deployment_problems(refs(input.deployments)));
    problems.extend(node_problems(refs(nodes)));
    // Scoped, the breakdown restates the selection, under a heading that
    // counts namespaces in the cluster. Drop it instead.
    let namespaces = match input.scope {
        Some(_) => Vec::new(),
        None => namespace_loads(refs(input.scoped_pods), &problems),
    };
    let (problems, problems_truncated) = rank_and_cap(problems);

    // The lists this query already had to read answer their own counts, so
    // those four kinds cost no extra request. A refused node read is `None`,
    // not `Some(0)` — the same distinction the other counts make.
    let counts = ResourceCounts {
        pods: Some(input.scoped_pods.len()),
        deployments: input.deployments_known.then_some(input.deployments.len()),
        jobs: input.jobs.map(<[Arc<Job>]>::len),
        nodes: input.nodes_known.then_some(input.nodes.len()),
        ..input.counts.clone()
    };

    ClusterOverview {
        problems,
        problems_truncated,
        scheduler: aggregate.scheduler,
        nodes: aggregate.summaries,
        nodes_known: input.nodes_known,
        warnings: recent_warnings(refs(input.events)),
        counts,
        pods: pod_composition(refs(input.scoped_pods)),
        jobs: input.jobs.map(|jobs| job_composition(refs(jobs))),
        namespaces,
        metrics_available,
        served_from: input.served_from,
    }
}

/// Get everything the overview screen needs in one round trip.
///
/// `scope` is the namespaces to answer for, added up into one overview, or
/// `None` for the whole cluster. An empty list is refused rather than read as
/// "every namespace": a caller that lost its selection would otherwise be
/// handed the whole cluster's numbers under a label naming none of it.
#[tauri::command]
pub async fn get_cluster_overview(
    scope: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<ClusterOverview> {
    Box::pin(cluster_overview(&state, scope)).await
}

/// The counts and the usage every overview needs beside its lists.
struct Sides {
    counts: ResourceCounts,
    usage_by_node: Option<BTreeMap<String, (f64, u64)>>,
}

/// Eight bounded metadata pages, for one namespace or the whole cluster.
async fn namespaced_counts(client: &Client, reach: Option<&str>) -> ResourceCounts {
    let stateful_sets_api: Api<StatefulSet> = api_in(client, reach);
    let daemon_sets_api: Api<DaemonSet> = api_in(client, reach);
    let cron_jobs_api: Api<CronJob> = api_in(client, reach);
    let services_api: Api<Service> = api_in(client, reach);
    let ingresses_api: Api<Ingress> = api_in(client, reach);
    let config_maps_api: Api<ConfigMap> = api_in(client, reach);
    let secrets_api: Api<Secret> = api_in(client, reach);
    let events_api: Api<Event> = api_in(client, reach);
    let (stateful_sets, daemon_sets, cron_jobs, services, ingresses, config_maps, secrets, events) = tokio::join!(
        count_of(&stateful_sets_api),
        count_of(&daemon_sets_api),
        count_of(&cron_jobs_api),
        count_of(&services_api),
        count_of(&ingresses_api),
        count_of(&config_maps_api),
        count_of(&secrets_api),
        count_of(&events_api),
    );
    ResourceCounts {
        stateful_sets,
        daemon_sets,
        cron_jobs,
        services,
        ingresses,
        config_maps,
        secrets,
        events,
        ..Default::default()
    }
}

/// Several namespaces' counts as one. A count one of them refused stays
/// `None` in the sum: two answers and a refusal is not a total, and a number
/// printed from it would state something the reader cannot check.
fn add_counts(parts: &[ResourceCounts]) -> ResourceCounts {
    let sum = |count: fn(&ResourceCounts) -> Option<usize>| {
        parts
            .iter()
            .try_fold(0, |total, part| Some(total + count(part)?))
    };
    ResourceCounts {
        stateful_sets: sum(|c| c.stateful_sets),
        daemon_sets: sum(|c| c.daemon_sets),
        cron_jobs: sum(|c| c.cron_jobs),
        services: sum(|c| c.services),
        ingresses: sum(|c| c.ingresses),
        config_maps: sum(|c| c.config_maps),
        secrets: sum(|c| c.secrets),
        events: sum(|c| c.events),
        ..Default::default()
    }
}

/// The namespaced counts in every reach, added up, and the namespace count once.
async fn side_counts(client: &Client, scope: Option<&[String]>) -> ResourceCounts {
    let namespaces_api: Api<Namespace> = Api::all(client.clone());
    let (namespaces, parts) = tokio::join!(
        count_of(&namespaces_api),
        join_all(
            reaches(scope)
                .into_iter()
                .map(|reach| namespaced_counts(client, reach))
        ),
    );
    ResourceCounts {
        namespaces,
        ..add_counts(&parts)
    }
}

/// The overview for `scope` (`None` is the whole cluster): from the
/// watch-fed stores when they are healthy, otherwise by listing.
pub async fn cluster_overview(
    state: &AppState,
    scope: Option<Vec<String>>,
) -> Result<ClusterOverview> {
    let scope = scope_of(scope)?;
    let client = (*state.current_client()?).clone();
    let context = state
        .get_current_context()
        .ok_or_else(|| Error::Internal(crate::error::messages::NO_CLUSTER.to_string()))?;
    let (metrics, counts, snapshot) = tokio::join!(
        crate::metrics::get_node_metrics(state),
        side_counts(&client, scope.as_deref()),
        state.overview_cache.snapshot(&context, || client.clone()),
    );
    let sides = Sides {
        counts,
        // Live usage is best-effort: metrics-server is not installed everywhere.
        usage_by_node: usage_index(metrics.ok()),
    };
    match snapshot {
        Some(snapshot) => Ok(from_snapshot(&snapshot, scope.as_deref(), sides)),
        None => by_listing(&client, scope.as_deref(), sides).await,
    }
}

/// The stores' objects in scope; nodes are the cluster's whichever scope is
/// asked for, and the accounting pods stay cluster-wide.
struct Projected {
    scoped_pods: Vec<Arc<Pod>>,
    deployments: Vec<Arc<Deployment>>,
    jobs: Vec<Arc<Job>>,
    events: Vec<Arc<Event>>,
}

fn project(snapshot: &Snapshot, scope: Option<&[String]>) -> Projected {
    fn keep<K>(
        items: &[Arc<K>],
        scope: Option<&[String]>,
        of: fn(&K) -> Option<&str>,
    ) -> Vec<Arc<K>> {
        items
            .iter()
            .filter(|item| {
                scope.is_none_or(|names| {
                    of(item).is_some_and(|namespace| names.iter().any(|name| name == namespace))
                })
            })
            .cloned()
            .collect()
    }
    Projected {
        scoped_pods: keep(&snapshot.pods, scope, |p| p.metadata.namespace.as_deref()),
        deployments: keep(&snapshot.deployments, scope, |d| {
            d.metadata.namespace.as_deref()
        }),
        jobs: keep(&snapshot.jobs, scope, |j| j.metadata.namespace.as_deref()),
        events: keep(&snapshot.events, scope, |e| e.metadata.namespace.as_deref()),
    }
}

fn from_snapshot(snapshot: &Snapshot, scope: Option<&[String]>, sides: Sides) -> ClusterOverview {
    let scoped = project(snapshot, scope);
    build_overview(&OverviewInputs {
        scoped_pods: &scoped.scoped_pods,
        accounting_pods: &snapshot.pods,
        nodes: &snapshot.nodes,
        // A store only serves while every watch it holds is allowed and
        // healthy, so the capacity view is known here by construction.
        nodes_known: true,
        deployments: &scoped.deployments,
        deployments_known: true,
        jobs: Some(&scoped.jobs),
        events: &scoped.events,
        usage_by_node: sides.usage_by_node,
        counts: sides.counts,
        scope,
        now: Utc::now(),
        served_from: OverviewSource::Watch,
    })
}

fn arcs<T>(items: impl IntoIterator<Item = T>) -> Vec<Arc<T>> {
    items.into_iter().map(Arc::new).collect()
}

/// One reach's lists: a namespace's, or the whole cluster's.
struct Listed {
    pods: Result<Vec<Pod>>,
    deployments: Option<Vec<Deployment>>,
    jobs: Option<Vec<Job>>,
    events: Vec<Event>,
}

async fn list_in(client: &Client, reach: Option<&str>) -> Listed {
    let params = ListParams::default();
    let pods_api: Api<Pod> = api_in(client, reach);
    let deployments_api: Api<Deployment> = api_in(client, reach);
    let jobs_api: Api<Job> = api_in(client, reach);
    let events_api: Api<Event> = api_in(client, reach);
    let (pods, deployments, jobs, events) = tokio::join!(
        pods_api.list(&params),
        deployments_api.list(&params),
        jobs_api.list(&params),
        list_warning_events(&events_api),
    );
    Listed {
        pods: pods.map(|list| list.items).map_err(Error::from),
        deployments: deployments.ok().map(|list| list.items),
        jobs: jobs.ok().map(|list| list.items),
        events,
    }
}

/// Every reach's lists as one.
struct Gathered {
    pods: Vec<Arc<Pod>>,
    deployments: Vec<Arc<Deployment>>,
    deployments_known: bool,
    jobs: Option<Vec<Arc<Job>>>,
    events: Vec<Arc<Event>>,
}

/// Joins the reaches by the rule the counts follow: what one namespace
/// refused is never filled in by the ones that answered.
///
/// Pods are the load-bearing read, so a namespace that refuses them fails the
/// whole overview. Deployments feed problems as well as a count: the problems
/// of the namespaces that answered stand, and the count goes unknown. Jobs are
/// a count and a composition, both unknown when any namespace refused.
fn gather(parts: Vec<Listed>) -> Result<Gathered> {
    let deployments_known = parts.iter().all(|part| part.deployments.is_some());
    let jobs_known = parts.iter().all(|part| part.jobs.is_some());
    let mut gathered = Gathered {
        pods: Vec::new(),
        deployments: Vec::new(),
        deployments_known,
        jobs: jobs_known.then(Vec::new),
        events: Vec::new(),
    };
    for part in parts {
        gathered.pods.extend(arcs(part.pods?));
        gathered
            .deployments
            .extend(arcs(part.deployments.into_iter().flatten()));
        if let Some(jobs) = gathered.jobs.as_mut() {
            jobs.extend(arcs(part.jobs.into_iter().flatten()));
        }
        gathered.events.extend(arcs(part.events));
    }
    Ok(gathered)
}

async fn by_listing(
    client: &Client,
    scope: Option<&[String]>,
    sides: Sides,
) -> Result<ClusterOverview> {
    let params = ListParams::default();
    let nodes_api: Api<Node> = Api::all(client.clone());
    // Scheduler headroom and the node rows describe the cluster, not the
    // selection: dividing one namespace's requests by every node's allocatable
    // would state a reserved share that is nobody's number. So the accounting
    // pass always runs on a cluster-wide pod list — read once for the whole
    // scope, and only when there is one, since otherwise the scoped list
    // already is that list.
    let cluster_pods_api: Api<Pod> = Api::all(client.clone());
    let cluster_pods_request = async {
        match scope {
            Some(_) => Some(cluster_pods_api.list(&params).await),
            None => None,
        }
    };

    let (parts, cluster_pods_result, nodes_result) = tokio::join!(
        join_all(
            reaches(scope)
                .into_iter()
                .map(|reach| list_in(client, reach))
        ),
        cluster_pods_request,
        nodes_api.list(&params),
    );

    // With no pods in scope there is no screen to draw. On the whole cluster
    // the scoped list is the cluster-wide one, so a token with no cluster
    // read rights fails here and the page shows the refusal (and says to
    // pick a namespace).
    let listed = gather(parts)?;
    // The node list and the cluster-wide accounting pods are cluster-scoped
    // reads a namespace-restricted token is refused. They degrade to "unknown"
    // rather than failing the whole overview, so a scoped user still sees the
    // workloads they CAN read with the capacity view marked no-access.
    let cluster_pods = cluster_pods_result
        .transpose()
        .ok()
        .flatten()
        .map(|list| arcs(list.items));
    let nodes = nodes_result.ok().map(|list| arcs(list.items));
    let accounting_known = scope.is_none() || cluster_pods.is_some();
    let nodes_known = nodes.is_some() && accounting_known;

    Ok(build_overview(&OverviewInputs {
        scoped_pods: &listed.pods,
        accounting_pods: cluster_pods.as_deref().unwrap_or(&listed.pods),
        nodes: nodes.as_deref().unwrap_or_default(),
        nodes_known,
        deployments: &listed.deployments,
        deployments_known: listed.deployments_known,
        jobs: listed.jobs.as_deref(),
        events: &listed.events,
        usage_by_node: sides.usage_by_node,
        counts: sides.counts,
        scope,
        now: Utc::now(),
        served_from: OverviewSource::List,
    }))
}

#[cfg(test)]
// Every float here is compared against a value the arithmetic under test
// produces exactly, so an exact comparison is the assertion we want.
#[allow(clippy::float_cmp)]
mod tests {
    use super::*;

    use crate::metrics::{MetricsStatus, NodeMetrics};
    use k8s_openapi::api::batch::v1::{JobCondition, JobStatus};
    use k8s_openapi::api::core::v1::{
        Container, ContainerState, ContainerStateRunning, ContainerStateTerminated,
        ContainerStateWaiting, ContainerStatus, NodeCondition, NodeSpec, NodeStatus, PodCondition,
        PodSpec, PodStatus, ResourceRequirements,
    };
    use k8s_openapi::apimachinery::pkg::api::resource::Quantity;
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::Time;
    use kube::core::ObjectMeta;

    fn at(now: DateTime<Utc>, seconds_ago: i64) -> Time {
        Time(
            crate::utils::moment::as_cluster_time(now - chrono::Duration::seconds(seconds_ago))
                .expect("an instant this test wrote itself"),
        )
    }

    fn pod(name: &str, status: PodStatus) -> Pod {
        Pod {
            metadata: ObjectMeta {
                name: Some(name.to_string()),
                namespace: Some("default".to_string()),
                ..Default::default()
            },
            status: Some(status),
            ..Default::default()
        }
    }

    fn pending_pod(name: &str, now: DateTime<Utc>, pending_for: i64) -> Pod {
        let mut p = pod(
            name,
            PodStatus {
                phase: Some("Pending".to_string()),
                conditions: Some(vec![PodCondition {
                    type_: "PodScheduled".to_string(),
                    status: "False".to_string(),
                    last_transition_time: Some(at(now, pending_for)),
                    message: Some("0/3 nodes are available".to_string()),
                    ..Default::default()
                }]),
                ..Default::default()
            },
        );
        p.metadata.creation_timestamp = Some(at(now, pending_for));
        p
    }

    fn quantities(pairs: &[(&str, &str)]) -> BTreeMap<String, Quantity> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), Quantity((*v).to_string())))
            .collect()
    }

    fn node(name: &str, cpu: &str, memory: &str) -> Node {
        Node {
            metadata: ObjectMeta {
                name: Some(name.to_string()),
                ..Default::default()
            },
            status: Some(k8s_openapi::api::core::v1::NodeStatus {
                allocatable: Some(quantities(&[("cpu", cpu), ("memory", memory)])),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    fn scheduled_pod(name: &str, namespace: &str, node_name: &str, cpu: &str, memory: &str) -> Pod {
        Pod {
            metadata: ObjectMeta {
                name: Some(name.to_string()),
                namespace: Some(namespace.to_string()),
                ..Default::default()
            },
            spec: Some(PodSpec {
                node_name: Some(node_name.to_string()),
                containers: vec![Container {
                    name: "app".to_string(),
                    resources: Some(ResourceRequirements {
                        requests: Some(quantities(&[("cpu", cpu), ("memory", memory)])),
                        ..Default::default()
                    }),
                    ..Default::default()
                }],
                ..Default::default()
            }),
            status: Some(PodStatus {
                phase: Some("Running".to_string()),
                ..Default::default()
            }),
        }
    }

    fn overview(
        scoped_pods: &[Pod],
        accounting_pods: &[Pod],
        namespace: Option<&str>,
    ) -> ClusterOverview {
        let scope = namespace.map(|name| vec![name.to_string()]);
        build_overview(&OverviewInputs {
            scoped_pods: &arcs(scoped_pods.to_vec()),
            accounting_pods: &arcs(accounting_pods.to_vec()),
            nodes: &arcs(vec![node("n1", "4", "8Gi"), node("n2", "4", "8Gi")]),
            nodes_known: true,
            deployments: &[],
            deployments_known: true,
            jobs: Some(&[]),
            events: &[],
            usage_by_node: None,
            counts: ResourceCounts::default(),
            scope: scope.as_deref(),
            served_from: OverviewSource::List,
            now: Utc::now(),
        })
    }

    fn node_metrics_response(
        status: MetricsStatusKind,
        data: Vec<NodeMetrics>,
    ) -> NodeMetricsResponse {
        NodeMetricsResponse {
            status: MetricsStatus {
                status,
                message: None,
            },
            data,
        }
    }

    fn problem(reason: &str, severity: ProblemSeverity, since: Option<&str>) -> ClusterProblem {
        ClusterProblem {
            severity,
            kind: "Pod".to_string(),
            name: reason.to_string(),
            namespace: None,
            reason: reason.to_string(),
            detail: None,
            since: since.map(str::to_string),
            restarts: None,
        }
    }

    /// A namespace-scoped token is refused the cluster-wide node and pod reads
    /// the capacity view needs, so those come back unknown. The workloads the
    /// user CAN read stay on the screen; the nodes and scheduler are marked
    /// no-access, and the node count is `None`, never a confident `Some(0)`.
    #[test]
    fn a_refused_node_read_leaves_the_capacity_view_unknown_not_empty() {
        let pods = [
            pod(
                "api",
                PodStatus {
                    phase: Some("Running".to_string()),
                    ..Default::default()
                },
            ),
            pod(
                "web",
                PodStatus {
                    phase: Some("Running".to_string()),
                    ..Default::default()
                },
            ),
        ];
        let result = build_overview(&OverviewInputs {
            scoped_pods: &arcs(pods.clone()),
            accounting_pods: &arcs(pods),
            // Nodes were handed in, but the flag says they could not be read:
            // they must be ignored, not drawn and not counted.
            nodes: &arcs(vec![node("n1", "4", "8Gi")]),
            nodes_known: false,
            deployments: &[],
            deployments_known: true,
            jobs: Some(&[]),
            events: &[],
            usage_by_node: None,
            counts: ResourceCounts::default(),
            scope: Some(&["team-a".to_string()]),
            served_from: OverviewSource::List,
            now: Utc::now(),
        });

        assert!(!result.nodes_known, "a refused node read is unknown");
        assert!(
            result.nodes.is_empty(),
            "no node rows are drawn from a read that was refused"
        );
        assert_eq!(
            result.counts.nodes, None,
            "the node count is unknown, not zero"
        );
        // The workloads the user could read are still on the screen.
        assert_eq!(result.counts.pods, Some(2));
        assert_eq!(result.pods.running, 2);
    }

    /// A missing metrics-server comes back as `Ok` with a `NotInstalled`
    /// status and no data. Trusting the `Result` made the UI report "actually
    /// using 0m (0%)" as measured fact on every such cluster.
    #[test]
    fn metrics_unavailable_leaves_usage_none() {
        for status in [
            MetricsStatusKind::NotInstalled,
            MetricsStatusKind::Forbidden,
            MetricsStatusKind::Error,
        ] {
            let usage = usage_index(Some(node_metrics_response(status, vec![])));
            assert!(usage.is_none(), "non-Available status must yield no usage");

            let aggregate = summarize_nodes(
                &[Node {
                    metadata: ObjectMeta {
                        name: Some("n1".to_string()),
                        ..Default::default()
                    },
                    ..Default::default()
                }],
                &BTreeMap::new(),
                &BTreeMap::new(),
                usage.as_ref(),
            );
            assert!(aggregate.scheduler.cpu.usage.is_none());
            assert!(aggregate.scheduler.memory.usage.is_none());
            assert!(aggregate.summaries[0].cpu.usage.is_none());
            assert!(aggregate.summaries[0].memory.usage.is_none());
        }
    }

    /// `Available` with nothing in it measures nothing. Reporting it as
    /// available turned the cluster totals into `Some(0.0)` and put the same
    /// "actually using 0m (0%)" claim back on screen.
    #[test]
    fn metrics_available_without_data_is_unavailable() {
        assert!(usage_index(Some(node_metrics_response(
            MetricsStatusKind::Available,
            vec![],
        )))
        .is_none());

        let result = build_overview(&OverviewInputs {
            scoped_pods: &[],
            accounting_pods: &[],
            nodes: &arcs(vec![node("n1", "4", "8Gi")]),
            nodes_known: true,
            deployments: &[],
            deployments_known: true,
            jobs: Some(&[]),
            events: &[],
            usage_by_node: usage_index(Some(node_metrics_response(
                MetricsStatusKind::Available,
                vec![],
            ))),
            counts: ResourceCounts::default(),
            scope: None,
            now: Utc::now(),
            served_from: OverviewSource::List,
        });
        assert!(!result.metrics_available);
        assert!(result.scheduler.cpu.usage.is_none());
        assert!(result.scheduler.memory.usage.is_none());
    }

    /// The scheduler panel divides requests by every node's allocatable, so
    /// feeding it one namespace's requests printed a "6% reserved" that
    /// describes no real quantity.
    #[test]
    fn namespace_scope_keeps_resource_accounting_cluster_wide() {
        let scoped = vec![scheduled_pod("api", "app", "n1", "500m", "1Gi")];
        let cluster = vec![
            scheduled_pod("api", "app", "n1", "500m", "1Gi"),
            scheduled_pod("db", "data", "n1", "1", "2Gi"),
            scheduled_pod("agent", "kube-system", "n2", "250m", "512Mi"),
        ];

        let result = overview(&scoped, &cluster, Some("app"));

        assert_eq!(result.scheduler.cpu.allocatable, 8000.0);
        assert_eq!(result.scheduler.cpu.requested, 1750.0);
        assert_eq!(result.nodes[0].pod_count, 2);
        assert_eq!(result.nodes[1].pod_count, 1);
        assert_eq!(result.nodes[0].cpu.requested, 1500.0);
        // The scoped list still owns the counts that are about the selection.
        assert_eq!(result.counts.pods, Some(1));
    }

    /// Unscoped, the same slice does both jobs and the numbers must not move.
    #[test]
    fn unscoped_accounting_matches_the_single_pod_list() {
        let pods = vec![
            scheduled_pod("api", "app", "n1", "500m", "1Gi"),
            scheduled_pod("agent", "kube-system", "n2", "250m", "512Mi"),
        ];

        let result = overview(&pods, &pods, None);

        assert_eq!(result.scheduler.cpu.requested, 750.0);
        assert_eq!(result.counts.pods, Some(2));
        assert_eq!(result.namespaces.len(), 2);
    }

    /// One row restating the namespace you already picked, under a heading
    /// counting "namespaces with workloads: 1", is worse than no card.
    #[test]
    fn namespaces_breakdown_is_dropped_when_scoped() {
        let scoped = vec![scheduled_pod("api", "app", "n1", "500m", "1Gi")];
        assert!(overview(&scoped, &scoped, Some("app"))
            .namespaces
            .is_empty());
    }

    #[test]
    fn namespace_loads_are_sorted_by_pod_count() {
        let pods = vec![
            scheduled_pod("a", "quiet", "n1", "100m", "64Mi"),
            scheduled_pod("b", "busy", "n1", "100m", "64Mi"),
            scheduled_pod("c", "busy", "n2", "100m", "64Mi"),
        ];
        let loads = namespace_loads(&pods, &[]);
        assert_eq!(loads[0].name, "busy");
        assert_eq!(loads[0].pod_count, 2);
        assert_eq!(loads[1].name, "quiet");
    }

    /// The namespace picker counted problems in the list after it was cut to
    /// fifty, worst first: fifty-one failed pods in one namespace pushed every
    /// other namespace's warnings off it, and those namespaces read "0".
    #[test]
    fn a_namespace_counts_its_problems_before_the_list_is_cut() {
        let now = Utc::now();
        let mut pods: Vec<Pod> = (0..=MAX_PROBLEMS)
            .map(|i| {
                let mut failed = pod(
                    &format!("job-{i}"),
                    PodStatus {
                        phase: Some("Failed".to_string()),
                        ..Default::default()
                    },
                );
                failed.metadata.namespace = Some("prod".to_string());
                failed
            })
            .collect();
        let mut waiting = pending_pod("web", now, 3600);
        waiting.metadata.namespace = Some("dev".to_string());
        pods.push(waiting);

        let result = build_overview(&OverviewInputs {
            scoped_pods: &arcs(pods.clone()),
            accounting_pods: &arcs(pods),
            nodes: &[],
            nodes_known: true,
            deployments: &[],
            deployments_known: true,
            jobs: Some(&[]),
            events: &[],
            usage_by_node: None,
            counts: ResourceCounts::default(),
            scope: None,
            served_from: OverviewSource::List,
            now,
        });

        assert!(result
            .problems
            .iter()
            .all(|p| p.namespace.as_deref() != Some("dev")));
        let count = |ns: &str| {
            result
                .namespaces
                .iter()
                .find(|load| load.name == ns)
                .map(|load| load.problem_count)
        };
        assert_eq!(count("dev"), Some(1));
        assert_eq!(count("prod"), Some(MAX_PROBLEMS + 1));
    }

    /// Terminal pods hold no reservation; counting them would inflate both the
    /// per-node pod count and the reserved share.
    #[test]
    fn terminal_pods_are_left_out_of_the_accounting() {
        let mut finished = scheduled_pod("backup", "app", "n1", "500m", "1Gi");
        finished.status = Some(PodStatus {
            phase: Some("Succeeded".to_string()),
            ..Default::default()
        });
        let pods = vec![finished, scheduled_pod("api", "app", "n1", "250m", "512Mi")];

        let accounting = account_by_node(&pods);
        assert_eq!(accounting.pods.get("n1"), Some(&1));
        assert_eq!(accounting.requests.get("n1").map(|r| r.0), Some(250.0));
    }

    /// KEP-2837: a pod-level request is what the scheduler reserves, so the
    /// accounting uses it in place of the container sum, per resource. A pod
    /// asking for 2 CPU at the pod level over a 500m container reserves 2, not
    /// 2.5 and not 0.5. The pod detail page aggregates the same way — one fact,
    /// both readers.
    #[test]
    fn a_pod_level_request_replaces_the_container_sum() {
        let mut pod = scheduled_pod("p", "app", "n1", "500m", "256Mi");
        pod.spec.as_mut().unwrap().resources = Some(ResourceRequirements {
            requests: Some(quantities(&[("cpu", "2"), ("memory", "1Gi")])),
            ..Default::default()
        });
        let (cpu, memory) = pod_requests(&pod);
        assert_eq!(cpu, parse_cpu("2"), "pod-level CPU stands in for the sum");
        assert_eq!(memory, parse_memory("1Gi"), "pod-level memory too");

        // No pod-level request: the container sum still stands.
        assert_eq!(
            pod_requests(&scheduled_pod("q", "app", "n1", "500m", "256Mi")).0,
            parse_cpu("500m")
        );
    }

    #[test]
    fn metrics_available_indexes_usage_by_node() {
        let usage = usage_index(Some(node_metrics_response(
            MetricsStatusKind::Available,
            vec![NodeMetrics {
                name: "n1".to_string(),
                cpu_millicores: Some(250.0),
                memory_bytes: Some(1024),
            }],
        )))
        .expect("available metrics must yield an index");

        assert_eq!(usage.get("n1"), Some(&(250.0, 1024)));
    }

    /// Every pod is Pending for its first seconds. Reporting that made the
    /// "N problems need attention" panel permanently red on any cluster with
    /// `CronJobs`, which is the same as having no panel at all.
    #[test]
    fn pending_pod_is_reported_only_after_the_grace_period() {
        let now = Utc::now();
        let problems = pod_problems(
            &[
                pending_pod("fresh", now, PENDING_GRACE_SECONDS - 10),
                pending_pod("stuck", now, PENDING_GRACE_SECONDS + 10),
            ],
            now,
        );

        let names: Vec<_> = problems.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, vec!["stuck"]);
        assert_eq!(problems[0].reason, "Pending");
    }

    /// Without a `PodScheduled` condition the creation timestamp is the only
    /// clock available, and an undated pod must not be silently swallowed.
    #[test]
    fn pending_grace_falls_back_to_creation_timestamp() {
        let now = Utc::now();
        let mut fresh = pod(
            "fresh",
            PodStatus {
                phase: Some("Pending".to_string()),
                ..Default::default()
            },
        );
        fresh.metadata.creation_timestamp = Some(at(now, 5));
        let undated = pod(
            "undated",
            PodStatus {
                phase: Some("Pending".to_string()),
                ..Default::default()
            },
        );

        let problems = pod_problems(&[fresh, undated], now);
        let names: Vec<_> = problems.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, vec!["undated"]);
    }

    /// A Job pod that ran and lost produces no waiting reason and is skipped
    /// by the resource accounting, so without an explicit branch it never
    /// appeared on the one screen whose job is showing what is broken.
    #[test]
    fn failed_pod_is_reported_as_critical() {
        let now = Utc::now();
        let problems = pod_problems(
            &[pod(
                "migrate",
                PodStatus {
                    phase: Some("Failed".to_string()),
                    reason: Some("Evicted".to_string()),
                    message: Some("The node was low on resource: memory".to_string()),
                    ..Default::default()
                },
            )],
            now,
        );

        assert_eq!(problems.len(), 1);
        assert_eq!(problems[0].severity, ProblemSeverity::Critical);
        assert_eq!(problems[0].reason, "Evicted");
        assert_eq!(
            problems[0].detail,
            Some(ProblemDetail::Said {
                text: "The node was low on resource: memory".to_string()
            })
        );
    }

    #[test]
    fn succeeded_pod_is_not_a_problem() {
        let now = Utc::now();
        let problems = pod_problems(
            &[pod(
                "backup",
                PodStatus {
                    phase: Some("Succeeded".to_string()),
                    ..Default::default()
                },
            )],
            now,
        );
        assert!(problems.is_empty());
    }

    /// A pod that restarted `count` times, the last of them `ago` seconds
    /// back, and has been `Running` ever since.
    fn restarted_pod(name: &str, now: DateTime<Utc>, count: i32, ago: Option<i64>) -> Pod {
        pod(
            name,
            PodStatus {
                phase: Some("Running".to_string()),
                container_statuses: Some(vec![ContainerStatus {
                    name: "app".to_string(),
                    restart_count: count,
                    ready: true,
                    started: Some(true),
                    state: Some(ContainerState {
                        running: Some(ContainerStateRunning::default()),
                        ..Default::default()
                    }),
                    last_state: ago.map(|seconds| ContainerState {
                        terminated: Some(ContainerStateTerminated {
                            exit_code: 1,
                            finished_at: Some(at(now, seconds)),
                            ..Default::default()
                        }),
                        ..Default::default()
                    }),
                    ..Default::default()
                }]),
                ..Default::default()
            },
        )
    }

    /// Reported from the field: somebody rebooted a bare-metal cluster, every
    /// pod on it restarted, and two days later the Overview badge still said
    /// one problem — about a pod that was `Running`, ready, and had not
    /// restarted since. A restart count never falls, so "has restarted" was
    /// true for the rest of that pod's life.
    #[test]
    fn a_pod_that_stopped_restarting_two_days_ago_is_not_a_problem() {
        let now = Utc::now();
        let problems = pod_problems(&[restarted_pod("csi", now, 7, Some(2 * 24 * 3600))], now);
        assert!(
            problems.is_empty(),
            "a pod that has been up for two days is not restarting: {problems:?}"
        );
    }

    /// And one that is genuinely flapping still is. `CrashLoopBackOff` waits
    /// at most five minutes, so anything alive comes round well inside the
    /// window.
    #[test]
    fn a_pod_still_flapping_is_reported() {
        let now = Utc::now();
        let problems = pod_problems(&[restarted_pod("flapper", now, 7, Some(120))], now);
        assert_eq!(problems.len(), 1);
        assert_eq!(problems[0].reason, "Restarting");
        assert_eq!(problems[0].restarts, Some(7));
    }

    /// The distinction the field exists for. A row that quotes the cluster
    /// has to keep the cluster's wording; a row this app composes has to
    /// arrive as a name, or the reader's language never reaches it. Both
    /// were `Option<String>` once, which is exactly how three English
    /// sentences ended up on the first screen of a Russian interface.
    #[test]
    fn our_sentences_are_named_and_the_cluster_is_quoted() {
        let now = Utc::now();

        let ours = pod_problems(&[restarted_pod("flapper", now, 7, Some(120))], now);
        assert_eq!(ours[0].detail, Some(ProblemDetail::Restarts { n: 7 }));

        let cordoned = node_problems(&[unschedulable_node("worker-1")]);
        assert_eq!(cordoned[0].detail, Some(ProblemDetail::Unschedulable));

        let quoted = pod_problems(
            &[pod(
                "migrate",
                PodStatus {
                    phase: Some("Failed".to_string()),
                    message: Some("The node was low on resource: memory".to_string()),
                    ..Default::default()
                },
            )],
            now,
        );
        assert_eq!(
            quoted[0].detail,
            Some(ProblemDetail::Said {
                text: "The node was low on resource: memory".to_string()
            })
        );
    }

    fn unschedulable_node(name: &str) -> Node {
        Node {
            metadata: ObjectMeta {
                name: Some(name.to_string()),
                ..Default::default()
            },
            spec: Some(NodeSpec {
                unschedulable: Some(true),
                ..Default::default()
            }),
            status: Some(NodeStatus {
                conditions: Some(vec![k8s_openapi::api::core::v1::NodeCondition {
                    type_: "Ready".to_string(),
                    status: "True".to_string(),
                    ..Default::default()
                }]),
                ..Default::default()
            }),
        }
    }

    /// The row shows the age of `since`. Dating it by the pod put "12d" on
    /// something that happened two minutes ago.
    #[test]
    fn the_problem_is_dated_by_the_restart_not_by_the_pod() {
        let now = Utc::now();
        let problems = pod_problems(&[restarted_pod("flapper", now, 9, Some(120))], now);
        let since: DateTime<Utc> = problems[0]
            .since
            .as_deref()
            .expect("a restart problem carries the time of the restart")
            .parse()
            .expect("rfc3339");
        assert!(
            (now - since).num_seconds() < 300,
            "expected the last restart, got {since}"
        );
    }

    /// Not knowing when it happened is not evidence that it is over — the
    /// same rule the Pending branch follows for an undated pod.
    #[test]
    fn restarts_with_no_recorded_time_still_report() {
        let now = Utc::now();
        let problems = pod_problems(&[restarted_pod("undated", now, 7, None)], now);
        assert_eq!(problems.len(), 1);
        assert_eq!(problems[0].reason, "Restarting");
    }

    /// Below the threshold nothing is said, however recent.
    #[test]
    fn a_couple_of_restarts_are_not_worth_a_row() {
        let now = Utc::now();
        let problems = pod_problems(&[restarted_pod("fine", now, 2, Some(30))], now);
        assert!(problems.is_empty());
    }

    #[test]
    fn problems_are_capped_with_an_accurate_dropped_count() {
        let overflow = 7;
        let problems: Vec<_> = (0..MAX_PROBLEMS + overflow)
            .map(|i| {
                problem(
                    "Pending",
                    ProblemSeverity::Critical,
                    Some(&format!("2026-08-05T00:{i:02}:00Z")),
                )
            })
            .collect();

        let (kept, truncated) = rank_and_cap(problems);
        assert_eq!(kept.len(), MAX_PROBLEMS);
        assert_eq!(truncated, overflow);
    }

    #[test]
    fn cap_keeps_the_worst_and_oldest_rows() {
        let mut problems = vec![problem(
            "Restarting",
            ProblemSeverity::Warning,
            Some("2026-08-05T00:00:00Z"),
        )];
        problems.extend((0..MAX_PROBLEMS).map(|i| {
            problem(
                "Pending",
                ProblemSeverity::Critical,
                Some(&format!("2026-08-05T01:{i:02}:00Z")),
            )
        }));

        let (kept, truncated) = rank_and_cap(problems);
        assert_eq!(truncated, 1);
        assert!(
            kept.iter().all(|p| p.severity == ProblemSeverity::Critical),
            "the warning must be the row dropped, not a critical one"
        );
    }

    #[test]
    fn short_problem_lists_are_not_truncated() {
        let (kept, truncated) = rank_and_cap(vec![problem(
            "Pending",
            ProblemSeverity::Critical,
            Some("2026-08-05T00:00:00Z"),
        )]);
        assert_eq!(kept.len(), 1);
        assert_eq!(truncated, 0);
    }

    fn page_meta(continue_token: Option<&str>, remaining: Option<i64>) -> kube::core::ListMeta {
        kube::core::ListMeta {
            continue_: continue_token.map(ToString::to_string),
            remaining_item_count: remaining,
            ..Default::default()
        }
    }

    /// The whole point of the optional counts, now that a count is one page
    /// rather than the collection. A page the apiserver says nothing follows
    /// has counted itself; a page it *does* have more after is only a count
    /// if it tells us how many more. Answering that case with the page size
    /// would print "500 Events" on a cluster holding fifty thousand — and a
    /// count nobody can back is exactly what `None` exists for, the same way
    /// a refused list stays unknown instead of becoming zero.
    #[test]
    fn a_page_only_counts_the_collection_when_it_can() {
        assert_eq!(tally(&page_meta(None, None), 12), Some(12));
        assert_eq!(tally(&page_meta(Some(""), None), 12), Some(12));
        assert_eq!(
            tally(&page_meta(Some("tok"), Some(49_500)), 500),
            Some(50_000)
        );
        assert_eq!(tally(&page_meta(Some("tok"), None), 500), None);
    }

    fn names(names: &[&str]) -> Vec<String> {
        names.iter().map(ToString::to_string).collect()
    }

    fn in_namespace<K: Default + kube::Resource<DynamicType = ()>>(namespace: &str) -> K {
        let mut object = K::default();
        object.meta_mut().namespace = Some(namespace.to_string());
        object
    }

    /// A namespaced overview from the stores must be the namespace's own
    /// objects on a cluster-wide capacity view: the nodes and the accounting
    /// pods stay the cluster's, everything else is the selection's.
    #[test]
    fn a_projection_keeps_the_namespace_and_the_whole_clusters_nodes() {
        let snapshot = Snapshot {
            pods: arcs([
                in_namespace::<Pod>("app"),
                in_namespace::<Pod>("app"),
                in_namespace::<Pod>("data"),
            ]),
            nodes: arcs([Node::default(), Node::default()]),
            deployments: arcs([in_namespace::<Deployment>("app"), in_namespace("data")]),
            jobs: arcs([in_namespace::<Job>("data")]),
            events: arcs([in_namespace::<Event>("app"), in_namespace("data")]),
        };
        let app = project(&snapshot, Some(&names(&["app"])));
        assert_eq!(app.scoped_pods.len(), 2);
        assert_eq!(app.deployments.len(), 1);
        assert_eq!(app.jobs.len(), 0);
        assert_eq!(app.events.len(), 1);
        let whole = project(&snapshot, None);
        assert_eq!(whole.scoped_pods.len(), 3);
        assert_eq!(whole.deployments.len(), 2);
        assert_eq!(whole.jobs.len(), 1);
        assert_eq!(whole.events.len(), 2);
    }

    /// A scope of several namespaces is every one of them from the stores,
    /// and nothing of the namespaces outside it. Matching only the first
    /// name would answer for a third of a three-namespace window.
    #[test]
    fn a_projection_of_several_namespaces_keeps_each_and_nothing_else() {
        let snapshot = Snapshot {
            pods: arcs([
                in_namespace::<Pod>("app"),
                in_namespace::<Pod>("data"),
                in_namespace::<Pod>("data"),
                in_namespace::<Pod>("kube-system"),
            ]),
            nodes: arcs([Node::default()]),
            deployments: arcs([
                in_namespace::<Deployment>("data"),
                in_namespace("kube-system"),
            ]),
            jobs: arcs([in_namespace::<Job>("app")]),
            events: arcs([in_namespace::<Event>("kube-system")]),
        };
        let both = project(&snapshot, Some(&names(&["app", "data"])));
        assert_eq!(both.scoped_pods.len(), 3);
        assert_eq!(both.deployments.len(), 1);
        assert_eq!(both.jobs.len(), 1);
        assert!(both.events.is_empty());
    }

    /// What the line above used to claim, asserted where it can fail.
    ///
    /// `project` takes the snapshot by reference and returns no nodes at
    /// all, so `snapshot.nodes.len()` was the test's own input read back:
    /// no edit to the projection or to `from_snapshot` could move it.
    /// Reserved capacity is the *cluster's* number — a namespace's requests
    /// over every node's allocatable — and narrowing the nodes to the
    /// namespace is the mistake this exists to catch.
    #[test]
    fn the_capacity_view_stays_the_whole_clusters_however_the_scope_narrows() {
        let snapshot = Snapshot {
            pods: arcs([
                in_namespace::<Pod>("app"),
                in_namespace::<Pod>("app"),
                in_namespace::<Pod>("data"),
            ]),
            nodes: arcs([Node::default(), Node::default()]),
            deployments: arcs([]),
            jobs: arcs([]),
            events: arcs([]),
        };
        let sides = || Sides {
            counts: ResourceCounts::default(),
            usage_by_node: None,
        };

        let scoped = from_snapshot(&snapshot, Some(&names(&["app"])), sides());
        let whole = from_snapshot(&snapshot, None, sides());

        assert!(
            !whole.nodes.is_empty(),
            "the assertion is worthless if there were no nodes to lose"
        );
        assert_eq!(
            scoped.nodes.len(),
            whole.nodes.len(),
            "a namespace does not have fewer nodes than its cluster"
        );
        assert!(
            scoped.nodes_known,
            "the stores serve only while every watch is healthy"
        );
    }

    /// The stores hold objects with their bulk stripped; every fact the
    /// overview derives from a pod must survive the strip, or the cached
    /// answer would differ from the listed one.
    #[test]
    fn the_facts_the_overview_reads_survive_the_store_strip() {
        let now = Utc::now();
        let mut pod = restarted_pod("api", now, 7, Some(120));
        pod.metadata.annotations = Some(
            [(
                "kubectl.kubernetes.io/last-applied-configuration".to_string(),
                "{}".repeat(200),
            )]
            .into_iter()
            .collect(),
        );
        let spec = pod.spec.get_or_insert_default();
        spec.node_name = Some("n1".to_string());
        spec.containers = vec![Container {
            name: "api".to_string(),
            env: Some(vec![k8s_openapi::api::core::v1::EnvVar {
                name: "A".to_string(),
                value: Some("b".repeat(500)),
                ..Default::default()
            }]),
            resources: Some(ResourceRequirements {
                requests: Some(
                    [
                        ("cpu".to_string(), Quantity("500m".to_string())),
                        ("memory".to_string(), Quantity("1Gi".to_string())),
                    ]
                    .into_iter()
                    .collect(),
                ),
                ..Default::default()
            }),
            ..Default::default()
        }];
        let mut stripped = pod.clone();
        crate::overview::strip_pod(&mut stripped);

        assert_eq!(pod_problem(&stripped, now), pod_problem(&pod, now));
        assert_eq!(pod_requests(&stripped), pod_requests(&pod));
        assert_eq!(
            crate::resources::restarts(&stripped),
            crate::resources::restarts(&pod)
        );
        assert_eq!(is_terminal(&stripped), is_terminal(&pod));
        // The one pod field the store path needs that no assertion above
        // reads: the scheduler view accounts by node and silently skips a
        // pod without one, so a strip that took it would quietly empty the
        // capacity panel.
        assert_eq!(
            stripped.spec.as_ref().and_then(|s| s.node_name.as_deref()),
            Some("n1")
        );
        let before = serde_json::to_vec(&pod).unwrap().len();
        let after = serde_json::to_vec(&stripped).unwrap().len();
        assert!(
            after * 2 < before,
            "strip kept the bulk: {after} of {before} bytes"
        );
    }

    /// Where the answer came from, which the frontend shows. Flipping
    /// `from_snapshot`'s `OverviewSource::Watch` to `List` left every Rust
    /// test green: the only assertion on it is an `#[ignore]`d live test that
    /// loops until it sees `Watch` and never checks the fallback half. A scope
    /// of several namespaces is one snapshot, so it is watched or listed
    /// whole — never some namespaces of each.
    #[test]
    fn an_overview_built_from_the_stores_says_it_came_from_the_watch() {
        let snapshot = Snapshot {
            pods: arcs([in_namespace::<Pod>("app"), in_namespace("data")]),
            nodes: arcs([Node::default()]),
            deployments: arcs([]),
            jobs: arcs([]),
            events: arcs([]),
        };
        for scope in [None, Some(names(&["app", "data"]))] {
            let built = from_snapshot(
                &snapshot,
                scope.as_deref(),
                Sides {
                    counts: ResourceCounts::default(),
                    usage_by_node: None,
                },
            );
            assert_eq!(built.served_from, OverviewSource::Watch);
            assert_eq!(built.counts.pods, Some(2));
        }
    }

    /// The other four strips had no test at all: emptying `strip_node`,
    /// `strip_job` and `strip_event`, or adding `status = None` to
    /// `strip_deployment`, each left the whole suite green. The deployment
    /// one is the sharp case — `deployment_problems` reads `spec.replicas`
    /// and `status`, and `status` is exactly what a careless strip reaches
    /// for.
    #[test]
    fn what_the_overview_reads_off_the_other_kinds_survives_their_strips() {
        let mut deployment = Deployment {
            metadata: ObjectMeta {
                name: Some("api".to_string()),
                namespace: Some("shop".to_string()),
                annotations: Some(
                    [("last-applied".to_string(), "{}".repeat(200))]
                        .into_iter()
                        .collect(),
                ),
                ..Default::default()
            },
            spec: Some(k8s_openapi::api::apps::v1::DeploymentSpec {
                replicas: Some(3),
                ..Default::default()
            }),
            status: Some(k8s_openapi::api::apps::v1::DeploymentStatus {
                ready_replicas: Some(1),
                ..Default::default()
            }),
        };
        let before = deployment.clone();
        crate::overview::strip_deployment(&mut deployment);
        assert_eq!(
            deployment_problems([&deployment]),
            deployment_problems([&before]),
            "a Deployment strip that reached status would empty the panel"
        );
        assert!(
            deployment.metadata.annotations.is_none(),
            "a strip that keeps everything proves nothing"
        );

        let mut node = Node {
            metadata: ObjectMeta {
                name: Some("n1".to_string()),
                annotations: Some([("csi".to_string(), "x".repeat(400))].into_iter().collect()),
                ..Default::default()
            },
            status: Some(NodeStatus {
                conditions: Some(vec![NodeCondition {
                    type_: "Ready".to_string(),
                    status: "True".to_string(),
                    ..Default::default()
                }]),
                allocatable: Some(
                    [("cpu".to_string(), Quantity("4".to_string()))]
                        .into_iter()
                        .collect(),
                ),
                images: Some(vec![
                    k8s_openapi::api::core::v1::ContainerImage::default();
                    50
                ]),
                ..Default::default()
            }),
            ..Default::default()
        };
        let node_before = node.clone();
        crate::overview::strip_node(&mut node);
        // Compared as what the frontend receives, which is the only shape
        // both sides have in common.
        let seen = |n: &Node| {
            serde_json::to_value(
                summarize_nodes([n], &BTreeMap::new(), &BTreeMap::new(), None).summaries,
            )
            .expect("a node summary serialises")
        };
        assert_eq!(
            seen(&node),
            seen(&node_before),
            "the capacity view is derived from what the strip has to keep"
        );
        assert!(
            node.status
                .as_ref()
                .and_then(|s| s.images.as_ref())
                .is_none(),
            "a strip that keeps the image list proves nothing"
        );
    }

    /// A refusal on one kind must not take the rest of the screen with it.
    #[test]
    fn refused_kinds_report_none_while_the_rest_of_the_overview_stands() {
        let pods = vec![scheduled_pod("api", "app", "n1", "500m", "1Gi")];
        let result = build_overview(&OverviewInputs {
            scoped_pods: &arcs(pods.clone()),
            accounting_pods: &arcs(pods),
            nodes: &arcs(vec![node("n1", "4", "8Gi")]),
            nodes_known: true,
            deployments: &[],
            deployments_known: false,
            jobs: None,
            events: &[],
            usage_by_node: None,
            counts: ResourceCounts {
                services: Some(6),
                secrets: None,
                ..Default::default()
            },
            scope: None,
            now: Utc::now(),
            served_from: OverviewSource::List,
        });

        assert_eq!(result.counts.deployments, None);
        assert_eq!(result.counts.jobs, None);
        assert_eq!(result.counts.secrets, None);
        assert!(result.jobs.is_none());
        // The kinds that were readable still answer, and so does the screen.
        assert_eq!(result.counts.pods, Some(1));
        assert_eq!(result.counts.nodes, Some(1));
        assert_eq!(result.counts.services, Some(6));
        assert_eq!(result.scheduler.cpu.allocatable, 4000.0);
    }

    /// The lists the query already reads answer their own counts, and the
    /// pod count follows the selected namespace like every other scoped kind.
    #[test]
    fn counts_come_from_the_scoped_lists() {
        let scoped = vec![scheduled_pod("api", "app", "n1", "500m", "1Gi")];
        let cluster = vec![
            scheduled_pod("api", "app", "n1", "500m", "1Gi"),
            scheduled_pod("db", "data", "n1", "1", "2Gi"),
        ];
        let deployments = vec![Deployment::default(), Deployment::default()];
        let jobs = vec![Job::default()];

        let result = build_overview(&OverviewInputs {
            scoped_pods: &arcs(scoped),
            accounting_pods: &arcs(cluster),
            nodes: &arcs(vec![node("n1", "4", "8Gi"), node("n2", "4", "8Gi")]),
            nodes_known: true,
            deployments: &arcs(deployments),
            deployments_known: true,
            jobs: Some(&arcs(jobs)),
            events: &[],
            usage_by_node: None,
            counts: ResourceCounts::default(),
            scope: Some(&["app".to_string()]),
            now: Utc::now(),
            served_from: OverviewSource::List,
        });

        assert_eq!(result.counts.pods, Some(1));
        assert_eq!(result.counts.deployments, Some(2));
        assert_eq!(result.counts.jobs, Some(1));
        assert_eq!(result.counts.nodes, Some(2));
    }

    /// Counting a completed Job pod as healthy running workload is the bug
    /// this breakdown exists to kill: a nightly backup is not a live replica.
    #[test]
    fn pod_composition_separates_running_from_completed() {
        let phases = ["Running", "Succeeded", "Succeeded", "Pending", "Failed"];
        let pods: Vec<_> = phases
            .iter()
            .enumerate()
            .map(|(i, phase)| {
                pod(
                    &format!("p{i}"),
                    PodStatus {
                        phase: Some((*phase).to_string()),
                        ..Default::default()
                    },
                )
            })
            .collect();

        let composition = pod_composition(&pods);
        assert_eq!(composition.running, 1);
        assert_eq!(composition.succeeded, 2);
        assert_eq!(composition.pending, 1);
        assert_eq!(composition.failed, 1);
        assert_eq!(composition.crash_looping, 0);
    }

    /// A crash-looping pod reports phase Running while serving nothing. It
    /// stays inside `running` — the fields have to sum to the pod count — and
    /// is called out separately so the bar can carve it back out.
    #[test]
    fn crash_looping_pods_are_a_subset_of_running() {
        let mut looping = pod(
            "crash",
            PodStatus {
                phase: Some("Running".to_string()),
                ..Default::default()
            },
        );
        looping.status.as_mut().unwrap().container_statuses = Some(vec![ContainerStatus {
            name: "app".to_string(),
            state: Some(ContainerState {
                waiting: Some(ContainerStateWaiting {
                    reason: Some("CrashLoopBackOff".to_string()),
                    message: None,
                }),
                ..Default::default()
            }),
            ..Default::default()
        }]);

        let composition = pod_composition(&[looping]);
        assert_eq!(composition.running, 1);
        assert_eq!(composition.crash_looping, 1);
    }

    #[test]
    fn pods_with_no_phase_are_unknown_not_dropped() {
        let composition = pod_composition(&[pod("mystery", PodStatus::default())]);
        assert_eq!(composition.unknown, 1);
        assert_eq!(composition.running, 0);
    }

    /// A pod failure inside a Job that still has retries left is a retry.
    /// Only the controller's own `Failed` condition means the Job lost.
    #[test]
    fn job_composition_follows_the_controller_conditions() {
        let job = |condition: Option<(&str, &str)>| Job {
            status: Some(JobStatus {
                conditions: condition.map(|(type_, status)| {
                    vec![JobCondition {
                        type_: type_.to_string(),
                        status: status.to_string(),
                        ..Default::default()
                    }]
                }),
                ..Default::default()
            }),
            ..Default::default()
        };

        let composition = job_composition(&[
            job(Some(("Complete", "True"))),
            job(Some(("Failed", "True"))),
            // A condition that has flipped back to False says nothing happened.
            job(Some(("Failed", "False"))),
            job(None),
        ]);

        assert_eq!(composition.completed, 1);
        assert_eq!(composition.failed, 1);
        assert_eq!(composition.active, 2);
    }
}

/// One overview for several namespaces, against an API server that counts
/// what it was asked. These were the frontend's merge rules while the window
/// asked once per namespace and added the answers up; the rules stayed when
/// the adding moved here, and so did the cases.
#[cfg(test)]
mod across_namespaces {
    use super::*;
    use crate::client::served::test_server::{server, Hits};
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::Time;
    use serde_json::{json, Value};

    const PROD: &str = "prod";
    const STAGING: &str = "staging";

    fn list(items: Vec<Value>) -> String {
        json!({ "apiVersion": "v1", "kind": "List", "metadata": {}, "items": items }).to_string()
    }

    fn refused(what: &str) -> String {
        json!({
            "kind": "Status",
            "apiVersion": "v1",
            "status": "Failure",
            "message": format!("{what} is forbidden"),
            "reason": "Forbidden",
            "code": 403,
        })
        .to_string()
    }

    fn named(count: usize) -> Vec<Value> {
        (0..count)
            .map(|i| json!({ "metadata": { "name": format!("object-{i}") } }))
            .collect()
    }

    fn pod(name: &str, namespace: &str, phase: &str) -> Value {
        json!({
            "apiVersion": "v1",
            "kind": "Pod",
            "metadata": {
                "name": name,
                "namespace": namespace,
                "creationTimestamp": "2026-08-05T00:00:00Z",
            },
            "spec": { "nodeName": "n1", "containers": [] },
            "status": { "phase": phase },
        })
    }

    fn crash_looping(name: &str, namespace: &str) -> Value {
        let mut pod = pod(name, namespace, "Running");
        pod["status"]["containerStatuses"] = json!([{
            "name": "app",
            "image": "app",
            "imageID": "",
            "ready": false,
            "restartCount": 0,
            "state": { "waiting": { "reason": "CrashLoopBackOff" } },
        }]);
        pod
    }

    fn node(name: &str, ready: bool) -> Value {
        let status = if ready { "True" } else { "False" };
        json!({
            "apiVersion": "v1",
            "kind": "Node",
            "metadata": { "name": name },
            "status": {
                "conditions": [{ "type": "Ready", "status": status }],
                "allocatable": { "cpu": "4", "memory": "8Gi", "pods": "110" },
            },
        })
    }

    fn job(name: &str, namespace: &str, outcome: Option<&str>) -> Value {
        let conditions: Vec<Value> = outcome
            .map(|type_| json!({ "type": type_, "status": "True" }))
            .into_iter()
            .collect();
        json!({
            "apiVersion": "batch/v1",
            "kind": "Job",
            "metadata": { "name": name, "namespace": namespace },
            "status": { "conditions": conditions },
        })
    }

    fn unavailable(name: &str, namespace: &str) -> Value {
        json!({
            "apiVersion": "apps/v1",
            "kind": "Deployment",
            "metadata": { "name": name, "namespace": namespace },
            "spec": { "replicas": 2, "selector": {}, "template": {} },
            "status": { "readyReplicas": 0 },
        })
    }

    fn warning(namespace: &str, reason: &str, count: i32) -> Value {
        json!({
            "apiVersion": "v1",
            "kind": "Event",
            "metadata": { "name": format!("{reason}-{namespace}"), "namespace": namespace },
            "type": "Warning",
            "reason": reason,
            "count": count,
            "lastTimestamp": (Utc::now() - chrono::Duration::minutes(5))
                .format("%Y-%m-%dT%H:%M:%SZ")
                .to_string(),
            "involvedObject": { "kind": "Pod", "name": "api", "namespace": namespace },
        })
    }

    /// Every path an overview of prod and staging reads, each answering an
    /// empty list until a test says otherwise.
    struct Cluster(Vec<(&'static str, u16, String)>);

    impl Cluster {
        fn new() -> Self {
            let paths = [
                "/api/v1/nodes",
                "/api/v1/pods",
                "/api/v1/namespaces",
                "/api/v1/namespaces/prod/pods",
                "/api/v1/namespaces/staging/pods",
                "/apis/apps/v1/namespaces/prod/deployments",
                "/apis/apps/v1/namespaces/staging/deployments",
                "/apis/batch/v1/namespaces/prod/jobs",
                "/apis/batch/v1/namespaces/staging/jobs",
                "/api/v1/namespaces/prod/events",
                "/api/v1/namespaces/staging/events",
                "/apis/apps/v1/namespaces/prod/statefulsets",
                "/apis/apps/v1/namespaces/staging/statefulsets",
                "/apis/apps/v1/namespaces/prod/daemonsets",
                "/apis/apps/v1/namespaces/staging/daemonsets",
                "/apis/batch/v1/namespaces/prod/cronjobs",
                "/apis/batch/v1/namespaces/staging/cronjobs",
                "/api/v1/namespaces/prod/services",
                "/api/v1/namespaces/staging/services",
                "/apis/networking.k8s.io/v1/namespaces/prod/ingresses",
                "/apis/networking.k8s.io/v1/namespaces/staging/ingresses",
                "/api/v1/namespaces/prod/configmaps",
                "/api/v1/namespaces/staging/configmaps",
                "/api/v1/namespaces/prod/secrets",
                "/api/v1/namespaces/staging/secrets",
            ];
            Self(
                paths
                    .into_iter()
                    .map(|path| (path, 200, list(Vec::new())))
                    .collect(),
            )
        }

        fn answer(mut self, path: &str, status: u16, body: String) -> Self {
            let route = self
                .0
                .iter_mut()
                .find(|(known, _, _)| *known == path)
                .expect("a path the overview reads");
            route.1 = status;
            route.2 = body;
            self
        }

        fn items(self, path: &str, items: Vec<Value>) -> Self {
            self.answer(path, 200, list(items))
        }

        fn refuse(self, path: &str) -> Self {
            self.answer(path, 403, refused(path))
        }

        /// The overview of prod and staging, listed, and what was asked for.
        async fn overview(self) -> (Result<ClusterOverview>, Hits) {
            let (client, hits) = server(self.0).await;
            let scope =
                scope_of(Some(vec![STAGING.to_string(), PROD.to_string()])).expect("a valid scope");
            let counts = side_counts(&client, scope.as_deref()).await;
            let sides = Sides {
                counts,
                usage_by_node: None,
            };
            (by_listing(&client, scope.as_deref(), sides).await, hits)
        }

        async fn listed(self) -> ClusterOverview {
            self.overview().await.0.expect("an overview")
        }
    }

    fn asked(hits: &Hits, path: &str) -> usize {
        hits.lock().unwrap().get(path).copied().unwrap_or(0)
    }

    /// The reason this moved to Rust. Asked once per namespace, every part
    /// re-read the nodes, the namespace count and — listing — a full
    /// cluster-wide pod LIST: four namespaces were five of those a round.
    /// A cluster read issued per namespace fails here.
    #[tokio::test]
    async fn a_scope_reads_cluster_facts_once_and_each_namespace_once() {
        let (answer, hits) = Cluster::new().overview().await;
        answer.expect("an overview");

        for path in ["/api/v1/nodes", "/api/v1/pods", "/api/v1/namespaces"] {
            assert_eq!(asked(&hits, path), 1, "{path} is the cluster's, read once");
        }
        for namespace in [PROD, STAGING] {
            for kind in ["pods", "secrets"] {
                let path = format!("/api/v1/namespaces/{namespace}/{kind}");
                assert_eq!(asked(&hits, &path), 1, "{path}");
            }
            let deployments = format!("/apis/apps/v1/namespaces/{namespace}/deployments");
            assert_eq!(asked(&hits, &deployments), 1, "{deployments}");
        }
    }

    /// Would draw one `NotReady` node once per namespace in scope, under as
    /// many identical React keys, with a headline counting it that often:
    /// the node half of the problems comes off the cluster, whatever
    /// namespace was asked for.
    #[tokio::test]
    async fn a_node_problem_is_one_row_however_many_namespaces_are_in_scope() {
        let overview = Cluster::new()
            .items("/api/v1/nodes", vec![node("n1", false)])
            .items(
                "/api/v1/namespaces/prod/pods",
                vec![pod("api", PROD, "Failed")],
            )
            .items(
                "/api/v1/namespaces/staging/pods",
                vec![pod("web", STAGING, "Failed")],
            )
            .listed()
            .await;

        let nodes = overview.problems.iter().filter(|p| p.kind == "Node");
        assert_eq!(nodes.count(), 1);
        assert_eq!(overview.problems.len(), 3);
        assert_eq!(overview.problems_truncated, 0);
    }

    /// Would report a three-node cluster as six the moment two namespaces
    /// were watched: the nodes and the namespace count are cluster facts,
    /// taken once, never added up.
    #[tokio::test]
    async fn cluster_facts_are_taken_once_instead_of_summed() {
        let overview = Cluster::new()
            .items(
                "/api/v1/nodes",
                vec![node("a", true), node("b", true), node("c", true)],
            )
            .items("/api/v1/namespaces", named(12))
            .listed()
            .await;

        assert_eq!(overview.nodes.len(), 3);
        assert_eq!(overview.counts.nodes, Some(3));
        assert_eq!(overview.counts.namespaces, Some(12));
    }

    /// The counts that belong to a namespace add up across the scope.
    #[tokio::test]
    async fn per_namespace_counts_add_up() {
        let pods = |namespace: &str, n: usize| {
            (0..n)
                .map(|i| pod(&format!("p{i}"), namespace, "Running"))
                .collect()
        };
        let overview = Cluster::new()
            .items("/api/v1/namespaces/prod/pods", pods(PROD, 4))
            .items("/api/v1/namespaces/staging/pods", pods(STAGING, 7))
            .items("/api/v1/namespaces/prod/services", named(1))
            .items("/api/v1/namespaces/staging/services", named(2))
            .listed()
            .await;

        assert_eq!(overview.counts.pods, Some(11));
        assert_eq!(overview.counts.services, Some(3));
    }

    /// Would break the app's one rule about numbers. Two namespaces
    /// answering and one refusing is not a total, and a sum of the two that
    /// answered would be printed as the scope's.
    #[tokio::test]
    async fn a_count_one_namespace_refused_is_unknown_not_a_partial_sum() {
        let overview = Cluster::new()
            .items("/api/v1/namespaces/prod/secrets", named(2))
            .refuse("/api/v1/namespaces/staging/secrets")
            .items("/api/v1/namespaces/prod/services", named(1))
            .listed()
            .await;

        assert_eq!(overview.counts.secrets, None);
        assert_eq!(overview.counts.services, Some(1));
    }

    /// Every namespace or none, as when each was asked on its own and one
    /// refusal left the page without an answer. Keeping the namespaces that
    /// answered would label their pods with the scope's name.
    #[tokio::test]
    async fn a_namespace_that_refuses_its_pods_fails_the_whole_overview() {
        let (answer, _) = Cluster::new()
            .items(
                "/api/v1/namespaces/prod/pods",
                vec![pod("api", PROD, "Running")],
            )
            .refuse("/api/v1/namespaces/staging/pods")
            .overview()
            .await;

        let error = answer.expect_err("a refusal, not two thirds of a scope");
        assert!(error.is_refusal(), "{error}");
    }

    /// The rule the counts follow, for the one kind whose bar needs status.
    /// A token that can list Jobs in one namespace and not another must not
    /// get a composition that silently omits the rest.
    #[tokio::test]
    async fn a_jobs_total_is_unknown_when_one_namespace_refused_its_jobs() {
        let overview = Cluster::new()
            .items(
                "/apis/batch/v1/namespaces/prod/jobs",
                vec![job("backup", PROD, Some("Complete"))],
            )
            .refuse("/apis/batch/v1/namespaces/staging/jobs")
            .listed()
            .await;

        assert!(overview.jobs.is_none());
        assert_eq!(overview.counts.jobs, None);
    }

    /// A Deployment list is problems as well as a count. The rows prod could
    /// show stay on screen when staging refuses; only the count, which would
    /// be a partial sum, goes unknown.
    #[tokio::test]
    async fn problems_of_the_namespaces_that_answered_stand_when_another_refused() {
        let overview = Cluster::new()
            .items(
                "/apis/apps/v1/namespaces/prod/deployments",
                vec![unavailable("api", PROD)],
            )
            .refuse("/apis/apps/v1/namespaces/staging/deployments")
            .listed()
            .await;

        assert!(overview
            .problems
            .iter()
            .any(|p| p.kind == "Deployment" && p.name == "api"));
        assert_eq!(overview.counts.deployments, None);
    }

    /// Would drop a namespace's rows from the join: both namespaces' problems
    /// are on the panel.
    #[tokio::test]
    async fn problems_every_namespace_reported_are_joined() {
        let overview = Cluster::new()
            .items(
                "/api/v1/namespaces/prod/pods",
                vec![pod("api-1", PROD, "Failed")],
            )
            .items(
                "/api/v1/namespaces/staging/pods",
                vec![pod("web-2", STAGING, "Failed")],
            )
            .listed()
            .await;

        let names: Vec<_> = overview.problems.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["api-1", "web-2"]);
    }

    /// Pod phases and Job outcomes add up across the scope.
    #[tokio::test]
    async fn pod_composition_and_jobs_add_up_across_namespaces() {
        let overview = Cluster::new()
            .items(
                "/api/v1/namespaces/prod/pods",
                vec![
                    pod("a", PROD, "Running"),
                    pod("b", PROD, "Running"),
                    crash_looping("c", PROD),
                    pod("d", PROD, "Pending"),
                ],
            )
            .items(
                "/api/v1/namespaces/staging/pods",
                vec![
                    pod("e", STAGING, "Running"),
                    pod("f", STAGING, "Running"),
                    pod("g", STAGING, "Succeeded"),
                    pod("h", STAGING, "Failed"),
                ],
            )
            .items(
                "/apis/batch/v1/namespaces/staging/jobs",
                vec![
                    job("x", STAGING, Some("Complete")),
                    job("y", STAGING, Some("Complete")),
                    job("z", STAGING, None),
                ],
            )
            .listed()
            .await;

        assert_eq!(overview.pods.running, 5);
        assert_eq!(overview.pods.crash_looping, 1);
        assert_eq!(overview.pods.pending, 1);
        assert_eq!(overview.pods.succeeded, 1);
        assert_eq!(overview.pods.failed, 1);
        let jobs = overview.jobs.expect("both namespaces answered");
        assert_eq!((jobs.completed, jobs.active, jobs.failed), (2, 1, 0));
    }

    /// The node list and the cluster-wide pods behind the capacity view are
    /// one read each. Either refused leaves the whole scope's capacity view
    /// unknown — no node rows, and no node count beside the "no node access"
    /// note the page shows.
    #[tokio::test]
    async fn the_capacity_view_is_unknown_when_a_cluster_read_was_refused() {
        for refused in ["/api/v1/nodes", "/api/v1/pods"] {
            let overview = Cluster::new()
                .items("/api/v1/nodes", vec![node("n1", true)])
                .refuse(refused)
                .listed()
                .await;

            assert!(!overview.nodes_known, "{refused}");
            assert!(overview.nodes.is_empty(), "{refused}");
            assert_eq!(overview.counts.nodes, None, "{refused}");
        }
    }

    /// The namespace breakdown is the picker's view of the whole cluster. A
    /// scope's answer restating its own namespaces under a heading that
    /// counts the cluster's would be built out of the selection.
    #[tokio::test]
    async fn a_scope_has_no_namespace_breakdown() {
        let overview = Cluster::new()
            .items(
                "/api/v1/namespaces/prod/pods",
                vec![pod("a", PROD, "Running")],
            )
            .items(
                "/api/v1/namespaces/staging/pods",
                vec![pod("b", STAGING, "Running")],
            )
            .listed()
            .await;

        assert!(overview.namespaces.is_empty());
    }

    /// Would break the warnings panel, which keys its rows by reason: two
    /// namespaces reporting `FailedScheduling` were two rows under one key,
    /// one never drawn, the other carrying one namespace's count.
    #[tokio::test]
    async fn a_warning_reason_is_one_row_carrying_the_whole_scopes_count() {
        let overview = Cluster::new()
            .items(
                "/api/v1/namespaces/prod/events",
                vec![warning(PROD, "FailedScheduling", 4)],
            )
            .items(
                "/api/v1/namespaces/staging/events",
                vec![warning(STAGING, "FailedScheduling", 9)],
            )
            .listed()
            .await;

        assert_eq!(overview.warnings.len(), 1);
        assert_eq!(overview.warnings[0].count, 13);
    }

    fn event(namespace: &str, reason: &str, count: i32, minutes_ago: Option<i64>) -> Event {
        let mut event: Event = serde_json::from_value(warning(namespace, reason, count))
            .expect("an event this test wrote");
        event.last_timestamp = minutes_ago.map(|minutes| {
            Time(
                crate::utils::moment::as_cluster_time(
                    Utc::now() - chrono::Duration::minutes(minutes),
                )
                .expect("an instant this test wrote"),
            )
        });
        event
    }

    /// The sample describes one event and has to keep describing one: the
    /// message from the loudest namespace under the time of the newest would
    /// put a sentence on screen at a moment it never happened.
    #[test]
    fn the_sample_is_the_newest_event_whole_whichever_namespace_saw_it() {
        let mut loud = event(STAGING, "FailedScheduling", 20, Some(50));
        loud.message = Some("0/3 nodes are available".to_string());
        loud.involved_object.name = Some("batch-7".to_string());
        let mut recent = event(PROD, "FailedScheduling", 1, Some(10));
        recent.message = Some("Insufficient memory".to_string());
        recent.involved_object.name = Some("api-1".to_string());

        let groups = recent_warnings([&loud, &recent]);

        assert_eq!(groups.len(), 1);
        let group = &groups[0];
        assert_eq!(group.count, 21);
        assert_eq!(group.sample.as_deref(), Some("Insufficient memory"));
        assert_eq!(group.object_name.as_deref(), Some("api-1"));
        assert_eq!(group.namespace.as_deref(), Some(PROD));
    }

    /// An undated event cannot be shown to be the newer one.
    #[test]
    fn an_undated_event_never_takes_the_sample_from_a_dated_one() {
        let mut dated = event(PROD, "BackOff", 1, Some(30));
        dated.message = Some("dated".to_string());
        let mut undated = event(STAGING, "BackOff", 1, None);
        undated.message = Some("undated".to_string());

        for order in [[&dated, &undated], [&undated, &dated]] {
            let groups = recent_warnings(order);
            assert_eq!(groups[0].sample.as_deref(), Some("dated"));
        }
    }

    /// The panel is read top-down, and adding the namespaces up changes the
    /// order: loudest across the whole scope first.
    #[test]
    fn warning_groups_are_ordered_by_the_scopes_count() {
        let events = [
            event(PROD, "BackOff", 9, Some(5)),
            event(PROD, "FailedScheduling", 2, Some(5)),
            event(STAGING, "FailedScheduling", 8, Some(5)),
        ];
        let reasons: Vec<_> = recent_warnings(&events)
            .into_iter()
            .map(|group| group.reason)
            .collect();
        assert_eq!(reasons, ["FailedScheduling", "BackOff"]);
    }

    fn problem_in(
        namespace: &str,
        name: &str,
        severity: ProblemSeverity,
        since: Option<&str>,
    ) -> ClusterProblem {
        ClusterProblem {
            severity,
            kind: "Pod".to_string(),
            name: name.to_string(),
            namespace: Some(namespace.to_string()),
            reason: "CrashLoopBackOff".to_string(),
            detail: None,
            since: since.map(str::to_string),
            restarts: None,
        }
    }

    /// Would break the promise the panel's caption makes. In namespace
    /// order, a mild problem in the first namespace sat above the
    /// `CrashLoopBackOff` in the second.
    #[test]
    fn the_worst_row_leads_whichever_namespace_it_came_from() {
        let (kept, _) = rank_and_cap(vec![
            problem_in(
                PROD,
                "web-1",
                ProblemSeverity::Warning,
                Some("2026-08-05T08:00:00Z"),
            ),
            problem_in(
                STAGING,
                "api-1",
                ProblemSeverity::Critical,
                Some("2026-08-05T10:00:00Z"),
            ),
        ]);
        let names: Vec<_> = kept.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["api-1", "web-1"]);
    }

    /// Oldest first inside a severity: the top row is what has been broken
    /// longest, and an unknown age is not evidence that a problem is young.
    #[test]
    fn equal_severities_are_ordered_by_age_undated_first() {
        let critical = ProblemSeverity::Critical;
        let (kept, _) = rank_and_cap(vec![
            problem_in(PROD, "recent", critical, Some("2026-08-05T10:00:00Z")),
            problem_in(PROD, "undated", critical, None),
            problem_in(STAGING, "old", critical, Some("2026-08-05T01:00:00Z")),
        ]);
        let names: Vec<_> = kept.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["undated", "old", "recent"]);
    }

    /// Would grow the panel by fifty rows per namespace watched, on exactly
    /// the clusters the cap was written for. The rows dropped are still
    /// counted, or the headline above the panel understates an outage.
    #[test]
    fn the_scope_is_cut_to_one_panel_and_counts_what_it_dropped() {
        let many = |namespace: &str, n: usize, severity: ProblemSeverity| {
            (0..n)
                .map(|i| {
                    problem_in(
                        namespace,
                        &format!("{namespace}-{i}"),
                        severity,
                        Some(&format!("2026-08-05T00:{:02}:00Z", i % 60)),
                    )
                })
                .collect::<Vec<_>>()
        };
        // The mild namespace first, as it sorts: a cut taken before the
        // ranking would keep its fifty warnings and drop every critical.
        let mut problems = many(PROD, MAX_PROBLEMS, ProblemSeverity::Warning);
        problems.extend(many(STAGING, MAX_PROBLEMS + 3, ProblemSeverity::Critical));

        let (kept, truncated) = rank_and_cap(problems);

        assert_eq!(kept.len(), MAX_PROBLEMS);
        assert!(kept.iter().all(|p| p.severity == ProblemSeverity::Critical));
        assert_eq!(truncated, MAX_PROBLEMS + 3);
        assert_eq!(kept.len() + truncated, 2 * MAX_PROBLEMS + 3);
    }

    /// Usage is the cluster's node metrics, read once for the scope, so a
    /// scope cannot be half measured: the answer carries that one reading or
    /// says there is none, never usage for some namespaces.
    #[test]
    fn metrics_are_one_reading_for_the_whole_scope() {
        let snapshot = Snapshot {
            pods: Vec::new(),
            nodes: arcs([serde_json::from_value::<Node>(node("n1", true)).expect("a node")]),
            deployments: Vec::new(),
            jobs: Vec::new(),
            events: Vec::new(),
        };
        let scope = vec![PROD.to_string(), STAGING.to_string()];
        let with = |usage_by_node| {
            from_snapshot(
                &snapshot,
                Some(&scope),
                Sides {
                    counts: ResourceCounts::default(),
                    usage_by_node,
                },
            )
        };

        let measured = with(Some(BTreeMap::from([("n1".to_string(), (250.0, 1024))])));
        assert!(measured.metrics_available);
        assert_eq!(measured.nodes[0].cpu.usage, Some(250.0));
        let unmeasured = with(None);
        assert!(!unmeasured.metrics_available);
        assert_eq!(unmeasured.nodes[0].cpu.usage, None);
    }
}
