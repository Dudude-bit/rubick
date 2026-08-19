//! `StatefulSet` types: list info, detail info, replica info, and
//! the `From<&StatefulSetCondition>` impl that feeds into the shared
//! `ConditionInfo`.

use k8s_openapi::api::apps::v1::{StatefulSet, StatefulSetCondition};
use kube::ResourceExt;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::resources::serialization::OwnerReference;
use crate::resources::types::extract_owner_references;
use crate::resources::{ConditionInfo, DeploymentContainerInfo, OptionTimeExt, TemplateContainers};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatefulSetReplicaInfo {
    pub desired: i32,
    pub ready: i32,
    pub current: i32,
}

/// Basic StatefulSet info for list views
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatefulSetInfo {
    pub name: String,
    pub namespace: String,
    pub replicas: StatefulSetReplicaInfo,
    pub created_at: Option<String>,
}

impl From<&StatefulSet> for StatefulSetInfo {
    fn from(ss: &StatefulSet) -> Self {
        let meta = &ss.metadata;
        let spec = ss.spec.as_ref();
        let status = ss.status.as_ref();

        Self {
            name: meta.name.clone().unwrap_or_default(),
            namespace: meta.namespace.clone().unwrap_or_default(),
            replicas: StatefulSetReplicaInfo {
                desired: spec.and_then(|s| s.replicas).unwrap_or(0),
                ready: status.and_then(|s| s.ready_replicas).unwrap_or(0),
                current: status.and_then(|s| s.current_replicas).unwrap_or(0),
            },
            created_at: meta.creation_timestamp.as_ref().to_rfc3339_opt(),
        }
    }
}

/// Detailed StatefulSet info for detail view
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatefulSetDetailInfo {
    pub name: String,
    pub namespace: String,
    pub uid: String,
    pub replicas: StatefulSetReplicaInfo,
    pub service_name: Option<String>,
    pub pod_management_policy: Option<String>,
    pub update_strategy: Option<String>,
    pub containers: Vec<DeploymentContainerInfo>,
    /// The template's `initContainers`, in the order the kubelet would run
    /// them, with each sidecar marked by its `phase`.
    pub init_containers: Vec<DeploymentContainerInfo>,
    /// The identity every replica will hold; see `TemplateContainers`.
    pub service_account_name: Option<String>,
    pub labels: BTreeMap<String, String>,
    pub annotations: BTreeMap<String, String>,
    pub conditions: Vec<ConditionInfo>,
    pub owner_references: Vec<OwnerReference>,
    pub created_at: Option<String>,
}

impl From<&StatefulSet> for StatefulSetDetailInfo {
    fn from(ss: &StatefulSet) -> Self {
        let spec = ss.spec.as_ref();
        let status = ss.status.as_ref();

        let template = TemplateContainers::of(spec.and_then(|s| s.template.spec.as_ref()));

        let conditions = status
            .and_then(|s| s.conditions.as_ref())
            .map(|conds| conds.iter().map(ConditionInfo::from).collect())
            .unwrap_or_default();

        Self {
            name: ss.name_any(),
            namespace: ss.namespace().unwrap_or_default(),
            uid: ss.uid().unwrap_or_default(),
            replicas: StatefulSetReplicaInfo {
                desired: spec.and_then(|s| s.replicas).unwrap_or(0),
                ready: status.and_then(|s| s.ready_replicas).unwrap_or(0),
                current: status.and_then(|s| s.current_replicas).unwrap_or(0),
            },
            service_name: spec.map(|s| s.service_name.clone()),
            pod_management_policy: spec.and_then(|s| s.pod_management_policy.clone()),
            update_strategy: spec
                .and_then(|s| s.update_strategy.as_ref())
                .and_then(|s| s.type_.clone()),
            containers: template.containers,
            init_containers: template.init_containers,
            service_account_name: template.service_account_name,
            labels: ss.labels().clone(),
            annotations: ss.annotations().clone(),
            conditions,
            owner_references: extract_owner_references(ss.metadata.owner_references.as_ref()),
            created_at: ss.creation_timestamp().to_rfc3339_opt(),
        }
    }
}

impl From<&StatefulSetCondition> for ConditionInfo {
    fn from(cond: &StatefulSetCondition) -> Self {
        Self {
            type_: cond.type_.clone(),
            status: cond.status.clone(),
            reason: cond.reason.clone(),
            message: cond.message.clone(),
            last_transition_time: cond.last_transition_time.as_ref().map(|t| t.0),
            observed_generation: None,
        }
    }
}
