//! Cluster overview — the "do I need to do something right now?" query.
//!
//! Deliberately not a stats endpoint. `get_cluster_stats` answers "how
//! many objects exist", which nobody acts on; this one answers "what is
//! broken, how tight is the scheduler, and what is this cluster" in a
//! single round trip.
//!
//! The aggregation lives here rather than in the frontend because the
//! inputs are the full pod / node / deployment / event lists: shipping
//! all of that over IPC to reduce it to a dozen rows in JS wastes both
//! the transfer and the main thread, and the reduction has to re-run on
//! every watch event.

use crate::commands::helpers::ResourceContext;
use crate::error::{Error, Result};
use crate::metrics::{MetricsStatusKind, NodeMetricsResponse};
use crate::state::AppState;
use crate::utils::quantities::{parse_cpu, parse_memory};
use chrono::{DateTime, Utc};
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, StatefulSet};
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{ConfigMap, Event, Namespace, Node, Pod, Secret, Service};
use k8s_openapi::api::networking::v1::Ingress;
use kube::api::ListParams;
use kube::Api;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt::Debug;
use tauri::State;

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
/// and image pulls take seconds; without this grace every CronJob tick
/// paints the panel red and the signal is gone.
const PENDING_GRACE_SECONDS: i64 = 60;

/// Cap on the problems list. A node outage produces one row per pod on it,
/// and neither the IPC payload nor the two-second re-render survives that.
const MAX_PROBLEMS: usize = 50;

/// Restart count above which a pod is called out even while it is Running.
/// A pod that restarted a few times hours ago is noise; one climbing past
/// this is worth a look before it starts flapping.
const RESTART_ATTENTION_THRESHOLD: i32 = 5;

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

/// One actionable row in the problems list. `kind` + `namespace` + `name`
/// is enough for the frontend to build a deep link to the detail page.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterProblem {
    pub severity: ProblemSeverity,
    pub kind: String,
    pub name: String,
    pub namespace: Option<String>,
    /// Short machine-ish label: `CrashLoopBackOff`, `Pending`, `NotReady`.
    pub reason: String,
    /// Human sentence explaining the reason, taken from the object's own
    /// status message where one exists.
    pub detail: Option<String>,
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
}

/// Pods in these phases hold no scheduler reservation, so they are excluded
/// from resource accounting. They are still examined for problems.
fn is_terminal(pod: &Pod) -> bool {
    pod.status
        .as_ref()
        .and_then(|s| s.phase.as_deref())
        .is_some_and(|p| p == "Succeeded" || p == "Failed")
}

fn pod_requests(pod: &Pod) -> (f64, u64) {
    let Some(spec) = pod.spec.as_ref() else {
        return (0.0, 0);
    };
    let mut cpu = 0.0;
    let mut memory = 0u64;
    // Init containers run to completion before the app containers start, so
    // the scheduler reserves max(init) rather than their sum — but the app
    // containers' sum is what persists. Taking the running set alone is the
    // closer approximation and avoids double counting.
    for container in &spec.containers {
        let Some(requests) = container
            .resources
            .as_ref()
            .and_then(|r| r.requests.as_ref())
        else {
            continue;
        };
        if let Some(q) = requests.get("cpu") {
            cpu += parse_cpu(&q.0);
        }
        if let Some(q) = requests.get("memory") {
            memory += parse_memory(&q.0);
        }
    }
    (cpu, memory)
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
fn pod_problems(pods: &[Pod], now: DateTime<Utc>) -> Vec<ClusterProblem> {
    pods.iter()
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
        .map(|t| t.0.to_rfc3339());
    let status = pod.status.as_ref()?;
    let phase = status.phase.as_deref().unwrap_or("");

    let restarts: i32 = status
        .container_statuses
        .as_ref()
        .map_or(0, |cs| cs.iter().map(|c| c.restart_count).sum());

    if let Some((reason, message)) = stuck_reason(pod) {
        return Some(ClusterProblem {
            severity: ProblemSeverity::Critical,
            kind: "Pod".to_string(),
            name,
            namespace,
            reason,
            detail: message,
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
            detail: status.message.clone(),
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
            .map(|t| t.0);
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
            detail: scheduled
                .and_then(|c| c.message.clone())
                .or_else(|| status.message.clone()),
            since: pending_since.map(|t| t.to_rfc3339()),
            restarts: None,
        });
    }

    if restarts >= RESTART_ATTENTION_THRESHOLD && phase == "Running" {
        return Some(ClusterProblem {
            severity: ProblemSeverity::Warning,
            kind: "Pod".to_string(),
            name,
            namespace,
            reason: "Restarting".to_string(),
            detail: Some(format!("{restarts} restarts since creation")),
            since: created,
            restarts: Some(restarts),
        });
    }

    None
}

fn deployment_problems(deployments: &[Deployment]) -> Vec<ClusterProblem> {
    deployments
        .iter()
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
                detail: condition
                    .as_ref()
                    .and_then(|c| c.message.clone())
                    .or_else(|| Some(format!("{ready}/{desired} replicas ready"))),
                since: condition
                    .as_ref()
                    .and_then(|c| c.last_transition_time.as_ref())
                    .map(|t| t.0.to_rfc3339()),
                restarts: None,
            })
        })
        .collect()
}

fn node_problems(nodes: &[Node]) -> Vec<ClusterProblem> {
    nodes
        .iter()
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
                    detail: condition.as_ref().and_then(|c| c.message.clone()),
                    since: condition
                        .as_ref()
                        .and_then(|c| c.last_transition_time.as_ref())
                        .map(|t| t.0.to_rfc3339()),
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
                    detail: Some("Marked unschedulable — no new pods will land here".to_string()),
                    since: None,
                    restarts: None,
                });
            }
            None
        })
        .collect()
}

fn recent_warnings(events: &[Event]) -> Vec<WarningGroup> {
    let cutoff = chrono::Utc::now() - chrono::Duration::minutes(RECENT_WARNING_WINDOW_MINUTES);
    let mut grouped: BTreeMap<String, WarningGroup> = BTreeMap::new();

    for event in events {
        if event.type_.as_deref() != Some("Warning") {
            continue;
        }
        let last = event
            .last_timestamp
            .as_ref()
            .map(|t| t.0)
            .or_else(|| event.event_time.as_ref().map(|t| t.0));
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
            entry.sample = event.message.clone();
            entry.object_kind = event.involved_object.kind.clone();
            entry.object_name = event.involved_object.name.clone();
            // Deliberately not `event.metadata.namespace`, which is `default`
            // for an event about a Node — inheriting it would file a
            // cluster-scoped object inside a namespace it does not live in.
            entry.namespace = event.involved_object.namespace.clone();
        }
    }

    let mut groups: Vec<_> = grouped.into_values().collect();
    groups.sort_by(|a, b| b.count.cmp(&a.count));
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

fn summarize_nodes(
    nodes: &[Node],
    requests_by_node: &BTreeMap<String, (f64, u64)>,
    pods_by_node: &BTreeMap<String, usize>,
    usage_by_node: Option<&BTreeMap<String, (f64, u64)>>,
) -> NodeAggregate {
    let metrics_available = usage_by_node.is_some();
    let mut summaries = Vec::with_capacity(nodes.len());
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
            .map(|q| parse_cpu(&q.0))
            .unwrap_or(0.0);
        let memory_allocatable = allocatable
            .and_then(|a| a.get("memory"))
            .map(|q| parse_memory(&q.0) as f64)
            .unwrap_or(0.0);
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
fn account_by_node(pods: &[Pod]) -> NodeAccounting {
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

fn pod_composition(pods: &[Pod]) -> PodComposition {
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
fn job_composition(jobs: &[Job]) -> JobComposition {
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

fn namespace_loads(pods: &[Pod]) -> Vec<NamespaceLoad> {
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    for namespace in pods.iter().filter_map(|p| p.metadata.namespace.as_deref()) {
        *counts.entry(namespace).or_insert(0) += 1;
    }
    let mut loads: Vec<_> = counts
        .into_iter()
        .map(|(name, pod_count)| NamespaceLoad {
            name: name.to_string(),
            pod_count,
        })
        .collect();
    loads.sort_by(|a, b| b.pod_count.cmp(&a.pod_count));
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

struct OverviewInputs<'a> {
    /// Pods in the requested scope: problems, namespace breakdown, counts.
    scoped_pods: &'a [Pod],
    /// Cluster-wide pods, driving everything that is divided by node
    /// allocatable. Same slice as `scoped_pods` when nothing is selected.
    accounting_pods: &'a [Pod],
    nodes: &'a [Node],
    /// `None` when the Deployment list was refused: the problems it feeds are
    /// one section of the screen, not the screen.
    deployments: Option<&'a [Deployment]>,
    jobs: Option<&'a [Job]>,
    events: &'a [Event],
    usage_by_node: Option<BTreeMap<String, (f64, u64)>>,
    /// Counts for the kinds this query does not otherwise need to read.
    counts: ResourceCounts,
    namespace: Option<&'a str>,
    now: DateTime<Utc>,
}

fn build_overview(input: &OverviewInputs<'_>) -> ClusterOverview {
    let metrics_available = input.usage_by_node.is_some();
    let accounting = account_by_node(input.accounting_pods);
    let aggregate = summarize_nodes(
        input.nodes,
        &accounting.requests,
        &accounting.pods,
        input.usage_by_node.as_ref(),
    );

    let mut problems = pod_problems(input.scoped_pods, input.now);
    problems.extend(deployment_problems(input.deployments.unwrap_or_default()));
    problems.extend(node_problems(input.nodes));
    let (problems, problems_truncated) = rank_and_cap(problems);

    // The lists this query already had to read answer their own counts, so
    // those four kinds cost no extra request.
    let counts = ResourceCounts {
        pods: Some(input.scoped_pods.len()),
        deployments: input.deployments.map(<[Deployment]>::len),
        jobs: input.jobs.map(<[Job]>::len),
        nodes: Some(input.nodes.len()),
        ..input.counts.clone()
    };

    ClusterOverview {
        problems,
        problems_truncated,
        scheduler: aggregate.scheduler,
        nodes: aggregate.summaries,
        warnings: recent_warnings(input.events),
        counts,
        pods: pod_composition(input.scoped_pods),
        jobs: input.jobs.map(job_composition),
        // Scoped, the breakdown is one row restating the selection, under a
        // heading that counts namespaces in the cluster. Drop it instead.
        namespaces: match input.namespace {
            Some(_) => Vec::new(),
            None => namespace_loads(input.scoped_pods),
        },
        metrics_available,
    }
}

/// Get everything the overview screen needs in one round trip.
#[tauri::command]
pub async fn get_cluster_overview(
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<ClusterOverview> {
    let ctx = ResourceContext::for_list(&state, namespace)?;
    let params = ListParams::default();
    let pods_api: Api<Pod> = ctx.namespaced_or_cluster_api();
    let nodes_api: Api<Node> = ctx.cluster_api();
    let deployments_api: Api<Deployment> = ctx.namespaced_or_cluster_api();
    let events_api: Api<Event> = ctx.namespaced_or_cluster_api();
    // Scheduler headroom and the node rows describe the cluster, not the
    // selection: dividing one namespace's requests by every node's allocatable
    // would state a reserved share that is nobody's number. So the accounting
    // pass always runs on a cluster-wide pod list — fetched only when a
    // namespace is selected, since otherwise the scoped list already is one.
    let cluster_pods_api: Api<Pod> = ctx.cluster_api();
    let cluster_pods_request = async {
        match ctx.namespace {
            Some(_) => Some(cluster_pods_api.list(&params).await),
            None => None,
        }
    };

    // Everything the sidebar counts joins the same wave. Serialising them
    // would multiply the round trip by the number of kinds; started together
    // they cost the slowest one.
    let stateful_sets_api: Api<StatefulSet> = ctx.namespaced_or_cluster_api();
    let daemon_sets_api: Api<DaemonSet> = ctx.namespaced_or_cluster_api();
    let jobs_api: Api<Job> = ctx.namespaced_or_cluster_api();
    let cron_jobs_api: Api<CronJob> = ctx.namespaced_or_cluster_api();
    let services_api: Api<Service> = ctx.namespaced_or_cluster_api();
    let ingresses_api: Api<Ingress> = ctx.namespaced_or_cluster_api();
    let config_maps_api: Api<ConfigMap> = ctx.namespaced_or_cluster_api();
    let secrets_api: Api<Secret> = ctx.namespaced_or_cluster_api();
    let namespaces_api: Api<Namespace> = ctx.cluster_api();

    let (
        pods_result,
        cluster_pods_result,
        nodes_result,
        deployments_result,
        jobs_result,
        events,
        metrics,
        stateful_sets,
        daemon_sets,
        cron_jobs,
        namespaces,
        services,
        ingresses,
        config_maps,
        secrets,
        event_count,
    ) = tokio::join!(
        pods_api.list(&params),
        cluster_pods_request,
        nodes_api.list(&params),
        deployments_api.list(&params),
        jobs_api.list(&params),
        list_warning_events(&events_api),
        crate::metrics::get_node_metrics(&state),
        count_of(&stateful_sets_api),
        count_of(&daemon_sets_api),
        count_of(&cron_jobs_api),
        count_of(&namespaces_api),
        count_of(&services_api),
        count_of(&ingresses_api),
        count_of(&config_maps_api),
        count_of(&secrets_api),
        count_of(&events_api),
    );

    let pods = pods_result.map_err(Error::from)?.items;
    let cluster_pods = cluster_pods_result
        .transpose()
        .map_err(Error::from)?
        .map(|list| list.items);
    let nodes = nodes_result.map_err(Error::from)?.items;
    // Pods and nodes are load-bearing — the scheduler panel and every node row
    // are built from them, so losing either means there is no screen to draw.
    // Deployments and Jobs feed one section each and degrade instead.
    let deployments = deployments_result.ok().map(|list| list.items);
    let jobs = jobs_result.ok().map(|list| list.items);

    Ok(build_overview(&OverviewInputs {
        scoped_pods: &pods,
        accounting_pods: cluster_pods.as_deref().unwrap_or(&pods),
        nodes: &nodes,
        deployments: deployments.as_deref(),
        jobs: jobs.as_deref(),
        events: &events,
        // Live usage is best-effort: metrics-server is not installed everywhere.
        usage_by_node: usage_index(metrics.ok()),
        counts: ResourceCounts {
            stateful_sets,
            daemon_sets,
            cron_jobs,
            namespaces,
            services,
            ingresses,
            config_maps,
            secrets,
            events: event_count,
            ..Default::default()
        },
        namespace: ctx.namespace.as_deref(),
        now: Utc::now(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metrics::{MetricsStatus, NodeMetrics};
    use k8s_openapi::api::batch::v1::{JobCondition, JobStatus};
    use k8s_openapi::api::core::v1::{
        Container, ContainerState, ContainerStateWaiting, ContainerStatus, NodeStatus,
        PodCondition, PodSpec, PodStatus, ResourceRequirements,
    };
    use k8s_openapi::apimachinery::pkg::api::resource::Quantity;
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::Time;
    use kube::core::ObjectMeta;

    fn at(now: DateTime<Utc>, seconds_ago: i64) -> Time {
        Time(now - chrono::Duration::seconds(seconds_ago))
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
            status: Some(NodeStatus {
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
            ..Default::default()
        }
    }

    fn overview(
        scoped_pods: &[Pod],
        accounting_pods: &[Pod],
        namespace: Option<&str>,
    ) -> ClusterOverview {
        build_overview(&OverviewInputs {
            scoped_pods,
            accounting_pods,
            nodes: &[node("n1", "4", "8Gi"), node("n2", "4", "8Gi")],
            deployments: Some(&[]),
            jobs: Some(&[]),
            events: &[],
            usage_by_node: None,
            counts: ResourceCounts::default(),
            namespace,
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
            nodes: &[node("n1", "4", "8Gi")],
            deployments: Some(&[]),
            jobs: Some(&[]),
            events: &[],
            usage_by_node: usage_index(Some(node_metrics_response(
                MetricsStatusKind::Available,
                vec![],
            ))),
            counts: ResourceCounts::default(),
            namespace: None,
            now: Utc::now(),
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
        let loads = namespace_loads(&pods);
        assert_eq!(loads[0].name, "busy");
        assert_eq!(loads[0].pod_count, 2);
        assert_eq!(loads[1].name, "quiet");
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
    /// CronJobs, which is the same as having no panel at all.
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
            problems[0].detail.as_deref(),
            Some("The node was low on resource: memory")
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

    /// A refusal on one kind must not take the rest of the screen with it.
    #[test]
    fn refused_kinds_report_none_while_the_rest_of_the_overview_stands() {
        let pods = vec![scheduled_pod("api", "app", "n1", "500m", "1Gi")];
        let result = build_overview(&OverviewInputs {
            scoped_pods: &pods,
            accounting_pods: &pods,
            nodes: &[node("n1", "4", "8Gi")],
            deployments: None,
            jobs: None,
            events: &[],
            usage_by_node: None,
            counts: ResourceCounts {
                services: Some(6),
                secrets: None,
                ..Default::default()
            },
            namespace: None,
            now: Utc::now(),
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
            scoped_pods: &scoped,
            accounting_pods: &cluster,
            nodes: &[node("n1", "4", "8Gi"), node("n2", "4", "8Gi")],
            deployments: Some(&deployments),
            jobs: Some(&jobs),
            events: &[],
            usage_by_node: None,
            counts: ResourceCounts::default(),
            namespace: Some("app"),
            now: Utc::now(),
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
