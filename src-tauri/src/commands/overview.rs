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
use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::core::v1::{Event, Node, Pod};
use kube::api::ListParams;
use kube::Api;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use tauri::State;

/// How far back an event still counts as "recent" for the warnings feed.
const RECENT_WARNING_WINDOW_MINUTES: i64 = 60;

/// Server-side cap on the event list. Events are the largest collection in
/// most clusters and this query re-runs every couple of seconds, so pulling
/// the full list to keep one hour of it is the wrong trade.
const EVENT_FETCH_LIMIT: u32 = 500;

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
    /// Object the most recent event referred to.
    pub object: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamespaceLoad {
    pub name: String,
    pub pod_count: usize,
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
    /// Pods in the requested scope — the selected namespace, or the whole
    /// cluster when none is selected. No phase is excluded.
    pub pod_count: usize,
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

    // A container stuck in a back-off / image-pull loop is the single
    // most common real incident, and the reason string is precise.
    let stuck = status.container_statuses.as_ref().and_then(|cs| {
        cs.iter().find_map(|c| {
            let waiting = c.state.as_ref()?.waiting.as_ref()?;
            let reason = waiting.reason.as_deref()?;
            STUCK_WAITING_REASONS
                .contains(&reason)
                .then(|| (reason.to_string(), waiting.message.clone()))
        })
    });

    if let Some((reason, message)) = stuck {
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
            object: None,
        });
        entry.count += event.count.unwrap_or(1);
        let last_rfc = last.map(|t| t.to_rfc3339());
        // Keep the newest occurrence as the representative sample.
        if entry.last_seen.is_none() || last_rfc > entry.last_seen {
            entry.last_seen = last_rfc;
            entry.sample = event.message.clone();
            entry.object = event.involved_object.name.as_ref().map(|n| {
                match event.involved_object.kind.as_deref() {
                    Some(kind) => format!("{kind}/{n}"),
                    None => n.clone(),
                }
            });
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
fn usage_index(response: Option<NodeMetricsResponse>) -> Option<BTreeMap<String, (f64, u64)>> {
    let response = response?;
    if !matches!(response.status.status, MetricsStatusKind::Available) {
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

/// Get everything the overview screen needs in one round trip.
#[tauri::command]
pub async fn get_cluster_overview(
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<ClusterOverview> {
    let ctx = ResourceContext::for_list(&state, namespace)?;
    let params = ListParams::default();
    // Filtering warnings server-side turns the largest collection in the
    // cluster into a small one, and the limit bounds the pathological case
    // where even the warnings are numerous.
    let event_params = ListParams::default()
        .fields("type=Warning")
        .limit(EVENT_FETCH_LIMIT);
    let pods_api: Api<Pod> = ctx.namespaced_or_cluster_api();
    let nodes_api: Api<Node> = ctx.cluster_api();
    let deployments_api: Api<Deployment> = ctx.namespaced_or_cluster_api();
    let events_api: Api<Event> = ctx.namespaced_or_cluster_api();

    let (pods_result, nodes_result, deployments_result, events_result) = tokio::join!(
        pods_api.list(&params),
        nodes_api.list(&params),
        deployments_api.list(&params),
        events_api.list(&event_params),
    );

    let pods = pods_result.map_err(Error::from)?.items;
    let nodes = nodes_result.map_err(Error::from)?.items;
    let deployments = deployments_result.map_err(Error::from)?.items;
    // Events are the one input we can lose without making the screen wrong,
    // so a failure here degrades to "no warnings" instead of an error page.
    let events = events_result.map(|l| l.items).unwrap_or_default();

    // Live usage is best-effort: metrics-server is not installed everywhere.
    let usage_by_node = usage_index(crate::metrics::get_node_metrics(&state).await.ok());
    let metrics_available = usage_by_node.is_some();

    // Requests are attributed per node so a single node can be shown as
    // full while the cluster average still looks comfortable.
    let mut requests_by_node: BTreeMap<String, (f64, u64)> = BTreeMap::new();
    let mut pods_by_node: BTreeMap<String, usize> = BTreeMap::new();
    let mut namespace_counts: BTreeMap<String, usize> = BTreeMap::new();

    for pod in &pods {
        if let Some(ns) = pod.metadata.namespace.as_ref() {
            *namespace_counts.entry(ns.clone()).or_insert(0) += 1;
        }
        if is_terminal(pod) {
            continue;
        }
        let Some(node_name) = pod.spec.as_ref().and_then(|s| s.node_name.clone()) else {
            continue;
        };
        let (cpu, memory) = pod_requests(pod);
        let entry = requests_by_node
            .entry(node_name.clone())
            .or_insert((0.0, 0));
        entry.0 += cpu;
        entry.1 += memory;
        *pods_by_node.entry(node_name).or_insert(0) += 1;
    }

    let aggregate = summarize_nodes(
        &nodes,
        &requests_by_node,
        &pods_by_node,
        usage_by_node.as_ref(),
    );

    let mut problems = pod_problems(&pods, Utc::now());
    problems.extend(deployment_problems(&deployments));
    problems.extend(node_problems(&nodes));
    let (problems, problems_truncated) = rank_and_cap(problems);

    let mut namespaces: Vec<_> = namespace_counts
        .into_iter()
        .map(|(name, pod_count)| NamespaceLoad { name, pod_count })
        .collect();
    namespaces.sort_by(|a, b| b.pod_count.cmp(&a.pod_count));

    Ok(ClusterOverview {
        problems,
        problems_truncated,
        scheduler: aggregate.scheduler,
        nodes: aggregate.summaries,
        warnings: recent_warnings(&events),
        namespaces,
        pod_count: pods.len(),
        metrics_available,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metrics::{MetricsStatus, NodeMetrics};
    use k8s_openapi::api::core::v1::{PodCondition, PodStatus};
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
}
