//! The pod list's row: what the table draws, and nothing it does not.
//!
//! `PodInfo` is the pod as the detail page needs it, and it costs about
//! 3 KiB a row on the wire; a namespace of ten thousand pods was thirty
//! megabytes in one IPC message. The table reads a dozen of those fields.
//! Every fact here is derived by the same function the detail uses, so the
//! two never disagree; the row only leaves out what no column reads.

use chrono::{DateTime, Utc};
use k8s_openapi::api::core::v1::{Container, ContainerStatus, Pod};
use kube::ResourceExt;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use super::common::{init_phase, state_of, ContainerPhase, ContainerState};
use super::pod::{phase_of, resource_totals};
use super::pod_display::{display_status, restarts};
use crate::utils::Moment;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PodRow {
    pub name: String,
    pub namespace: String,
    pub uid: String,
    pub status: PodRowStatus,
    pub node_name: Option<String>,
    pub pod_ip: Option<String>,
    pub containers: Vec<RowContainer>,
    /// In spec order, sidecars included; see `PodInfo::init_containers`.
    pub init_containers: Vec<RowContainer>,
    /// Kept because the workload lists match their pods by label.
    pub labels: BTreeMap<String, String>,
    pub created_at: Option<DateTime<Utc>>,
    pub restart_count: i32,
    pub last_restart_at: Option<DateTime<Utc>>,
    pub cpu_requests: Option<String>,
    pub cpu_limits: Option<String>,
    pub memory_requests: Option<String>,
    pub memory_limits: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PodRowStatus {
    pub phase: String,
    /// What `kubectl get pod` prints. See `pod_display`.
    pub display: String,
}

/// What the Ready column is decided from, per container.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowContainer {
    pub name: String,
    pub ready: bool,
    pub started: bool,
    pub phase: ContainerPhase,
    pub state: ContainerState,
}

impl RowContainer {
    fn new(
        container: &Container,
        statuses: Option<&Vec<ContainerStatus>>,
        phase: ContainerPhase,
    ) -> Self {
        let status = statuses.and_then(|cs| cs.iter().find(|c| c.name == container.name));
        Self {
            name: container.name.clone(),
            ready: status.is_some_and(|cs| cs.ready),
            started: status.is_some_and(|cs| cs.started.unwrap_or(false)),
            phase,
            state: status.map_or(ContainerState::Unknown, state_of),
        }
    }
}

impl From<&Pod> for PodRow {
    fn from(pod: &Pod) -> Self {
        let status = pod.status.as_ref();
        let spec = pod.spec.as_ref();

        let containers = spec
            .map(|s| {
                let statuses = status.and_then(|s| s.container_statuses.as_ref());
                s.containers
                    .iter()
                    .map(|c| RowContainer::new(c, statuses, ContainerPhase::App))
                    .collect()
            })
            .unwrap_or_default();
        let init_containers = spec
            .and_then(|s| s.init_containers.as_ref())
            .map(|cs| {
                let statuses = status.and_then(|s| s.init_container_statuses.as_ref());
                cs.iter()
                    .map(|c| RowContainer::new(c, statuses, init_phase(c)))
                    .collect()
            })
            .unwrap_or_default();

        let (restart_count, last_restart_at) = restarts(pod);
        let totals = spec.map(resource_totals).unwrap_or_default();

        Self {
            name: pod.name_any(),
            namespace: pod.namespace().unwrap_or_default(),
            uid: pod.uid().unwrap_or_default(),
            status: PodRowStatus {
                phase: phase_of(pod),
                display: display_status(pod),
            },
            node_name: spec.and_then(|s| s.node_name.clone()),
            pod_ip: status.and_then(|s| s.pod_ip.clone()),
            containers,
            init_containers,
            labels: pod.labels().clone(),
            created_at: pod.creation_timestamp().map(|t| t.moment()),
            restart_count,
            last_restart_at,
            cpu_requests: totals.cpu_requests,
            cpu_limits: totals.cpu_limits,
            memory_requests: totals.memory_requests,
            memory_limits: totals.memory_limits,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resources::PodInfo;
    use k8s_openapi::api::core::v1::{
        ContainerState as K8sContainerState, ContainerStateTerminated, ContainerStateWaiting,
        EnvVar, PodSpec, PodStatus, Volume,
    };
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;

    /// A pod the way a Helm chart leaves it: labels, a last-applied
    /// annotation, env, a volume, one crashing container and one sidecar.
    fn helm_pod() -> Pod {
        let mut labels = BTreeMap::new();
        labels.insert("app".to_string(), "web".to_string());
        labels.insert("deployment".to_string(), "web".to_string());
        let mut annotations = BTreeMap::new();
        annotations.insert(
            "kubectl.kubernetes.io/last-applied-configuration".to_string(),
            "{".to_string() + &"\"k\":\"v\",".repeat(200) + "}",
        );
        let mut crashing = ContainerStatus {
            name: "web".to_string(),
            restart_count: 7,
            state: Some(K8sContainerState {
                waiting: Some(ContainerStateWaiting {
                    reason: Some("CrashLoopBackOff".to_string()),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            ..Default::default()
        };
        crashing.last_state = Some(K8sContainerState {
            terminated: Some(ContainerStateTerminated {
                exit_code: 1,
                ..Default::default()
            }),
            ..Default::default()
        });
        Pod {
            metadata: ObjectMeta {
                name: Some("web-5d4c-x9".to_string()),
                namespace: Some("shop".to_string()),
                uid: Some("u-1".to_string()),
                labels: Some(labels),
                annotations: Some(annotations),
                ..Default::default()
            },
            spec: Some(PodSpec {
                node_name: Some("node-a".to_string()),
                containers: vec![Container {
                    name: "web".to_string(),
                    image: Some("web:1".to_string()),
                    env: Some(vec![EnvVar {
                        name: "DATABASE_URL".to_string(),
                        value: Some("postgres://db".to_string()),
                        ..Default::default()
                    }]),
                    ..Default::default()
                }],
                init_containers: Some(vec![Container {
                    name: "proxy".to_string(),
                    restart_policy: Some("Always".to_string()),
                    ..Default::default()
                }]),
                volumes: Some(vec![Volume {
                    name: "config".to_string(),
                    ..Default::default()
                }]),
                ..Default::default()
            }),
            status: Some(PodStatus {
                phase: Some("Running".to_string()),
                pod_ip: Some("10.0.0.9".to_string()),
                container_statuses: Some(vec![crashing]),
                init_container_statuses: Some(vec![ContainerStatus {
                    name: "proxy".to_string(),
                    ready: true,
                    started: Some(true),
                    ..Default::default()
                }]),
                ..Default::default()
            }),
        }
    }

    /// Every fact a column reads comes out of the same function on both
    /// shapes; a row that computed its own status would drift from the page.
    /// The frontend picks the row's type out of the generated `PodInfo`, so
    /// a field the info does not have is one the frontend cannot name.
    #[test]
    fn a_row_agrees_with_the_full_info_on_every_column() {
        let pod = helm_pod();
        let row = PodRow::from(&pod);
        let info = PodInfo::from(&pod);
        let row_json = serde_json::to_value(&row).unwrap();
        let info_json = serde_json::to_value(&info).unwrap();
        for (key, value) in row_json.as_object().unwrap() {
            let full = info_json
                .get(key)
                .unwrap_or_else(|| panic!("{key} is not a PodInfo field"));
            if !matches!(key.as_str(), "status" | "containers" | "initContainers") {
                assert_eq!(value, full, "{key}");
            }
        }
        assert_eq!(row.status.display, info.status.display);
        assert_eq!(row.status.display, "CrashLoopBackOff");
        assert_eq!(row.status.phase, info.status.phase);
        assert_eq!(row.restart_count, info.restart_count);
        assert_eq!(row.last_restart_at, info.last_restart_at);
        assert_eq!(row.node_name, info.node_name);
        assert_eq!(row.pod_ip, info.pod_ip);
        assert_eq!(row.uid, info.uid);
        assert_eq!(row.labels, info.labels);
        assert_eq!(row.cpu_requests, info.cpu_requests);
        assert_eq!(row.containers.len(), info.containers.len());
        assert_eq!(row.init_containers.len(), info.init_containers.len());
        assert!(matches!(
            row.init_containers[0].phase,
            ContainerPhase::Sidecar
        ));
        assert!(row.init_containers[0].ready && row.init_containers[0].started);
        assert!(matches!(
            &row.containers[0].state,
            ContainerState::Waiting { reason: Some(r) } if r == "CrashLoopBackOff"
        ));
    }

    /// The point of the row. A field the table never reads that crept back
    /// in would show up here as bytes.
    #[test]
    fn a_row_leaves_out_what_no_column_reads_and_is_a_fraction_of_the_info() {
        let pod = helm_pod();
        let row = serde_json::to_value(PodRow::from(&pod)).unwrap();
        for absent in ["annotations", "volumes", "ownerReferences", "hostIp"] {
            assert!(row.get(absent).is_none(), "{absent} is not a column");
        }
        assert!(row["containers"][0].get("env").is_none());
        assert!(row["containers"][0].get("image").is_none());
        let row_bytes = serde_json::to_vec(&PodRow::from(&pod)).unwrap().len();
        let info_bytes = serde_json::to_vec(&PodInfo::from(&pod)).unwrap().len();
        assert!(
            row_bytes * 3 < info_bytes,
            "row {row_bytes} bytes, info {info_bytes} bytes"
        );
    }
}
