//! Shared type definitions used across multiple resource kinds:
//! environment variables, conditions, container info, owner refs.

use chrono::{DateTime, Utc};
use k8s_openapi::api::core::v1::{
    Container, ContainerStateTerminated, ContainerStatus, EnvVar, EnvVarSource as K8sEnvVarSource,
    NodeCondition, PodCondition, PodStatus,
};
use serde::{Deserialize, Serialize};

use crate::resources::serialization::OwnerReference;

use super::pod_display::is_sidecar;

/// Extract owner references from Kubernetes metadata
pub fn extract_owner_references(
    owner_refs: Option<&Vec<k8s_openapi::apimachinery::pkg::apis::meta::v1::OwnerReference>>,
) -> Vec<OwnerReference> {
    owner_refs
        .map(|refs| {
            refs.iter()
                .map(|r| OwnerReference {
                    api_version: r.api_version.clone(),
                    kind: r.kind.clone(),
                    name: r.name.clone(),
                    uid: r.uid.clone(),
                    controller: r.controller,
                    block_owner_deletion: r.block_owner_deletion,
                })
                .collect()
        })
        .unwrap_or_default()
}

// ============= Environment Variable Types =============

/// Environment variable information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvVarInfo {
    pub name: String,
    pub value: Option<String>,
    pub value_from: Option<EnvVarSourceInfo>,
}

/// Environment variable source reference
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvVarSourceInfo {
    pub source_type: EnvVarSourceType,
    pub name: Option<String>,
    pub key: Option<String>,
    pub field_path: Option<String>,
    pub resource: Option<String>,
    pub optional: Option<bool>,
}

/// Environment variable source type
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EnvVarSourceType {
    ConfigMapKeyRef,
    SecretKeyRef,
    FieldRef,
    ResourceFieldRef,
}

/// EnvFrom source reference (bulk import from ConfigMap/Secret)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvFromInfo {
    pub prefix: Option<String>,
    pub config_map_ref: Option<String>,
    pub secret_ref: Option<String>,
    pub optional: Option<bool>,
}

impl From<&EnvVar> for EnvVarInfo {
    fn from(env: &EnvVar) -> Self {
        Self {
            name: env.name.clone(),
            value: env.value.clone(),
            value_from: env.value_from.as_ref().map(EnvVarSourceInfo::from),
        }
    }
}

impl From<&K8sEnvVarSource> for EnvVarSourceInfo {
    fn from(source: &K8sEnvVarSource) -> Self {
        if let Some(cm_ref) = &source.config_map_key_ref {
            return Self {
                source_type: EnvVarSourceType::ConfigMapKeyRef,
                name: Some(cm_ref.name.clone()),
                key: Some(cm_ref.key.clone()),
                field_path: None,
                resource: None,
                optional: cm_ref.optional,
            };
        }
        if let Some(secret_ref) = &source.secret_key_ref {
            return Self {
                source_type: EnvVarSourceType::SecretKeyRef,
                name: Some(secret_ref.name.clone()),
                key: Some(secret_ref.key.clone()),
                field_path: None,
                resource: None,
                optional: secret_ref.optional,
            };
        }
        if let Some(field_ref) = &source.field_ref {
            return Self {
                source_type: EnvVarSourceType::FieldRef,
                name: None,
                key: None,
                field_path: Some(field_ref.field_path.clone()),
                resource: None,
                optional: None,
            };
        }
        if let Some(resource_ref) = &source.resource_field_ref {
            return Self {
                source_type: EnvVarSourceType::ResourceFieldRef,
                name: resource_ref.container_name.clone(),
                key: None,
                field_path: None,
                resource: Some(resource_ref.resource.clone()),
                optional: None,
            };
        }
        // Fallback (shouldn't happen with valid K8s data)
        Self {
            source_type: EnvVarSourceType::FieldRef,
            name: None,
            key: None,
            field_path: None,
            resource: None,
            optional: None,
        }
    }
}

pub(crate) fn extract_env_vars(container: &Container) -> Vec<EnvVarInfo> {
    container
        .env
        .as_ref()
        .map(|envs| envs.iter().map(EnvVarInfo::from).collect())
        .unwrap_or_default()
}

pub(crate) fn extract_env_from(container: &Container) -> Vec<EnvFromInfo> {
    container
        .env_from
        .as_ref()
        .map(|env_froms| {
            env_froms
                .iter()
                .map(|ef| EnvFromInfo {
                    prefix: ef.prefix.clone(),
                    config_map_ref: ef.config_map_ref.as_ref().map(|r| r.name.clone()),
                    secret_ref: ef.secret_ref.as_ref().map(|r| r.name.clone()),
                    optional: ef
                        .config_map_ref
                        .as_ref()
                        .and_then(|r| r.optional)
                        .or_else(|| ef.secret_ref.as_ref().and_then(|r| r.optional)),
                })
                .collect()
        })
        .unwrap_or_default()
}

// ============= Condition =============

/// Condition information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConditionInfo {
    pub type_: String,
    pub status: String,
    pub reason: Option<String>,
    pub message: Option<String>,
    pub last_transition_time: Option<DateTime<Utc>>,
}

impl From<&PodCondition> for ConditionInfo {
    fn from(cond: &PodCondition) -> Self {
        Self {
            type_: cond.type_.clone(),
            status: cond.status.clone(),
            reason: cond.reason.clone(),
            message: cond.message.clone(),
            last_transition_time: cond.last_transition_time.as_ref().map(|t| t.0),
        }
    }
}

impl From<&NodeCondition> for ConditionInfo {
    fn from(cond: &NodeCondition) -> Self {
        Self {
            type_: cond.type_.clone(),
            status: cond.status.clone(),
            reason: cond.reason.clone(),
            message: cond.message.clone(),
            last_transition_time: cond.last_transition_time.as_ref().map(|t| t.0),
        }
    }
}

// ============= Container =============

/// When a container runs, relative to the rest of the pod.
///
/// One container type with a phase rather than a parallel
/// `InitContainerInfo`: an init container and an app container differ by
/// when they run, not by what they are, and every field below means the
/// same thing for both. `Sidecar` is an init container with
/// `restartPolicy: Always` — it starts during init and never finishes,
/// so it belongs to neither group on screen. The judgement is made once,
/// in `pod_display`, and shipped; the frontend never sees a restart
/// policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ContainerPhase {
    App,
    Init,
    Sidecar,
}

/// Container information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerInfo {
    pub name: String,
    pub image: String,
    pub ready: bool,
    pub phase: ContainerPhase,
    pub state: ContainerState,
    /// How the previous run of this container ended.
    ///
    /// The only place the exit code of a crash-looping container exists:
    /// its *current* state is `Waiting · CrashLoopBackOff`, which says
    /// that it dies and never why.
    ///
    /// It is also the answer to "is there a previous run to read?" —
    /// the kubelet sets `lastState.terminated` for exactly the container
    /// instances whose logs `--previous` can still fetch, so a caller
    /// offering that control can tell beforehand whether it would work
    /// instead of finding out from an error.
    pub last_terminated: Option<TerminationInfo>,
    pub restart_count: i32,
    pub ports: Vec<ContainerPortInfo>,
    pub env: Vec<EnvVarInfo>,
    pub env_from: Vec<EnvFromInfo>,
}

impl ContainerInfo {
    /// A `.spec.containers` entry, matched to `.status.containerStatuses`.
    pub fn from_container(container: &Container, pod_status: Option<&PodStatus>) -> Self {
        Self::build(
            container,
            pod_status.and_then(|s| s.container_statuses.as_ref()),
            ContainerPhase::App,
        )
    }

    /// A `.spec.initContainers` entry, matched to
    /// `.status.initContainerStatuses` — a different list, which is why
    /// init containers were invisible while this only read one of them.
    pub fn from_init_container(container: &Container, pod_status: Option<&PodStatus>) -> Self {
        let phase = if is_sidecar(container) {
            ContainerPhase::Sidecar
        } else {
            ContainerPhase::Init
        };
        Self::build(
            container,
            pod_status.and_then(|s| s.init_container_statuses.as_ref()),
            phase,
        )
    }

    fn build(
        container: &Container,
        statuses: Option<&Vec<ContainerStatus>>,
        phase: ContainerPhase,
    ) -> Self {
        let container_status = statuses.and_then(|cs| cs.iter().find(|c| c.name == container.name));

        let (ready, state, last_terminated, restart_count) = if let Some(cs) = container_status {
            let state = if cs.state.as_ref().and_then(|s| s.running.as_ref()).is_some() {
                ContainerState::Running
            } else if let Some(waiting) = cs.state.as_ref().and_then(|s| s.waiting.as_ref()) {
                ContainerState::Waiting {
                    reason: waiting.reason.clone(),
                }
            } else if let Some(terminated) = cs.state.as_ref().and_then(|s| s.terminated.as_ref()) {
                ContainerState::Terminated {
                    termination: TerminationInfo::from(terminated),
                }
            } else {
                ContainerState::Unknown
            };

            let last = cs
                .last_state
                .as_ref()
                .and_then(|s| s.terminated.as_ref())
                .map(TerminationInfo::from);

            (cs.ready, state, last, cs.restart_count)
        } else {
            (false, ContainerState::Unknown, None, 0)
        };

        let ports = container
            .ports
            .as_ref()
            .map(|ps| {
                ps.iter()
                    .map(|p| ContainerPortInfo {
                        name: p.name.clone(),
                        container_port: p.container_port,
                        protocol: p.protocol.clone().unwrap_or_else(|| "TCP".to_string()),
                    })
                    .collect()
            })
            .unwrap_or_default();

        Self {
            name: container.name.clone(),
            image: container.image.clone().unwrap_or_default(),
            ready,
            phase,
            state,
            last_terminated,
            restart_count,
            ports,
            env: extract_env_vars(container),
            env_from: extract_env_from(container),
        }
    }
}

/// How a container run ended, current or previous.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminationInfo {
    pub exit_code: i32,
    /// Set instead of a meaningful exit code when the kernel killed it.
    pub signal: Option<i32>,
    pub reason: Option<String>,
    pub message: Option<String>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
}

impl From<&ContainerStateTerminated> for TerminationInfo {
    fn from(terminated: &ContainerStateTerminated) -> Self {
        Self {
            exit_code: terminated.exit_code,
            signal: terminated.signal.filter(|s| *s != 0),
            reason: terminated.reason.clone(),
            message: terminated.message.clone(),
            started_at: terminated.started_at.as_ref().map(|t| t.0),
            finished_at: terminated.finished_at.as_ref().map(|t| t.0),
        }
    }
}

/// Container state
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ContainerState {
    Running,
    Waiting { reason: Option<String> },
    Terminated { termination: TerminationInfo },
    Unknown,
}

/// Container port information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerPortInfo {
    pub name: Option<String>,
    pub container_port: i32,
    pub protocol: String,
}
