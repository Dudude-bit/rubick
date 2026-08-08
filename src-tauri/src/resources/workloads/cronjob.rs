//! `CronJob` types: list info and detail info. Unlike the other
//! workload kinds, `batch/v1::CronJob` has no `Conditions` array,
//! so there's no `From<&CronJobCondition>` impl here.

use k8s_openapi::api::batch::v1::CronJob;
use kube::ResourceExt;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::resources::serialization::OwnerReference;
use crate::resources::types::extract_owner_references;
use crate::resources::{DeploymentContainerInfo, OptionTimeExt, TemplateContainers};

/// Basic CronJob info for list views
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronJobInfo {
    pub name: String,
    pub namespace: String,
    pub schedule: String,
    pub suspend: bool,
    pub active: i32,
    pub last_schedule: Option<String>,
    pub created_at: Option<String>,
}

impl From<&CronJob> for CronJobInfo {
    fn from(cj: &CronJob) -> Self {
        let meta = &cj.metadata;
        let spec = cj.spec.as_ref();
        let status = cj.status.as_ref();

        Self {
            name: meta.name.clone().unwrap_or_default(),
            namespace: meta.namespace.clone().unwrap_or_default(),
            schedule: spec.map(|s| s.schedule.clone()).unwrap_or_else(String::new),
            suspend: spec.and_then(|s| s.suspend).unwrap_or(false),
            active: status
                .and_then(|s| s.active.as_ref())
                .map_or(0, |a| a.len() as i32),
            last_schedule: status
                .and_then(|s| s.last_schedule_time.as_ref())
                .to_rfc3339_opt(),
            created_at: meta.creation_timestamp.as_ref().to_rfc3339_opt(),
        }
    }
}

/// Detailed CronJob info for detail view
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronJobDetailInfo {
    pub name: String,
    pub namespace: String,
    pub uid: String,
    pub schedule: String,
    pub timezone: Option<String>,
    pub suspend: bool,
    pub concurrency_policy: Option<String>,
    pub starting_deadline_seconds: Option<i64>,
    pub successful_jobs_history_limit: Option<i32>,
    pub failed_jobs_history_limit: Option<i32>,
    pub active: i32,
    pub last_schedule: Option<String>,
    pub last_successful_time: Option<String>,
    pub containers: Vec<DeploymentContainerInfo>,
    /// The template's `initContainers`, in the order the kubelet would run
    /// them, with each sidecar marked by its `phase`.
    pub init_containers: Vec<DeploymentContainerInfo>,
    pub labels: BTreeMap<String, String>,
    pub annotations: BTreeMap<String, String>,
    pub owner_references: Vec<OwnerReference>,
    pub created_at: Option<String>,
}

impl From<&CronJob> for CronJobDetailInfo {
    fn from(cj: &CronJob) -> Self {
        let spec = cj.spec.as_ref();
        let status = cj.status.as_ref();

        let template = TemplateContainers::of(
            spec.and_then(|s| s.job_template.spec.as_ref())
                .and_then(|job_spec| job_spec.template.spec.as_ref()),
        );

        Self {
            name: cj.name_any(),
            namespace: cj.namespace().unwrap_or_default(),
            uid: cj.uid().unwrap_or_default(),
            schedule: spec.map(|s| s.schedule.clone()).unwrap_or_else(String::new),
            timezone: spec.and_then(|s| s.time_zone.clone()),
            suspend: spec.and_then(|s| s.suspend).unwrap_or(false),
            concurrency_policy: spec.and_then(|s| s.concurrency_policy.clone()),
            starting_deadline_seconds: spec.and_then(|s| s.starting_deadline_seconds),
            successful_jobs_history_limit: spec.and_then(|s| s.successful_jobs_history_limit),
            failed_jobs_history_limit: spec.and_then(|s| s.failed_jobs_history_limit),
            active: status
                .and_then(|s| s.active.as_ref())
                .map_or(0, |a| a.len() as i32),
            last_schedule: status
                .and_then(|s| s.last_schedule_time.as_ref())
                .to_rfc3339_opt(),
            last_successful_time: status
                .and_then(|s| s.last_successful_time.as_ref())
                .to_rfc3339_opt(),
            containers: template.containers,
            init_containers: template.init_containers,
            labels: cj.labels().clone(),
            annotations: cj.annotations().clone(),
            owner_references: extract_owner_references(cj.metadata.owner_references.as_ref()),
            created_at: cj.creation_timestamp().to_rfc3339_opt(),
        }
    }
}
