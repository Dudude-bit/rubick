//! Pod-specific types: `PodInfo`, `PodStatusInfo`.

use chrono::{DateTime, Utc};
use k8s_openapi::api::core::v1::{Container, Pod, PodSpec, Volume};
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
    /// `.spec.initContainers`, in the order the kubelet runs them.
    ///
    /// The order is the whole point: an init container that is waiting
    /// at position 2 has not failed, it has not been given a turn, and
    /// no per-container state says that on its own. Sidecars stay in
    /// this list at their spec position and are told apart by `phase` —
    /// hoisting them into a list of their own would throw the position
    /// away, and it is the position that explains the ones behind them.
    ///
    /// Kept beside `containers` rather than merged into it because the
    /// two answer different questions, and because everything already
    /// reading `containers` means app containers by it.
    pub init_containers: Vec<ContainerInfo>,
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
    /// `.spec.volumes`, joined to the mounts that consume them.
    ///
    /// The pod already names every `ConfigMap`, Secret and claim it depends on
    /// here, and until now none of it reached the frontend — the only way to
    /// find out what a pod mounts was to read its YAML.
    pub volumes: Vec<PodVolumeInfo>,
    /// The identity the pod's containers hold against the API server.
    /// `None` where the spec left it out, which the API server fills in as
    /// `default` — so a blank here means "not stated", not "no identity".
    pub service_account_name: Option<String>,
}

/// A volume the pod declares, and the objects it draws from.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PodVolumeInfo {
    pub name: String,
    /// The spec's own word for the source — `configMap`, `emptyDir`,
    /// `projected`. Kept even when `refs` is populated, because "this claim,
    /// mounted directly" and "this claim, behind a projection" are different
    /// facts about the same object.
    pub source: String,
    /// The objects the volume draws from, empty where the source names none:
    /// an `emptyDir` is storage, not a reference. A `projected` volume names
    /// one per source, which is why this is a list and not one optional pair.
    pub refs: Vec<VolumeObjectRef>,
    /// Where the pod's containers mount it. Empty is a real answer, and the
    /// interesting one: a volume declared and mounted by nothing is a silent
    /// mistake the YAML does not point at.
    pub mounts: Vec<VolumeMountInfo>,
}

/// One object a volume names. Namespace is the pod's — a volume cannot reach
/// across one — so it is not carried.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeObjectRef {
    pub kind: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeMountInfo {
    pub container: String,
    pub path: String,
    pub read_only: bool,
    pub sub_path: Option<String>,
}

/// What the volume is, and what it names, from whichever source field is set.
///
/// The order is the spec's own exclusivity: a `Volume` sets exactly one
/// source, so the first match is the only match. `projected` is the one that
/// names several objects, and it is also the one on every pod in the cluster
/// — the `kube-api-access-*` volume the API server injects projects the
/// `kube-root-ca.crt` `ConfigMap`, which is a real object worth reaching.
#[must_use]
pub fn volume_source(volume: &Volume) -> (String, Vec<VolumeObjectRef>) {
    let object = |kind: &str, name: &str| VolumeObjectRef {
        kind: kind.to_string(),
        name: name.to_string(),
    };

    if let Some(config_map) = &volume.config_map {
        let name = config_map.name.clone();
        return ("configMap".into(), vec![object("ConfigMap", &name)]);
    }
    if let Some(secret) = &volume.secret {
        let refs = secret
            .secret_name
            .as_deref()
            .map(|name| vec![object("Secret", name)])
            .unwrap_or_default();
        return ("secret".into(), refs);
    }
    if let Some(claim) = &volume.persistent_volume_claim {
        return (
            "persistentVolumeClaim".into(),
            vec![object("PersistentVolumeClaim", &claim.claim_name)],
        );
    }
    if let Some(projected) = &volume.projected {
        let refs = projected
            .sources
            .iter()
            .flatten()
            .filter_map(|source| {
                if let Some(config_map) = &source.config_map {
                    return Some(object("ConfigMap", &config_map.name));
                }
                source
                    .secret
                    .as_ref()
                    .map(|secret| object("Secret", &secret.name))
            })
            .collect();
        return ("projected".into(), refs);
    }
    if volume.empty_dir.is_some() {
        return ("emptyDir".into(), Vec::new());
    }
    if volume.host_path.is_some() {
        return ("hostPath".into(), Vec::new());
    }
    if volume.downward_api.is_some() {
        return ("downwardAPI".into(), Vec::new());
    }
    if volume.csi.is_some() {
        return ("csi".into(), Vec::new());
    }
    ("other".into(), Vec::new())
}

/// Every mount of `volume_name`, across app and init containers alike.
///
/// Both lists are walked: a `ConfigMap` read only by an init container is
/// exactly the mount whose absence explains a pod stuck in `Init:Error`.
#[must_use]
pub fn mounts_of(spec: &PodSpec, volume_name: &str) -> Vec<VolumeMountInfo> {
    let init = spec.init_containers.as_deref().unwrap_or_default();
    let each = |container: &Container| {
        let name = container.name.clone();
        container
            .volume_mounts
            .iter()
            .flatten()
            .filter(|mount| mount.name == volume_name)
            .map(|mount| VolumeMountInfo {
                container: name.clone(),
                path: mount.mount_path.clone(),
                read_only: mount.read_only.unwrap_or(false),
                sub_path: mount.sub_path.clone(),
            })
            .collect::<Vec<_>>()
    };

    init.iter().chain(&spec.containers).flat_map(each).collect()
}

fn pod_volumes(spec: &PodSpec) -> Vec<PodVolumeInfo> {
    spec.volumes
        .iter()
        .flatten()
        .map(|volume| {
            let (source, refs) = volume_source(volume);
            PodVolumeInfo {
                name: volume.name.clone(),
                source,
                refs,
                mounts: mounts_of(spec, &volume.name),
            }
        })
        .collect()
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

        let init_containers = spec
            .and_then(|s| s.init_containers.as_ref())
            .map(|cs| {
                cs.iter()
                    .map(|c| ContainerInfo::from_init_container(c, status))
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
            init_containers,
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
            volumes: spec.map(pod_volumes).unwrap_or_default(),
            service_account_name: spec.and_then(|s| s.service_account_name.clone()),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resources::{ContainerPhase, ContainerState};
    use k8s_openapi::api::core::v1::{
        ConfigMapProjection, ConfigMapVolumeSource, Container, ContainerState as K8sContainerState,
        ContainerStateRunning, ContainerStateTerminated, ContainerStateWaiting, ContainerStatus,
        EmptyDirVolumeSource, PersistentVolumeClaimVolumeSource, PodSpec, PodStatus,
        ProjectedVolumeSource, SecretVolumeSource, VolumeMount, VolumeProjection,
    };
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::Time;

    fn init_container(name: &str, sidecar: bool) -> Container {
        Container {
            name: name.to_string(),
            image: Some("busybox:1.36".to_string()),
            restart_policy: sidecar.then(|| "Always".to_string()),
            ..Default::default()
        }
    }

    fn status(name: &str, state: K8sContainerState) -> ContainerStatus {
        ContainerStatus {
            name: name.to_string(),
            state: Some(state),
            ..Default::default()
        }
    }

    fn succeeded(at: DateTime<Utc>) -> K8sContainerState {
        K8sContainerState {
            terminated: Some(ContainerStateTerminated {
                exit_code: 0,
                reason: Some("Completed".to_string()),
                finished_at: Some(Time(at)),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    fn waiting(reason: &str) -> K8sContainerState {
        K8sContainerState {
            waiting: Some(ContainerStateWaiting {
                reason: Some(reason.to_string()),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    /// `init-demo`: `wait-for-db` succeeds, `migrate` crash-loops,
    /// `seed` never gets a turn, and the app container never starts.
    fn init_demo(finished_at: DateTime<Utc>, failed_at: DateTime<Utc>) -> Pod {
        let mut migrate = status("migrate", waiting("CrashLoopBackOff"));
        migrate.restart_count = 4;
        migrate.last_state = Some(K8sContainerState {
            terminated: Some(ContainerStateTerminated {
                exit_code: 1,
                reason: Some("Error".to_string()),
                finished_at: Some(Time(failed_at)),
                ..Default::default()
            }),
            ..Default::default()
        });

        Pod {
            spec: Some(PodSpec {
                init_containers: Some(vec![
                    init_container("wait-for-db", false),
                    init_container("migrate", false),
                    init_container("seed", false),
                ]),
                containers: vec![init_container("app", false)],
                ..Default::default()
            }),
            status: Some(PodStatus {
                phase: Some("Pending".to_string()),
                init_container_statuses: Some(vec![
                    status("wait-for-db", succeeded(finished_at)),
                    migrate,
                    status("seed", waiting("PodInitializing")),
                ]),
                container_statuses: Some(vec![status("app", waiting("PodInitializing"))]),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    #[test]
    fn init_containers_reach_the_frontend_in_the_order_they_run() {
        let info = PodInfo::from(&init_demo(Utc::now(), Utc::now()));

        assert_eq!(
            info.init_containers
                .iter()
                .map(|c| c.name.as_str())
                .collect::<Vec<_>>(),
            ["wait-for-db", "migrate", "seed"],
            "spec order is the run order, and it is the only thing that says \
             `seed` did not fail but never started",
        );
        assert_eq!(
            info.containers
                .iter()
                .map(|c| c.name.as_str())
                .collect::<Vec<_>>(),
            ["app"],
            "app containers stay where every existing consumer looks for them",
        );
    }

    #[test]
    fn a_failing_init_container_carries_the_exit_it_is_backing_off_from() {
        let failed_at = Utc::now();
        let info = PodInfo::from(&init_demo(Utc::now(), failed_at));
        let migrate = &info.init_containers[1];

        assert!(matches!(
            &migrate.state,
            ContainerState::Waiting { reason } if reason.as_deref() == Some("CrashLoopBackOff")
        ));
        assert_eq!(migrate.restart_count, 4);
        let death = migrate
            .last_terminated
            .as_ref()
            .expect("a crash-looping container has a previous run to read");
        assert_eq!(death.exit_code, 1);
        assert_eq!(death.finished_at, Some(failed_at));
    }

    /// The distinction the whole rail exists to draw: one of these has
    /// run and failed, the other has never been started.
    #[test]
    fn a_never_started_init_container_has_no_previous_run() {
        let info = PodInfo::from(&init_demo(Utc::now(), Utc::now()));

        assert!(info.init_containers[1].last_terminated.is_some());
        assert!(
            info.init_containers[2].last_terminated.is_none(),
            "`seed` never ran, so a previous-run request for it has no answer",
        );
        assert_eq!(info.init_containers[2].restart_count, 0);
    }

    /// A finished init container is a historical fact, not an absence.
    /// The state has to carry *when*, or the only thing the UI can say
    /// is "not running" — which is also true of a container that has
    /// not started yet.
    #[test]
    fn a_finished_init_container_reports_when_it_finished() {
        let finished_at = Utc::now();
        let info = PodInfo::from(&init_demo(finished_at, Utc::now()));

        match &info.init_containers[0].state {
            ContainerState::Terminated { termination } => {
                assert_eq!(termination.exit_code, 0);
                assert_eq!(termination.finished_at, Some(finished_at));
            }
            other => panic!("expected a finished init container, got {other:?}"),
        }
    }

    #[test]
    fn every_container_says_which_phase_it_belongs_to() {
        let info = PodInfo::from(&init_demo(Utc::now(), Utc::now()));

        assert!(info
            .init_containers
            .iter()
            .all(|c| c.phase == ContainerPhase::Init));
        assert_eq!(info.containers[0].phase, ContainerPhase::App);
    }

    /// `sidecar-demo`: `proxy` is an init container that never finishes.
    /// The frontend must not have to know it is spelled
    /// `restartPolicy: Always`.
    #[test]
    fn a_sidecar_is_marked_as_one_without_shipping_its_restart_policy() {
        let mut proxy = status(
            "proxy",
            K8sContainerState {
                running: Some(ContainerStateRunning::default()),
                ..Default::default()
            },
        );
        proxy.started = Some(true);

        let pod = Pod {
            spec: Some(PodSpec {
                init_containers: Some(vec![
                    init_container("prepare", false),
                    init_container("proxy", true),
                ]),
                containers: vec![init_container("app", false)],
                ..Default::default()
            }),
            status: Some(PodStatus {
                phase: Some("Running".to_string()),
                init_container_statuses: Some(vec![
                    status("prepare", succeeded(Utc::now())),
                    proxy,
                ]),
                ..Default::default()
            }),
            ..Default::default()
        };

        let info = PodInfo::from(&pod);
        assert_eq!(info.init_containers[0].phase, ContainerPhase::Init);
        assert_eq!(
            info.init_containers[1].phase,
            ContainerPhase::Sidecar,
            "a sidecar keeps its position in the init sequence and is told \
             apart by phase, not by being moved to another list",
        );
        assert!(matches!(
            info.init_containers[1].state,
            ContainerState::Running
        ));
    }

    #[test]
    fn a_pod_without_init_containers_reports_an_empty_sequence() {
        let pod = Pod {
            spec: Some(PodSpec {
                containers: vec![init_container("app", false)],
                ..Default::default()
            }),
            status: Some(PodStatus {
                phase: Some("Running".to_string()),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert!(PodInfo::from(&pod).init_containers.is_empty());
    }

    fn mounted(name: &str, path: &str) -> VolumeMount {
        VolumeMount {
            name: name.to_string(),
            mount_path: path.to_string(),
            ..Default::default()
        }
    }

    /// A pod that mounts one of each of the three kinds a volume can name,
    /// plus an `emptyDir` that names none and the projected volume the API
    /// server injects into every pod.
    fn mounting_demo() -> Pod {
        Pod {
            spec: Some(PodSpec {
                volumes: Some(vec![
                    Volume {
                        name: "cfg".to_string(),
                        config_map: Some(ConfigMapVolumeSource {
                            name: "app-config".to_string(),
                            ..Default::default()
                        }),
                        ..Default::default()
                    },
                    Volume {
                        name: "creds".to_string(),
                        secret: Some(SecretVolumeSource {
                            secret_name: Some("app-secret".to_string()),
                            ..Default::default()
                        }),
                        ..Default::default()
                    },
                    Volume {
                        name: "data".to_string(),
                        persistent_volume_claim: Some(PersistentVolumeClaimVolumeSource {
                            claim_name: "data-claim".to_string(),
                            ..Default::default()
                        }),
                        ..Default::default()
                    },
                    Volume {
                        name: "scratch".to_string(),
                        empty_dir: Some(EmptyDirVolumeSource::default()),
                        ..Default::default()
                    },
                    Volume {
                        name: "kube-api-access".to_string(),
                        projected: Some(ProjectedVolumeSource {
                            sources: Some(vec![VolumeProjection {
                                config_map: Some(ConfigMapProjection {
                                    name: "kube-root-ca.crt".to_string(),
                                    ..Default::default()
                                }),
                                ..Default::default()
                            }]),
                            ..Default::default()
                        }),
                        ..Default::default()
                    },
                ]),
                init_containers: Some(vec![Container {
                    name: "migrate".to_string(),
                    volume_mounts: Some(vec![mounted("cfg", "/etc/config")]),
                    ..Default::default()
                }]),
                containers: vec![Container {
                    name: "app".to_string(),
                    volume_mounts: Some(vec![
                        mounted("cfg", "/etc/config"),
                        mounted("data", "/var/lib/data"),
                    ]),
                    ..Default::default()
                }],
                service_account_name: Some("app-sa".to_string()),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    #[test]
    fn a_volume_names_the_object_it_draws_from() {
        let info = PodInfo::from(&mounting_demo());

        assert_eq!(
            info.volumes
                .iter()
                .map(|v| (
                    v.name.as_str(),
                    v.source.as_str(),
                    v.refs
                        .iter()
                        .map(|r| (r.kind.as_str(), r.name.as_str()))
                        .collect::<Vec<_>>()
                ))
                .collect::<Vec<_>>(),
            [
                ("cfg", "configMap", vec![("ConfigMap", "app-config")]),
                ("creds", "secret", vec![("Secret", "app-secret")]),
                (
                    "data",
                    "persistentVolumeClaim",
                    vec![("PersistentVolumeClaim", "data-claim")]
                ),
                ("scratch", "emptyDir", vec![]),
                (
                    "kube-api-access",
                    "projected",
                    vec![("ConfigMap", "kube-root-ca.crt")]
                ),
            ],
            "the kind and name are what make a volume somewhere you can go; \
             flattening them into one display string is what kept every pod's \
             ConfigMap and claim unreachable"
        );
    }

    #[test]
    fn a_mount_by_an_init_container_counts_as_a_mount() {
        let info = PodInfo::from(&mounting_demo());
        let cfg = info.volumes.iter().find(|v| v.name == "cfg").unwrap();

        assert_eq!(
            cfg.mounts
                .iter()
                .map(|m| (m.container.as_str(), m.path.as_str()))
                .collect::<Vec<_>>(),
            [("migrate", "/etc/config"), ("app", "/etc/config")],
            "a ConfigMap read only by an init container is exactly the mount \
             whose absence explains a pod stuck in Init:Error — walking only \
             .containers would report it as mounted by nothing"
        );
    }

    #[test]
    fn a_volume_nothing_mounts_says_so() {
        let info = PodInfo::from(&mounting_demo());
        let creds = info.volumes.iter().find(|v| v.name == "creds").unwrap();

        assert!(
            creds.mounts.is_empty(),
            "a volume declared and mounted by nothing is a silent mistake, and \
             reporting it as mounted somewhere would hide it"
        );
    }

    #[test]
    fn the_pods_identity_reaches_the_frontend() {
        assert_eq!(
            PodInfo::from(&mounting_demo())
                .service_account_name
                .as_deref(),
            Some("app-sa"),
            "the identity a pod holds against the API server was in the spec \
             all along and reached no screen"
        );
    }
}
