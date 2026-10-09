//! Workload resource types — split per Kubernetes kind.
//!
//! `resources/types/deployment.rs` already covers Deployment + its
//! container shapes; this module adds `ReplicaSet` / `StatefulSet` /
//! `DaemonSet` / Job / `CronJob`.

mod cronjob;
mod daemonset;
mod job;
mod replicaset;
mod rollout;
mod rollout_plan;
mod statefulset;

pub use cronjob::{CronJobDetailInfo, CronJobInfo};
pub use daemonset::{DaemonSetDetailInfo, DaemonSetInfo};
pub use job::{job_state, JobDetailInfo, JobFailure, JobInfo, JobState};
pub use replicaset::{
    deployment_template_of, ReplicaSetInfo, ReplicaSetReplicaInfo, POD_TEMPLATE_HASH,
    REVISION_ANNOTATION,
};
pub use rollout::{
    daemonset_rollout, deployment_of, deployment_rollout, pod_start, runs_for, statefulset_rollout,
    with_pods, with_starts, workload_of, Owners, PodStart, Rollout,
};
pub use rollout_plan::{daemonset_plan, deployment_plan, statefulset_plan, RolloutPlan};
pub use statefulset::{StatefulSetDetailInfo, StatefulSetInfo, StatefulSetReplicaInfo};
