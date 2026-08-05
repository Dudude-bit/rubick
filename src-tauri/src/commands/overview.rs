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
use crate::state::AppState;
use crate::utils::quantities::{parse_cpu, parse_memory};
use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::core::v1::{Event, Node, Pod};
use kube::api::ListParams;
use kube::Api;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use tauri::State;

/// How far back an event still counts as "recent" for the warnings feed.
const RECENT_WARNING_WINDOW_MINUTES: i64 = 60;

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
    pub problems: Vec<ClusterProblem>,
    pub scheduler: SchedulerPressure,
    pub nodes: Vec<NodeSummary>,
    pub warnings: Vec<WarningGroup>,
    pub namespaces: Vec<NamespaceLoad>,
    /// Total pods considered (all namespaces, excluding none).
    pub pod_count: usize,
    /// False when the metrics API is unavailable, so the UI can say so
    /// instead of rendering an empty usage bar that reads as "idle".
    pub metrics_available: bool,
}

/// Pods in these phases hold no scheduler reservation and are not problems.
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

/// Collect every pod-level problem: stuck containers, unschedulable pods,
/// and restart storms.
fn pod_problems(pods: &[Pod]) -> Vec<ClusterProblem> {
    let mut problems = Vec::new();

    for pod in pods {
        let name = pod.metadata.name.clone().unwrap_or_default();
        let namespace = pod.metadata.namespace.clone();
        let Some(status) = pod.status.as_ref() else {
            continue;
        };
        let phase = status.phase.as_deref().unwrap_or("");

        let restarts: i32 = status
            .container_statuses
            .as_ref()
            .map(|cs| cs.iter().map(|c| c.restart_count).sum())
            .unwrap_or(0);

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
            problems.push(ClusterProblem {
                severity: ProblemSeverity::Critical,
                kind: "Pod".to_string(),
                name,
                namespace,
                reason,
                detail: message,
                since: pod
                    .metadata
                    .creation_timestamp
                    .as_ref()
                    .map(|t| t.0.to_rfc3339()),
                restarts: Some(restarts),
            });
            continue;
        }

        if phase == "Pending" {
            // `PodScheduled=False` carries the scheduler's own explanation
            // ("0/3 nodes are available: Insufficient memory"), which is
            // far more useful than the word "Pending".
            let scheduled = status
                .conditions
                .as_ref()
                .and_then(|cs| cs.iter().find(|c| c.type_ == "PodScheduled").cloned());
            let detail = scheduled
                .as_ref()
                .and_then(|c| c.message.clone())
                .or_else(|| status.message.clone());
            let since = scheduled
                .as_ref()
                .and_then(|c| c.last_transition_time.as_ref().map(|t| t.0.to_rfc3339()))
                .or_else(|| {
                    pod.metadata
                        .creation_timestamp
                        .as_ref()
                        .map(|t| t.0.to_rfc3339())
                });
            problems.push(ClusterProblem {
                severity: ProblemSeverity::Critical,
                kind: "Pod".to_string(),
                name,
                namespace,
                reason: "Pending".to_string(),
                detail,
                since,
                restarts: None,
            });
            continue;
        }

        if restarts >= RESTART_ATTENTION_THRESHOLD && phase == "Running" {
            problems.push(ClusterProblem {
                severity: ProblemSeverity::Warning,
                kind: "Pod".to_string(),
                name,
                namespace,
                reason: "Restarting".to_string(),
                detail: Some(format!("{restarts} restarts since creation")),
                since: pod
                    .metadata
                    .creation_timestamp
                    .as_ref()
                    .map(|t| t.0.to_rfc3339()),
                restarts: Some(restarts),
            });
        }
    }

    problems
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

/// Get everything the overview screen needs in one round trip.
#[tauri::command]
pub async fn get_cluster_overview(state: State<'_, AppState>) -> Result<ClusterOverview> {
    let ctx = ResourceContext::for_list(&state, None)?;
    let params = ListParams::default();
    let pods_api: Api<Pod> = Api::all(ctx.client.clone());
    let nodes_api: Api<Node> = ctx.cluster_api();
    let deployments_api: Api<Deployment> = Api::all(ctx.client.clone());
    let events_api: Api<Event> = Api::all(ctx.client.clone());

    let (pods_result, nodes_result, deployments_result, events_result) = tokio::join!(
        pods_api.list(&params),
        nodes_api.list(&params),
        deployments_api.list(&params),
        events_api.list(&params),
    );

    let pods = pods_result.map_err(Error::from)?.items;
    let nodes = nodes_result.map_err(Error::from)?.items;
    let deployments = deployments_result.map_err(Error::from)?.items;
    // Events are the one input we can lose without making the screen wrong,
    // so a failure here degrades to "no warnings" instead of an error page.
    let events = events_result.map(|l| l.items).unwrap_or_default();

    // Live usage is best-effort: metrics-server is not installed everywhere.
    let node_metrics = crate::metrics::get_node_metrics(&state).await.ok();
    let metrics_available = node_metrics.is_some();
    let usage_by_node: BTreeMap<String, (f64, u64)> = node_metrics
        .map(|m| {
            m.data
                .into_iter()
                .map(|n| {
                    (
                        n.name,
                        (n.cpu_millicores.unwrap_or(0.0), n.memory_bytes.unwrap_or(0)),
                    )
                })
                .collect()
        })
        .unwrap_or_default();

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

    let mut node_summaries = Vec::with_capacity(nodes.len());
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

    for node in &nodes {
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
        let usage = usage_by_node.get(&name).copied();

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

        node_summaries.push(NodeSummary {
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

    let mut problems = pod_problems(&pods);
    problems.extend(deployment_problems(&deployments));
    problems.extend(node_problems(&nodes));
    // Worst first, then oldest first — the top row is both the most severe
    // and the one that has been broken longest.
    problems.sort_by(|a, b| {
        (a.severity == ProblemSeverity::Warning)
            .cmp(&(b.severity == ProblemSeverity::Warning))
            .then_with(|| a.since.cmp(&b.since))
    });

    let mut namespaces: Vec<_> = namespace_counts
        .into_iter()
        .map(|(name, pod_count)| NamespaceLoad { name, pod_count })
        .collect();
    namespaces.sort_by(|a, b| b.pod_count.cmp(&a.pod_count));

    Ok(ClusterOverview {
        problems,
        scheduler: SchedulerPressure {
            cpu: cluster_cpu,
            memory: cluster_memory,
        },
        nodes: node_summaries,
        warnings: recent_warnings(&events),
        namespaces,
        pod_count: pods.len(),
        metrics_available,
    })
}
