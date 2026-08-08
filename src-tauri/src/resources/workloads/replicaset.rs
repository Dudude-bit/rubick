//! `ReplicaSet` types: one revision of a Deployment, and whether it is the
//! one the Deployment is on.

use k8s_openapi::api::apps::v1::{ReplicaSet, ReplicaSetCondition};
use kube::ResourceExt;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::resources::serialization::OwnerReference;
use crate::resources::types::extract_owner_references;
use crate::resources::{ConditionInfo, DeploymentContainerInfo, OptionTimeExt, TemplateContainers};

/// What a Deployment stamps on every `ReplicaSet` it creates, and on itself
/// for the one it is currently on. Comparing the two is the whole of
/// "is this the current revision".
pub const REVISION_ANNOTATION: &str = "deployment.kubernetes.io/revision";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplicaSetReplicaInfo {
    /// `spec.replicas` — zero on every revision but the current one.
    pub desired: i32,
    /// `status.replicas`: pods that exist, which lags `desired` in both
    /// directions while a rollout moves.
    pub current: i32,
    pub ready: i32,
    pub available: i32,
}

/// One `ReplicaSet`, as its detail page asks about it.
///
/// There is deliberately no separate list shape. Nothing lists ReplicaSets
/// for their own sake — they are reached from an event, a pod's owner chain
/// or a Deployment's revisions, and all three want the same answer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplicaSetInfo {
    pub name: String,
    pub namespace: String,
    pub uid: String,
    pub replicas: ReplicaSetReplicaInfo,
    /// This `ReplicaSet`'s `deployment.kubernetes.io/revision`.
    pub revision: Option<String>,
    /// The same annotation read off the owning Deployment. Equal to
    /// `revision` on exactly one of that Deployment's ReplicaSets; `None`
    /// when no Deployment owns this one, which is the only case where
    /// "current" is a question with no answer rather than a no.
    pub current_revision: Option<String>,
    pub containers: Vec<DeploymentContainerInfo>,
    /// The template's `initContainers`, in the order the kubelet would run
    /// them, with each sidecar marked by its `phase`.
    pub init_containers: Vec<DeploymentContainerInfo>,
    pub labels: BTreeMap<String, String>,
    pub annotations: BTreeMap<String, String>,
    pub conditions: Vec<ConditionInfo>,
    pub owner_references: Vec<OwnerReference>,
    pub created_at: Option<String>,
}

impl ReplicaSetInfo {
    /// Not `From<&ReplicaSet>`: the owner's revision comes from a second
    /// object, and a conversion that silently could not see it would report
    /// every revision as not current.
    #[must_use]
    pub fn of(rs: &ReplicaSet, current_revision: Option<String>) -> Self {
        let spec = rs.spec.as_ref();
        let status = rs.status.as_ref();

        let template =
            TemplateContainers::of(spec.and_then(|s| s.template.as_ref()?.spec.as_ref()));

        let conditions = status
            .and_then(|s| s.conditions.as_ref())
            .map(|conds| conds.iter().map(ConditionInfo::from).collect())
            .unwrap_or_default();

        Self {
            name: rs.name_any(),
            namespace: rs.namespace().unwrap_or_default(),
            uid: rs.uid().unwrap_or_default(),
            replicas: ReplicaSetReplicaInfo {
                desired: spec.and_then(|s| s.replicas).unwrap_or(0),
                current: status.map(|s| s.replicas).unwrap_or(0),
                ready: status.and_then(|s| s.ready_replicas).unwrap_or(0),
                available: status.and_then(|s| s.available_replicas).unwrap_or(0),
            },
            // A hand-made ReplicaSet carries no revision, and that is not
            // an error — it is a ReplicaSet nothing is rolling out.
            revision: rs.annotations().get(REVISION_ANNOTATION).cloned(),
            current_revision,
            containers: template.containers,
            init_containers: template.init_containers,
            labels: rs.labels().clone(),
            annotations: rs.annotations().clone(),
            conditions,
            owner_references: extract_owner_references(rs.metadata.owner_references.as_ref()),
            created_at: rs.creation_timestamp().to_rfc3339_opt(),
        }
    }
}

impl From<&ReplicaSetCondition> for ConditionInfo {
    fn from(cond: &ReplicaSetCondition) -> Self {
        Self {
            type_: cond.type_.clone(),
            status: cond.status.clone(),
            reason: cond.reason.clone(),
            message: cond.message.clone(),
            last_transition_time: cond.last_transition_time.as_ref().map(|t| t.0),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::api::apps::v1::{ReplicaSetSpec, ReplicaSetStatus};
    use k8s_openapi::api::core::v1::{Container, PodSpec, PodTemplateSpec};
    use kube::core::ObjectMeta;

    fn replica_set(revision: Option<&str>, desired: i32) -> ReplicaSet {
        ReplicaSet {
            metadata: ObjectMeta {
                name: Some("meshed-demo-65d47b457f".to_string()),
                namespace: Some("k8s-gui-test".to_string()),
                annotations: revision.map(|r| {
                    [(REVISION_ANNOTATION.to_string(), r.to_string())]
                        .into_iter()
                        .collect()
                }),
                ..Default::default()
            },
            spec: Some(ReplicaSetSpec {
                replicas: Some(desired),
                template: Some(PodTemplateSpec {
                    spec: Some(PodSpec {
                        init_containers: Some(vec![Container {
                            name: "proxy".to_string(),
                            restart_policy: Some("Always".to_string()),
                            ..Default::default()
                        }]),
                        containers: vec![Container {
                            name: "app".to_string(),
                            ..Default::default()
                        }],
                        ..Default::default()
                    }),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            status: Some(ReplicaSetStatus {
                replicas: desired,
                ready_replicas: Some(desired),
                available_replicas: Some(desired),
                ..Default::default()
            }),
        }
    }

    /// The one question the page exists to answer, and it is a comparison
    /// against the owner rather than anything readable off the object.
    #[test]
    fn a_revision_is_current_when_it_matches_the_owners() {
        let info = ReplicaSetInfo::of(&replica_set(Some("3"), 1), Some("3".to_string()));
        assert_eq!(info.revision.as_deref(), Some("3"));
        assert_eq!(info.current_revision.as_deref(), Some("3"));
    }

    /// A superseded revision is the common case: a Deployment keeps its old
    /// ones around, scaled to zero.
    #[test]
    fn a_superseded_revision_keeps_its_own_number() {
        let info = ReplicaSetInfo::of(&replica_set(Some("2"), 0), Some("3".to_string()));
        assert_eq!(info.revision.as_deref(), Some("2"));
        assert_eq!(info.replicas.desired, 0);
    }

    /// A `ReplicaSet` reaches its pod template through `spec.template`,
    /// which is optional where a Deployment's is not — reading `.containers`
    /// off it would hide every sidecar the template declares.
    #[test]
    fn the_templates_init_containers_are_carried() {
        let info = ReplicaSetInfo::of(&replica_set(Some("3"), 1), None);
        assert_eq!(info.init_containers.len(), 1);
        assert_eq!(info.containers.len(), 1);
    }
}
