//! Deployment-specific types: `DeploymentInfo`, `DeploymentContainerInfo`,
//! `DeploymentContainerResources`, `ReplicaInfo`.

use chrono::{DateTime, Utc};
use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::core::v1::{Container, PodSpec};
use k8s_openapi::apimachinery::pkg::api::resource::Quantity;
use kube::ResourceExt;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::resources::serialization::OwnerReference;

use super::common::{
    extract_env_from, extract_env_vars, extract_owner_references, ConditionInfo, ContainerPhase,
    EnvFromInfo, EnvVarInfo,
};
use super::pod_display::is_sidecar;

/// Deployment information for frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentInfo {
    pub name: String,
    pub namespace: String,
    pub uid: String,
    pub replicas: ReplicaInfo,
    pub strategy: Option<String>,
    pub containers: Vec<DeploymentContainerInfo>,
    /// The template's `initContainers`, in the order the kubelet would run
    /// them, with each sidecar marked by its `phase`.
    pub init_containers: Vec<DeploymentContainerInfo>,
    pub labels: BTreeMap<String, String>,
    pub annotations: BTreeMap<String, String>,
    pub created_at: Option<DateTime<Utc>>,
    pub conditions: Vec<ConditionInfo>,
    pub owner_references: Vec<OwnerReference>,
}

/// One container as a workload's pod template declares it.
///
/// Deliberately not `ContainerInfo`, and the two are not merged. A
/// `ContainerInfo` is a spec entry *joined to* the kubelet's status row
/// for it: `ready`, `started`, `state`, `last_terminated` and
/// `restart_count` are all facts about a run, and its ports carry the
/// name and protocol a port-forward needs. This is the declaration on its
/// own, and it carries the two things only a declaration has — the
/// requests and limits every replica will be admitted against. Merging
/// them would ship five empty status fields on every template row and an
/// empty `resources` on every pod row, and leave a reader of the type
/// unable to tell which half of it is meaningful.
///
/// What the two genuinely share is *when the container runs*, which is
/// why `phase` is the same enum and not a second one: a template's init
/// containers and its sidecars group on screen exactly as a pod's do.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentContainerInfo {
    pub name: String,
    pub image: String,
    pub phase: ContainerPhase,
    pub ports: Vec<i32>,
    pub resources: DeploymentContainerResources,
    pub env: Vec<EnvVarInfo>,
    pub env_from: Vec<EnvFromInfo>,
}

/// A pod template's containers, split the way `PodInfo` splits a pod's.
///
/// Five kinds — Deployment, StatefulSet, DaemonSet, Job, CronJob — reach
/// their template through a different path and then want the identical
/// thing from it. Doing it once is also what stops the next kind being
/// added with `.containers` alone, which is how all five came to hide
/// their init containers in the first place.
pub struct TemplateContainers {
    pub containers: Vec<DeploymentContainerInfo>,
    pub init_containers: Vec<DeploymentContainerInfo>,
}

impl TemplateContainers {
    #[must_use]
    pub fn of(spec: Option<&PodSpec>) -> Self {
        let app = spec.map(|s| s.containers.as_slice()).unwrap_or_default();
        let init = spec
            .and_then(|s| s.init_containers.as_deref())
            .unwrap_or_default();

        Self {
            containers: app
                .iter()
                .map(|c| DeploymentContainerInfo::declared(c, ContainerPhase::App))
                .collect(),
            init_containers: init
                .iter()
                .map(|c| DeploymentContainerInfo::declared(c, init_phase(c)))
                .collect(),
        }
    }
}

fn init_phase(container: &Container) -> ContainerPhase {
    if is_sidecar(container) {
        ContainerPhase::Sidecar
    } else {
        ContainerPhase::Init
    }
}

/// Container resource requests/limits
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentContainerResources {
    pub requests: BTreeMap<String, String>,
    pub limits: BTreeMap<String, String>,
}

/// Replica information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplicaInfo {
    pub desired: i32,
    pub ready: i32,
    pub available: i32,
    pub updated: i32,
}

impl From<&Deployment> for DeploymentInfo {
    fn from(deployment: &Deployment) -> Self {
        let status = deployment.status.as_ref();
        let spec = deployment.spec.as_ref();

        let replicas = ReplicaInfo {
            desired: spec.and_then(|s| s.replicas).unwrap_or(0),
            ready: status.and_then(|s| s.ready_replicas).unwrap_or(0),
            available: status.and_then(|s| s.available_replicas).unwrap_or(0),
            updated: status.and_then(|s| s.updated_replicas).unwrap_or(0),
        };

        let conditions = status
            .and_then(|s| s.conditions.as_ref())
            .map(|conds| {
                conds
                    .iter()
                    .map(|c| ConditionInfo {
                        type_: c.type_.clone(),
                        status: c.status.clone(),
                        reason: c.reason.clone(),
                        message: c.message.clone(),
                        last_transition_time: c.last_transition_time.as_ref().map(|t| t.0),
                    })
                    .collect()
            })
            .unwrap_or_default();

        let template = TemplateContainers::of(spec.and_then(|s| s.template.spec.as_ref()));

        Self {
            name: deployment.name_any(),
            namespace: deployment.namespace().unwrap_or_default(),
            uid: deployment.uid().unwrap_or_default(),
            replicas,
            strategy: spec
                .and_then(|s| s.strategy.as_ref())
                .and_then(|s| s.type_.clone()),
            containers: template.containers,
            init_containers: template.init_containers,
            labels: deployment.labels().clone(),
            annotations: deployment.annotations().clone(),
            created_at: deployment.creation_timestamp().map(|t| t.0),
            conditions,
            owner_references: extract_owner_references(
                deployment.metadata.owner_references.as_ref(),
            ),
        }
    }
}

impl DeploymentContainerInfo {
    fn declared(container: &Container, phase: ContainerPhase) -> Self {
        let ports = container
            .ports
            .as_ref()
            .map(|ports| ports.iter().map(|p| p.container_port).collect())
            .unwrap_or_default();

        let resources = DeploymentContainerResources {
            requests: map_quantities(
                container
                    .resources
                    .as_ref()
                    .and_then(|r| r.requests.as_ref()),
            ),
            limits: map_quantities(container.resources.as_ref().and_then(|r| r.limits.as_ref())),
        };

        Self {
            name: container.name.clone(),
            image: container.image.clone().unwrap_or_default(),
            phase,
            ports,
            resources,
            env: extract_env_vars(container),
            env_from: extract_env_from(container),
        }
    }
}

fn map_quantities(input: Option<&BTreeMap<String, Quantity>>) -> BTreeMap<String, String> {
    input
        .map(|values| {
            values
                .iter()
                .map(|(key, value)| (key.clone(), value.0.clone()))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn container(name: &str, restart_policy: Option<&str>) -> Container {
        Container {
            name: name.to_string(),
            image: Some("busybox:1.36".to_string()),
            restart_policy: restart_policy.map(str::to_string),
            ..Default::default()
        }
    }

    /// A template declaring a mesh proxy in `initContainers`, which is how
    /// a native sidecar is written since 1.29.
    fn meshed() -> PodSpec {
        PodSpec {
            init_containers: Some(vec![
                container("wait-for-db", None),
                container("proxy", Some("Always")),
            ]),
            containers: vec![container("app", None)],
            ..Default::default()
        }
    }

    /// Reading `.containers` alone answered "which containers does this
    /// run" with the app container only, on all five kinds that share
    /// this type.
    #[test]
    fn a_templates_init_containers_are_carried() {
        let template = TemplateContainers::of(Some(&meshed()));
        assert_eq!(
            template
                .init_containers
                .iter()
                .map(|c| c.name.as_str())
                .collect::<Vec<_>>(),
            ["wait-for-db", "proxy"]
        );
        assert_eq!(
            template
                .containers
                .iter()
                .map(|c| c.name.as_str())
                .collect::<Vec<_>>(),
            ["app"]
        );
    }

    /// A sidecar runs for the life of the pod and an init container has
    /// exited before anyone looks; filing the proxy with the init sequence
    /// would say it finished.
    #[test]
    fn a_restartable_init_container_is_marked_a_sidecar() {
        let template = TemplateContainers::of(Some(&meshed()));
        assert_eq!(template.init_containers[0].phase, ContainerPhase::Init);
        assert_eq!(template.init_containers[1].phase, ContainerPhase::Sidecar);
        assert_eq!(template.containers[0].phase, ContainerPhase::App);
    }

    /// Most templates declare none, and an absent list is not an error.
    #[test]
    fn a_template_without_init_containers_carries_an_empty_list() {
        let template = TemplateContainers::of(Some(&PodSpec {
            containers: vec![container("app", None)],
            ..Default::default()
        }));
        assert!(template.init_containers.is_empty());
    }
}
