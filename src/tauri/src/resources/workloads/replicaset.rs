//! `ReplicaSet` types: one revision of a Deployment, and whether it is the
//! one the Deployment is on.

use k8s_openapi::api::apps::v1::{ReplicaSet, ReplicaSetCondition};
use kube::api::DynamicObject;
use kube::ResourceExt;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::resources::serialization::OwnerReference;
use crate::resources::types::extract_owner_references;
use crate::resources::{ConditionInfo, DeploymentContainerInfo, OptionTimeExt, TemplateContainers};
use crate::utils::Moment;

/// What a Deployment stamps on every `ReplicaSet` it creates, and on itself
/// for the one it is currently on. Comparing the two is the whole of
/// "is this the current revision".
pub const REVISION_ANNOTATION: &str = "deployment.kubernetes.io/revision";

/// The label the Deployment controller adds to every `ReplicaSet`'s template;
/// never part of the Deployment's own template.
pub const POD_TEMPLATE_HASH: &str = "pod-template-hash";

/// A `ReplicaSet`'s template as its Deployment would have written it, which
/// is what `kubectl rollout undo` patches back and what two revisions are
/// compared on. Taken as the cluster's own JSON: a typed copy loses every
/// field newer than the bindings.
#[must_use]
pub fn deployment_template_of(template: &serde_json::Value) -> serde_json::Value {
    let mut template = template.clone();
    if let Some(labels) = template
        .pointer_mut("/metadata/labels")
        .and_then(serde_json::Value::as_object_mut)
    {
        labels.remove(POD_TEMPLATE_HASH);
    }
    template
}

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
/// There is deliberately no separate list shape. Nothing lists `ReplicaSets`
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
    /// `revision` on exactly one of that Deployment's `ReplicaSets`; `None`
    /// when no Deployment owns this one, which is the only case where
    /// "current" is a question with no answer rather than a no.
    pub current_revision: Option<String>,
    pub containers: Vec<DeploymentContainerInfo>,
    /// The template's `initContainers`, in the order the kubelet would run
    /// them, with each sidecar marked by its `phase`.
    pub init_containers: Vec<DeploymentContainerInfo>,
    /// The identity every replica will hold; see `TemplateContainers`.
    pub service_account_name: Option<String>,
    pub labels: BTreeMap<String, String>,
    pub annotations: BTreeMap<String, String>,
    /// The pod template's own annotations, where a chart writes the config
    /// checksum it rolls on. Not the same map as `annotations`.
    pub template_annotations: BTreeMap<String, String>,
    /// The whole template, hash label removed, for comparing revisions on
    /// the fields the rows above do not carry.
    pub template: Option<serde_json::Value>,
    pub conditions: Vec<ConditionInfo>,
    /// The API server's words refusing the pods it asks for, while it
    /// refuses them.
    pub pods_refused: Option<String>,
    pub owner_references: Vec<OwnerReference>,
    pub created_at: Option<String>,
}

impl ReplicaSetInfo {
    /// Not `From<&ReplicaSet>`: the owner's revision comes from a second
    /// object, and a conversion that silently could not see it would report
    /// every revision as not current.
    ///
    /// # Errors
    ///
    /// If the object is not a `ReplicaSet` the bindings can read.
    pub fn of(raw: &DynamicObject, current_revision: Option<String>) -> serde_json::Result<Self> {
        let rs: &ReplicaSet = &serde_json::from_value(serde_json::to_value(raw)?)?;
        let spec = rs.spec.as_ref();
        let status = rs.status.as_ref();

        let template =
            TemplateContainers::of(spec.and_then(|s| s.template.as_ref()?.spec.as_ref()));

        let conditions = status
            .and_then(|s| s.conditions.as_ref())
            .map(|conds| conds.iter().map(ConditionInfo::from).collect())
            .unwrap_or_default();

        Ok(Self {
            name: rs.name_any(),
            namespace: rs.namespace().unwrap_or_default(),
            uid: rs.uid().unwrap_or_default(),
            replicas: ReplicaSetReplicaInfo {
                desired: spec.and_then(|s| s.replicas).unwrap_or(0),
                current: status.map_or(0, |s| s.replicas),
                ready: status.and_then(|s| s.ready_replicas).unwrap_or(0),
                available: status.and_then(|s| s.available_replicas).unwrap_or(0),
            },
            // A hand-made ReplicaSet carries no revision, and that is not
            // an error — it is a ReplicaSet nothing is rolling out.
            revision: rs.annotations().get(REVISION_ANNOTATION).cloned(),
            current_revision,
            containers: template.containers,
            init_containers: template.init_containers,
            service_account_name: template.service_account_name,
            labels: rs.labels().clone(),
            annotations: crate::resources::annotations_of(&rs.metadata),
            template_annotations: spec
                .and_then(|s| s.template.as_ref())
                .and_then(|t| t.metadata.as_ref())
                .and_then(|m| m.annotations.clone())
                .unwrap_or_default(),
            template: raw
                .data
                .pointer("/spec/template")
                .filter(|template| template.is_object())
                .map(deployment_template_of)
                .map(crate::resources::shown_value),
            conditions,
            pods_refused: status
                .and_then(|s| s.conditions.as_deref())
                .and_then(crate::resources::replica_failure),
            owner_references: extract_owner_references(rs.metadata.owner_references.as_ref()),
            created_at: rs.creation_timestamp().to_rfc3339_opt(),
        })
    }
}

impl From<&ReplicaSetCondition> for ConditionInfo {
    fn from(cond: &ReplicaSetCondition) -> Self {
        Self {
            type_: cond.type_.clone(),
            status: cond.status.clone(),
            reason: cond.reason.clone(),
            message: cond.message.clone(),
            last_transition_time: cond.last_transition_time.as_ref().map(Moment::moment),
            observed_generation: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::api::apps::v1::{ReplicaSetSpec, ReplicaSetStatus};
    use k8s_openapi::api::core::v1::{Container, PodSpec, PodTemplateSpec};
    use kube::core::ObjectMeta;

    /// Every `ReplicaSet` carries its own hash label, so leaving it on made
    /// two revisions differ in a field no Deployment ever wrote, and a
    /// rollback patch would pin the Deployment's pods to one hash.
    #[test]
    fn the_hash_label_is_not_part_of_the_deployments_template() {
        let template = serde_json::json!({
            "metadata": {"labels": {"app": "search", POD_TEMPLATE_HASH: "6df9f694b5"}},
        });
        assert_eq!(
            deployment_template_of(&template),
            serde_json::json!({"metadata": {"labels": {"app": "search"}}})
        );
    }

    fn raw(rs: &ReplicaSet) -> DynamicObject {
        serde_json::from_value(serde_json::to_value(rs).expect("serialises")).expect("an object")
    }

    /// The bindings are Kubernetes 1.32's. A revision's template read through
    /// them lost `hostnameOverride`, `stopSignal` and `restartPolicyRules`,
    /// so "What changes" could not show a rollback dropping them. Fails if
    /// the template the page compares is a typed copy.
    #[test]
    fn a_revisions_template_keeps_the_fields_the_bindings_do_not_know() {
        let raw: DynamicObject = serde_json::from_value(serde_json::json!({
            "apiVersion": "apps/v1", "kind": "ReplicaSet",
            "metadata": {"name": "api-7d4", "namespace": "shop"},
            "spec": {
                "selector": {"matchLabels": {"app": "api"}},
                "template": {
                    "metadata": {"labels": {"app": "api", POD_TEMPLATE_HASH: "7d4"}},
                    "spec": {
                        "hostnameOverride": "api-main",
                        "containers": [{
                            "name": "app", "image": "api:4",
                            "lifecycle": {"stopSignal": "SIGUSR1"},
                            "restartPolicyRules": [{"action": "Restart", "exitCodes": {"operator": "In", "values": [42]}}],
                        }],
                    },
                },
            },
        }))
        .expect("an object");
        let template = ReplicaSetInfo::of(&raw, None)
            .expect("a ReplicaSet")
            .template
            .expect("a template");
        assert_eq!(template["spec"]["hostnameOverride"], "api-main");
        let app = &template["spec"]["containers"][0];
        assert_eq!(app["lifecycle"]["stopSignal"], "SIGUSR1");
        assert_eq!(app["restartPolicyRules"][0]["action"], "Restart");
        assert_eq!(template["metadata"]["labels"].get(POD_TEMPLATE_HASH), None);
    }

    /// The Changes tab compares these templates leaf by leaf and draws both
    /// sides. Fails if a key written as an `env` literal is in one.
    #[test]
    fn a_revisions_template_leaves_without_a_private_key() {
        const KEY: &str = include_str!("../../../tests/fixtures/leaf.key.pem");
        let raw: DynamicObject = serde_json::from_value(serde_json::json!({
            "apiVersion": "apps/v1", "kind": "ReplicaSet",
            "metadata": {"name": "api-7d4", "namespace": "shop"},
            "spec": {
                "selector": {"matchLabels": {"app": "api"}},
                "template": {"spec": {"containers": [{
                    "name": "app", "image": "api:4",
                    "env": [{"name": "SIGNING_KEY", "value": KEY}],
                }]}},
            },
        }))
        .expect("an object");
        let template = ReplicaSetInfo::of(&raw, None)
            .expect("a ReplicaSet")
            .template
            .expect("a template");
        let app = &template["spec"]["containers"][0];
        assert_eq!(app["env"][0]["value"], crate::resources::WITHHELD_MARKER);
        assert_eq!(app["image"], "api:4");
    }

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
        let info = ReplicaSetInfo::of(&raw(&replica_set(Some("3"), 1)), Some("3".to_string()))
            .expect("a ReplicaSet");
        assert_eq!(info.revision.as_deref(), Some("3"));
        assert_eq!(info.current_revision.as_deref(), Some("3"));
    }

    /// A superseded revision is the common case: a Deployment keeps its old
    /// ones around, scaled to zero.
    #[test]
    fn a_superseded_revision_keeps_its_own_number() {
        let info = ReplicaSetInfo::of(&raw(&replica_set(Some("2"), 0)), Some("3".to_string()))
            .expect("a ReplicaSet");
        assert_eq!(info.revision.as_deref(), Some("2"));
        assert_eq!(info.replicas.desired, 0);
    }

    /// A `ReplicaSet` reaches its pod template through `spec.template`,
    /// which is optional where a Deployment's is not — reading `.containers`
    /// off it would hide every sidecar the template declares.
    #[test]
    fn the_templates_init_containers_are_carried() {
        let info =
            ReplicaSetInfo::of(&raw(&replica_set(Some("3"), 1)), None).expect("a ReplicaSet");
        assert_eq!(info.init_containers.len(), 1);
        assert_eq!(info.containers.len(), 1);
    }
}
