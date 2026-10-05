//! `Job` types: list info, detail info, the one reading of where a Job
//! stands, and the `From<&JobCondition>` impl that feeds into `ConditionInfo`.

use k8s_openapi::api::batch::v1::{Job, JobCondition};
use kube::ResourceExt;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::resources::serialization::OwnerReference;
use crate::resources::types::extract_owner_references;
use crate::resources::{
    ConditionInfo, DeploymentContainerInfo, DeploymentContainerResources, OptionTimeExt,
    ReplicaReservation, TemplateContainers,
};
use crate::utils::Moment;

/// Why the controller gave up on a Job, as its `Failed` condition says.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobFailure {
    pub reason: Option<String>,
    pub message: Option<String>,
}

/// Where a Job stands. Failed only once the controller wrote `Failed=True`:
/// a pod that died while retries are left is a retry, and the overview, the
/// list, the page and the peek all read this one answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JobState {
    Complete,
    Failed(JobFailure),
    Suspended,
    /// Pods failed and the controller is still trying.
    Retrying,
    Running,
    Pending,
}

impl JobState {
    /// The word every screen prints; `src/contracts/job-codes.json` lists them.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::Complete => "Complete",
            Self::Failed(_) => "Failed",
            Self::Suspended => "Suspended",
            Self::Retrying => "Retrying",
            Self::Running => "Running",
            Self::Pending => "Pending",
        }
    }

    #[must_use]
    pub fn failure(self) -> Option<JobFailure> {
        match self {
            Self::Failed(failure) => Some(failure),
            _ => None,
        }
    }
}

#[must_use]
pub fn job_state(job: &Job) -> JobState {
    let status = job.status.as_ref();
    let holds = |wanted: &str| {
        status
            .and_then(|s| s.conditions.as_ref())
            .and_then(|cs| cs.iter().find(|c| c.type_ == wanted && c.status == "True"))
    };
    if holds("Complete").is_some() {
        return JobState::Complete;
    }
    if let Some(failed) = holds("Failed") {
        return JobState::Failed(JobFailure {
            reason: failed.reason.clone().filter(|r| !r.is_empty()),
            message: failed.message.clone().filter(|m| !m.is_empty()),
        });
    }
    if job.spec.as_ref().and_then(|s| s.suspend).unwrap_or(false) {
        return JobState::Suspended;
    }
    if status.and_then(|s| s.failed).unwrap_or(0) > 0 {
        return JobState::Retrying;
    }
    if status.and_then(|s| s.active).unwrap_or(0) > 0 {
        return JobState::Running;
    }
    JobState::Pending
}

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
    pub failure: Option<JobFailure>,
    pub created_at: Option<String>,
}

impl From<&Job> for JobInfo {
    fn from(job: &Job) -> Self {
        let meta = &job.metadata;
        let spec = job.spec.as_ref();
        let status = job.status.as_ref();
        let state = job_state(job);

        Self {
            name: meta.name.clone().unwrap_or_default(),
            namespace: meta.namespace.clone().unwrap_or_default(),
            completions: spec.and_then(|s| s.completions),
            succeeded: status.and_then(|s| s.succeeded).unwrap_or(0),
            failed: status.and_then(|s| s.failed).unwrap_or(0),
            active: status.and_then(|s| s.active).unwrap_or(0),
            status: state.code().to_string(),
            failure: state.failure(),
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
    pub failure: Option<JobFailure>,
    pub start_time: Option<String>,
    pub completion_time: Option<String>,
    pub containers: Vec<DeploymentContainerInfo>,
    /// The template's `initContainers`, in the order the kubelet would run
    /// them, with each sidecar marked by its `phase`.
    pub init_containers: Vec<DeploymentContainerInfo>,
    /// The identity every replica will hold; see `TemplateContainers`.
    pub service_account_name: Option<String>,
    pub pod_resources: DeploymentContainerResources,
    /// One replica, as numbers; see `ReplicaReservation`.
    pub replica: ReplicaReservation,
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

        let state = job_state(job);

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
            succeeded: status.and_then(|s| s.succeeded).unwrap_or(0),
            failed: status.and_then(|s| s.failed).unwrap_or(0),
            active: status.and_then(|s| s.active).unwrap_or(0),
            status: state.code().to_string(),
            failure: state.failure(),
            start_time: status.and_then(|s| s.start_time.as_ref()).to_rfc3339_opt(),
            completion_time: status
                .and_then(|s| s.completion_time.as_ref())
                .to_rfc3339_opt(),
            containers: template.containers,
            init_containers: template.init_containers,
            service_account_name: template.service_account_name,
            pod_resources: template.pod_resources,
            replica: template.replica,
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
            last_transition_time: cond.last_transition_time.as_ref().map(Moment::moment),
            observed_generation: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::api::batch::v1::{JobSpec, JobStatus};

    fn job(failed: i32, active: i32, conditions: Vec<(&str, &str)>, suspend: bool) -> Job {
        Job {
            spec: Some(JobSpec {
                suspend: Some(suspend),
                ..JobSpec::default()
            }),
            status: Some(JobStatus {
                failed: Some(failed),
                active: Some(active),
                conditions: Some(
                    conditions
                        .into_iter()
                        .map(|(type_, reason)| JobCondition {
                            type_: type_.to_string(),
                            status: "True".to_string(),
                            reason: Some(reason.to_string()),
                            message: Some(format!("{reason} happened")),
                            ..JobCondition::default()
                        })
                        .collect(),
                ),
                ..JobStatus::default()
            }),
            ..Job::default()
        }
    }

    /// Read off the pod counts, a Job whose first pod died read Failed while
    /// its controller was still within backoffLimit, and the overview,
    /// reading the condition, did not list it.
    #[test]
    fn a_job_with_failed_pods_and_retries_left_is_retrying_not_failed() {
        assert_eq!(job_state(&job(2, 1, vec![], false)), JobState::Retrying);
        assert_eq!(job_state(&job(1, 0, vec![], false)).code(), "Retrying");
    }

    /// The controller's word ends it, with the reason it gave.
    #[test]
    fn a_job_is_failed_only_on_its_failed_condition_and_carries_the_reason() {
        let state = job_state(&job(7, 0, vec![("Failed", "BackoffLimitExceeded")], false));
        assert_eq!(state.code(), "Failed");
        assert_eq!(
            state.failure(),
            Some(JobFailure {
                reason: Some("BackoffLimitExceeded".to_string()),
                message: Some("BackoffLimitExceeded happened".to_string()),
            })
        );
    }

    #[test]
    fn a_job_reads_complete_suspended_running_and_pending_by_its_conditions_and_spec() {
        assert_eq!(
            job_state(&job(1, 0, vec![("Complete", "Completed")], false)),
            JobState::Complete
        );
        assert_eq!(job_state(&job(0, 0, vec![], true)), JobState::Suspended);
        assert_eq!(job_state(&job(0, 1, vec![], false)), JobState::Running);
        assert_eq!(job_state(&job(0, 0, vec![], false)), JobState::Pending);
    }

    /// The frontend colours and explains each word from the shared file.
    #[test]
    fn every_state_prints_a_word_the_shared_file_lists() {
        #[derive(serde::Deserialize)]
        struct Shared {
            codes: Vec<String>,
        }
        let shared: Shared =
            serde_json::from_str(include_str!("../../../../contracts/job-codes.json"))
                .expect("job codes parse");
        let every = [
            JobState::Complete,
            JobState::Failed(JobFailure {
                reason: None,
                message: None,
            }),
            JobState::Suspended,
            JobState::Retrying,
            JobState::Running,
            JobState::Pending,
        ];
        assert_eq!(
            every.iter().map(JobState::code).collect::<Vec<_>>(),
            shared.codes
        );
    }
}
