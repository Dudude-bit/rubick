//! `Job` types: list info, detail info, and the
//! `From<&JobCondition>` impl that feeds into `ConditionInfo`.
//! Includes the four-state status ladder
//! (Complete / Failed / Running / Pending).

use k8s_openapi::api::batch::v1::{Job, JobCondition};
use kube::ResourceExt;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::resources::serialization::OwnerReference;
use crate::resources::types::extract_owner_references;
use crate::resources::{ConditionInfo, DeploymentContainerInfo, OptionTimeExt, TemplateContainers};

/// Basic Job info for list views
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobInfo {
    pub name: String,
    pub namespace: String,
    pub completions: Option<i32>,
    pub succeeded: i32,
    pub failed: i32,
    pub active: i32,
    pub status: String,
    pub created_at: Option<String>,
}

impl From<&Job> for JobInfo {
    fn from(job: &Job) -> Self {
        let meta = &job.metadata;
        let spec = job.spec.as_ref();
        let status = job.status.as_ref();

        let succeeded = status.and_then(|s| s.succeeded).unwrap_or(0);
        let active = status.and_then(|s| s.active).unwrap_or(0);
        let failed = status.and_then(|s| s.failed).unwrap_or(0);

        let job_status = if succeeded > 0 && active == 0 {
            "Complete"
        } else if failed > 0 {
            "Failed"
        } else if active > 0 {
            "Running"
        } else {
            "Pending"
        };

        Self {
            name: meta.name.clone().unwrap_or_default(),
            namespace: meta.namespace.clone().unwrap_or_default(),
            completions: spec.and_then(|s| s.completions),
            succeeded,
            failed,
            active,
            status: job_status.to_string(),
            created_at: meta.creation_timestamp.as_ref().to_rfc3339_opt(),
        }
    }
}

/// Detailed Job info for detail view
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobDetailInfo {
    pub name: String,
    pub namespace: String,
    pub uid: String,
    pub completions: Option<i32>,
    pub parallelism: Option<i32>,
    pub backoff_limit: Option<i32>,
    pub active_deadline_seconds: Option<i64>,
    pub succeeded: i32,
    pub failed: i32,
    pub active: i32,
    pub status: String,
    pub start_time: Option<String>,
    pub completion_time: Option<String>,
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

impl From<&Job> for JobDetailInfo {
    fn from(job: &Job) -> Self {
        let spec = job.spec.as_ref();
        let status = job.status.as_ref();

        let succeeded = status.and_then(|s| s.succeeded).unwrap_or(0);
        let active = status.and_then(|s| s.active).unwrap_or(0);
        let failed = status.and_then(|s| s.failed).unwrap_or(0);

        let job_status = if succeeded > 0 && active == 0 {
            "Complete"
        } else if failed > 0 {
            "Failed"
        } else if active > 0 {
            "Running"
        } else {
            "Pending"
        };

        let template = TemplateContainers::of(spec.and_then(|s| s.template.spec.as_ref()));

        let conditions = status
            .and_then(|s| s.conditions.as_ref())
            .map(|conds| conds.iter().map(ConditionInfo::from).collect())
            .unwrap_or_default();

        Self {
            name: job.name_any(),
            namespace: job.namespace().unwrap_or_default(),
            uid: job.uid().unwrap_or_default(),
            completions: spec.and_then(|s| s.completions),
            parallelism: spec.and_then(|s| s.parallelism),
            backoff_limit: spec.and_then(|s| s.backoff_limit),
            active_deadline_seconds: spec.and_then(|s| s.active_deadline_seconds),
            succeeded,
            failed,
            active,
            status: job_status.to_string(),
            start_time: status.and_then(|s| s.start_time.as_ref()).to_rfc3339_opt(),
            completion_time: status
                .and_then(|s| s.completion_time.as_ref())
                .to_rfc3339_opt(),
            containers: template.containers,
            init_containers: template.init_containers,
            service_account_name: template.service_account_name,
            labels: job.labels().clone(),
            annotations: job.annotations().clone(),
            conditions,
            owner_references: extract_owner_references(job.metadata.owner_references.as_ref()),
            created_at: job.creation_timestamp().to_rfc3339_opt(),
        }
    }
}

impl From<&JobCondition> for ConditionInfo {
    fn from(cond: &JobCondition) -> Self {
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
