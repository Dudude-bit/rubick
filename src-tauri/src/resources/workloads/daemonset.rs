//! `DaemonSet` types: list info, detail info, and the
//! `From<&DaemonSetCondition>` impl that feeds into `ConditionInfo`.

use k8s_openapi::api::apps::v1::{DaemonSet, DaemonSetCondition};
use kube::ResourceExt;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::resources::serialization::OwnerReference;
use crate::resources::types::extract_owner_references;
use crate::resources::{ConditionInfo, DeploymentContainerInfo, OptionTimeExt, TemplateContainers};

/// Basic DaemonSet info for list views
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonSetInfo {
    pub name: String,
    pub namespace: String,
    pub desired: i32,
    pub current: i32,
    pub ready: i32,
    pub created_at: Option<String>,
}

impl From<&DaemonSet> for DaemonSetInfo {
    fn from(ds: &DaemonSet) -> Self {
        let meta = &ds.metadata;
        let status = ds.status.as_ref();

        Self {
            name: meta.name.clone().unwrap_or_default(),
            namespace: meta.namespace.clone().unwrap_or_default(),
            desired: status.map(|s| s.desired_number_scheduled).unwrap_or(0),
            current: status.map(|s| s.current_number_scheduled).unwrap_or(0),
            ready: status.map(|s| s.number_ready).unwrap_or(0),
            created_at: meta.creation_timestamp.as_ref().to_rfc3339_opt(),
        }
    }
}

/// Detailed DaemonSet info for detail view
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonSetDetailInfo {
    pub name: String,
    pub namespace: String,
    pub uid: String,
    pub desired: i32,
    pub current: i32,
    pub ready: i32,
    pub up_to_date: i32,
    pub available: i32,
    pub update_strategy: Option<String>,
    pub containers: Vec<DeploymentContainerInfo>,
    /// The template's `initContainers`, in the order the kubelet would run
    /// them, with each sidecar marked by its `phase`.
    pub init_containers: Vec<DeploymentContainerInfo>,
    /// The identity every replica will hold; see `TemplateContainers`.
    pub service_account_name: Option<String>,
    pub labels: BTreeMap<String, String>,
    pub annotations: BTreeMap<String, String>,
    /// `spec.selector` in the API's own text form — `app=demo`, and
    /// `tier in (web,api)` where the DaemonSet claims its pods by a set-based
    /// requirement. A map of match labels could not carry the second, and the
    /// page reading it listed no pods at all.
    pub selector: String,
    pub conditions: Vec<ConditionInfo>,
    pub owner_references: Vec<OwnerReference>,
    pub created_at: Option<String>,
}

impl From<&DaemonSet> for DaemonSetDetailInfo {
    fn from(ds: &DaemonSet) -> Self {
        let spec = ds.spec.as_ref();
        let status = ds.status.as_ref();

        let template = TemplateContainers::of(spec.and_then(|s| s.template.spec.as_ref()));

        let conditions = status
            .and_then(|s| s.conditions.as_ref())
            .map(|conds| conds.iter().map(ConditionInfo::from).collect())
            .unwrap_or_default();

        let selector = crate::resources::Selector::Query(spec.map(|s| &s.selector))
            .query_text()
            .unwrap_or_default();

        Self {
            name: ds.name_any(),
            namespace: ds.namespace().unwrap_or_default(),
            uid: ds.uid().unwrap_or_default(),
            desired: status.map(|s| s.desired_number_scheduled).unwrap_or(0),
            current: status.map(|s| s.current_number_scheduled).unwrap_or(0),
            ready: status.map(|s| s.number_ready).unwrap_or(0),
            up_to_date: status.and_then(|s| s.updated_number_scheduled).unwrap_or(0),
            available: status.and_then(|s| s.number_available).unwrap_or(0),
            update_strategy: spec
                .and_then(|s| s.update_strategy.as_ref())
                .and_then(|s| s.type_.clone()),
            containers: template.containers,
            init_containers: template.init_containers,
            service_account_name: template.service_account_name,
            labels: ds.labels().clone(),
            annotations: ds.annotations().clone(),
            selector,
            conditions,
            owner_references: extract_owner_references(ds.metadata.owner_references.as_ref()),
            created_at: ds.creation_timestamp().to_rfc3339_opt(),
        }
    }
}

impl From<&DaemonSetCondition> for ConditionInfo {
    fn from(cond: &DaemonSetCondition) -> Self {
        Self {
            type_: cond.type_.clone(),
            status: cond.status.clone(),
            reason: cond.reason.clone(),
            message: cond.message.clone(),
            last_transition_time: cond.last_transition_time.as_ref().map(|t| t.0),
        }
    }
}
