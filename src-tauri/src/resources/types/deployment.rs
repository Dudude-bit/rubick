//! Deployment-specific types: `DeploymentInfo`, `DeploymentContainerInfo`,
//! `DeploymentContainerResources`, `ReplicaInfo`.

use chrono::{DateTime, Utc};
use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::core::v1::{Container, PodSpec, PodTemplateSpec};
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
use crate::utils::Moment;

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
    /// The identity every replica will hold; see `TemplateContainers`.
    pub service_account_name: Option<String>,
    pub pod_resources: DeploymentContainerResources,
    pub labels: BTreeMap<String, String>,
    pub annotations: BTreeMap<String, String>,
    /// The template's own annotations: where a chart puts its config checksum.
    pub template_annotations: BTreeMap<String, String>,
    pub generation: Option<i64>,
    pub observed_generation: Option<i64>,
    pub created_at: Option<DateTime<Utc>>,
    pub conditions: Vec<ConditionInfo>,
    pub owner_references: Vec<OwnerReference>,
}

/// One container as a workload's pod template declares it.
///
/// Deliberately not `ContainerInfo`, which is a spec entry *joined to* the
/// kubelet's status row for it: `ready`, `started`, `state`,
/// `last_terminated`, `restart_count`, and ports carrying the name and
/// protocol a port-forward needs. This is the declaration on its own, and it
/// carries what only a declaration has — the requests and limits every
/// replica will be admitted against. Merging the two would ship five empty
/// status fields on every template row and an empty `resources` on every pod
/// row.
///
/// `phase` is the same enum in both because a template's init containers and
/// its sidecars group on screen exactly as a pod's do.
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
/// Five kinds — Deployment, `StatefulSet`, `DaemonSet`, Job, `CronJob` — reach
/// their template through a different path and then want the identical thing
/// from it. Doing it once is what stops the next kind being added with
/// `.containers` alone, which hides that kind's init containers.
pub struct TemplateContainers {
    pub containers: Vec<DeploymentContainerInfo>,
    pub init_containers: Vec<DeploymentContainerInfo>,
    /// The identity every replica will hold. Carried here rather than read
    /// again per kind for the reason the container lists are: the kind that
    /// reads the `PodSpec` itself is the one that forgets, and shows nothing.
    pub service_account_name: Option<String>,
    /// Pod-level requests/limits the template declares (KEP-2837), carried
    /// like `service_account_name` because it is a property of the `PodSpec`,
    /// not of any container. Where set, it is the replica's own ceiling in
    /// place of the container sum — the Usage block applies it exactly as
    /// `PodInfo` does, so a controller and its pods do not disagree.
    pub pod_resources: DeploymentContainerResources,
}

impl TemplateContainers {
    #[must_use]
    pub fn of(spec: Option<&PodSpec>) -> Self {
        let app = spec.map(|s| s.containers.as_slice()).unwrap_or_default();
        let init = spec
            .and_then(|s| s.init_containers.as_deref())
            .unwrap_or_default();
        let pod_level = spec.and_then(|s| s.resources.as_ref());

        Self {
            containers: app
                .iter()
                .map(|c| DeploymentContainerInfo::declared(c, ContainerPhase::App))
                .collect(),
            init_containers: init
                .iter()
                .map(|c| DeploymentContainerInfo::declared(c, init_phase(c)))
                .collect(),
            service_account_name: spec.and_then(|s| s.service_account_name.clone()),
            pod_resources: DeploymentContainerResources {
                requests: map_quantities(pod_level.and_then(|r| r.requests.as_ref())),
                limits: map_quantities(pod_level.and_then(|r| r.limits.as_ref())),
            },
        }
    }
}

/// Every image the template runs, app containers then init containers.
#[must_use]
pub fn template_images(template: Option<&PodTemplateSpec>) -> Vec<String> {
    let spec = template.and_then(|t| t.spec.as_ref());
    let app = spec.map(|s| s.containers.as_slice()).unwrap_or_default();
    let init = spec
        .and_then(|s| s.init_containers.as_deref())
        .unwrap_or_default();
    app.iter()
        .chain(init.iter())
        .filter_map(|c| c.image.clone())
        .collect()
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
                        last_transition_time: c.last_transition_time.as_ref().map(Moment::moment),
                        observed_generation: None,
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
            service_account_name: template.service_account_name,
            pod_resources: template.pod_resources,
            labels: deployment.labels().clone(),
            annotations: deployment.annotations().clone(),
            template_annotations: spec
                .and_then(|s| s.template.metadata.as_ref())
                .and_then(|m| m.annotations.clone())
                .unwrap_or_default(),
            generation: deployment.metadata.generation,
            observed_generation: status.and_then(|s| s.observed_generation),
            created_at: deployment.creation_timestamp().map(|t| t.moment()),
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

    /// KEP-2837: pod-level resources on the template are the replica's own —
    /// carried here next to the service account, not folded into a container,
    /// so the workload's Usage ceiling can match its pods' instead of saying
    /// "no limits" over pods that each show one.
    #[test]
    fn a_templates_pod_level_resources_are_carried() {
        use k8s_openapi::api::core::v1::ResourceRequirements;
        let spec = PodSpec {
            containers: vec![container("app", None)],
            resources: Some(ResourceRequirements {
                limits: Some([("cpu".to_string(), Quantity("2".to_string()))].into()),
                ..Default::default()
            }),
            ..Default::default()
        };
        let template = TemplateContainers::of(Some(&spec));
        assert_eq!(
            template.pod_resources.limits.get("cpu").map(String::as_str),
            Some("2"),
            "the pod-level limit must reach the workload info"
        );
        // The app container declared none of its own — the ceiling is the
        // pod-level block's, not a container sum.
        assert!(template.containers[0].resources.limits.is_empty());
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
