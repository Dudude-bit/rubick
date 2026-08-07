//! Pod-specific types: `PodInfo`, `PodStatusInfo`.

use chrono::{DateTime, Utc};
use k8s_openapi::api::core::v1::Pod;
use kube::ResourceExt;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::resources::serialization::OwnerReference;
use crate::utils::{format_cpu, parse_cpu, parse_memory};

use super::common::{extract_owner_references, ConditionInfo, ContainerInfo};
use super::pod_display::{display_status, restarts};

/// Simplified pod information for frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PodInfo {
    pub name: String,
    pub namespace: String,
    pub uid: String,
    pub status: PodStatusInfo,
    pub node_name: Option<String>,
    pub pod_ip: Option<String>,
    pub host_ip: Option<String>,
    pub containers: Vec<ContainerInfo>,
    pub labels: BTreeMap<String, String>,
    pub annotations: BTreeMap<String, String>,
    pub created_at: Option<DateTime<Utc>>,
    pub restart_count: i32,
    /// When the most recent restart happened, which is what makes a
    /// restart count readable: 653 an hour ago and 653 last week are the
    /// same number and not the same pod.
    pub last_restart_at: Option<DateTime<Utc>>,
    // Resource requests/limits (from spec)
    pub cpu_requests: Option<String>, // aggregated from all containers
    pub cpu_limits: Option<String>,   // aggregated from all containers
    pub memory_requests: Option<String>, // aggregated from all containers
    pub memory_limits: Option<String>, // aggregated from all containers
    // Owner references for related resources
    pub owner_references: Vec<OwnerReference>,
}

impl From<&Pod> for PodInfo {
    fn from(pod: &Pod) -> Self {
        let status = pod.status.as_ref();
        let spec = pod.spec.as_ref();

        let containers = spec
            .map(|s| {
                s.containers
                    .iter()
                    .map(|c| ContainerInfo::from_container(c, status))
                    .collect()
            })
            .unwrap_or_default();

        let (restart_count, last_restart_at) = restarts(pod);

        // Aggregate resource requests and limits from all containers
        let (cpu_requests, cpu_limits, memory_requests, memory_limits) =
            spec.map_or((None, None, None, None), |s| {
                let mut total_cpu_requests_millicores = 0.0f64;
                let mut total_cpu_limits_millicores = 0.0f64;
                let mut total_memory_requests_bytes = 0u64;
                let mut total_memory_limits_bytes = 0u64;

                for container in &s.containers {
                    if let Some(resources) = &container.resources {
                        if let Some(requests) = &resources.requests {
                            if let Some(cpu) = requests.get("cpu") {
                                total_cpu_requests_millicores += parse_cpu(&cpu.0);
                            }
                            if let Some(memory) = requests.get("memory") {
                                total_memory_requests_bytes += parse_memory(&memory.0);
                            }
                        }
                        if let Some(limits) = &resources.limits {
                            if let Some(cpu) = limits.get("cpu") {
                                total_cpu_limits_millicores += parse_cpu(&cpu.0);
                            }
                            if let Some(memory) = limits.get("memory") {
                                total_memory_limits_bytes += parse_memory(&memory.0);
                            }
                        }
                    }
                }

                let cpu_requests = if total_cpu_requests_millicores > 0.0 {
                    Some(format_cpu(total_cpu_requests_millicores))
                } else {
                    None
                };
                let cpu_limits = if total_cpu_limits_millicores > 0.0 {
                    Some(format_cpu(total_cpu_limits_millicores))
                } else {
                    None
                };
                let memory_requests = if total_memory_requests_bytes > 0 {
                    Some(format!("{total_memory_requests_bytes}"))
                } else {
                    None
                };
                let memory_limits = if total_memory_limits_bytes > 0 {
                    Some(format!("{total_memory_limits_bytes}"))
                } else {
                    None
                };

                (cpu_requests, cpu_limits, memory_requests, memory_limits)
            });

        Self {
            name: pod.name_any(),
            namespace: pod.namespace().unwrap_or_default(),
            uid: pod.uid().unwrap_or_default(),
            status: PodStatusInfo::from_pod(pod),
            node_name: spec.and_then(|s| s.node_name.clone()),
            pod_ip: status.and_then(|s| s.pod_ip.clone()),
            host_ip: status.and_then(|s| s.host_ip.clone()),
            containers,
            labels: pod.labels().clone(),
            annotations: pod.annotations().clone(),
            created_at: pod.creation_timestamp().map(|t| t.0),
            restart_count,
            last_restart_at,
            cpu_requests,
            cpu_limits,
            memory_requests,
            memory_limits,
            owner_references: extract_owner_references(pod.metadata.owner_references.as_ref()),
        }
    }
}

/// Pod status information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PodStatusInfo {
    /// The raw `.status.phase`. Kept because it is a real fact an SRE
    /// sometimes wants — a pod can be in phase `Running` while its only
    /// container loops — but it is never what the app leads with.
    pub phase: String,
    /// What `kubectl get pod` prints. See `pod_display`.
    pub display: String,
    pub ready: bool,
    pub conditions: Vec<ConditionInfo>,
    pub message: Option<String>,
    pub reason: Option<String>,
}

impl PodStatusInfo {
    fn from_pod(pod: &Pod) -> Self {
        let display = display_status(pod);
        let status = match pod.status.as_ref() {
            Some(s) => s,
            None => {
                return Self {
                    phase: "Unknown".to_string(),
                    display,
                    ready: false,
                    conditions: vec![],
                    message: None,
                    reason: None,
                }
            }
        };

        let ready = status.conditions.as_ref().is_some_and(|conds| {
            conds
                .iter()
                .any(|c| c.type_ == "Ready" && c.status == "True")
        });

        let conditions = status
            .conditions
            .as_ref()
            .map(|conds| conds.iter().map(ConditionInfo::from).collect())
            .unwrap_or_default();

        Self {
            phase: status
                .phase
                .clone()
                .unwrap_or_else(|| "Unknown".to_string()),
            display,
            ready,
            conditions,
            message: status.message.clone(),
            reason: status.reason.clone(),
        }
    }
}
