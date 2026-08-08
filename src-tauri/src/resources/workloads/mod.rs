//! Workload resource types — split per Kubernetes kind.
//!
//! `resources/types/deployment.rs` already covers Deployment + its
//! container shapes; this module adds ReplicaSet / StatefulSet /
//! DaemonSet / Job / CronJob and the small `DeploymentCondition` +
//! `RolloutStatus` helpers used by
//! `commands::deployments::get_deployment_rollout`.

mod cronjob;
mod daemonset;
mod job;
mod replicaset;
mod statefulset;

pub use cronjob::{CronJobDetailInfo, CronJobInfo};
pub use daemonset::{DaemonSetDetailInfo, DaemonSetInfo};
pub use job::{JobDetailInfo, JobInfo};
pub use replicaset::{ReplicaSetInfo, ReplicaSetReplicaInfo, REVISION_ANNOTATION};
pub use statefulset::{StatefulSetDetailInfo, StatefulSetInfo, StatefulSetReplicaInfo};

use serde::{Deserialize, Serialize};

// ============================================================================
// Deployment Extras
//
// The bulk of Deployment lives in `types/deployment.rs`. These two
// types are extra status shapes used only by the `get_deployment_rollout`
// command, so they live here in `workloads` rather than mixing into
// the type-only module.
// ============================================================================

/// Deployment condition
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentCondition {
    pub condition_type: String,
    pub status: String,
    pub reason: Option<String>,
    pub message: Option<String>,
}

/// Rollout status
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RolloutStatus {
    pub replicas: i32,
    pub ready_replicas: i32,
    pub updated_replicas: i32,
    pub available_replicas: i32,
    pub conditions: Vec<DeploymentCondition>,
}
