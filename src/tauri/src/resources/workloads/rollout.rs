//! Where a workload's rollout stands, read from its conditions before its
//! counts. Every screen that draws a workload's health reads this: the list,
//! the peek, the page, the overview and the connections graph.

use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, StatefulSet};
use serde::{Deserialize, Serialize};

const DEADLINE_EXCEEDED: &str = "ProgressDeadlineExceeded";
const ROLLED_OUT: &str = "NewReplicaSetAvailable";
const ON_DELETE: &str = "OnDelete";

/// Ordered by what the reader has to act on first: a fault before an
/// intent, an intent before motion.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Rollout {
    /// Scaled to zero, or a `DaemonSet` no node is asked to run.
    Idle,
    /// `Progressing=False` with `ProgressDeadlineExceeded`, whatever is still
    /// serving: the controller stopped waiting for the new pods.
    Stalled {
        message: Option<String>,
        serving: i32,
    },
    /// Nothing available, or `Available=False` while pods of an older
    /// template are still being replaced.
    Unavailable {
        reason: Option<String>,
        message: Option<String>,
    },
    Paused,
    /// The controller has not read the newest spec, so every count below
    /// describes the one before it.
    Unobserved,
    RollingOut {
        updated: i32,
        desired: i32,
    },
    /// Every pod is on the current template and some serve, while more are
    /// still coming: a scale, a replaced pod, or a rollout's last pods.
    ComingUp {
        available: i32,
        desired: i32,
    },
    /// Rolled out, and fewer available than wanted.
    Short {
        available: i32,
        desired: i32,
    },
    Ready,
}

impl Rollout {
    /// The word every screen prints for it; `src/contracts/rollout-codes.json`
    /// holds this and the frontend's table equal.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::Idle => "Idle",
            Self::Stalled { .. } => "Stalled",
            Self::Unavailable { .. } => "Unavailable",
            Self::Paused => "Paused",
            Self::Unobserved => "Waiting",
            Self::RollingOut { .. } | Self::ComingUp { .. } => "Progressing",
            Self::Short { .. } => "Degraded",
            Self::Ready => "Ready",
        }
    }

    /// Whether the overview lists it among what needs attention.
    #[must_use]
    pub fn is_problem(&self) -> bool {
        matches!(
            self,
            Self::Stalled { .. } | Self::Unavailable { .. } | Self::Short { .. }
        )
    }
}

fn behind(generation: Option<i64>, observed: Option<i64>) -> bool {
    generation.is_some_and(|g| observed.is_none_or(|o| o < g))
}

#[must_use]
pub fn deployment_rollout(deployment: &Deployment) -> Rollout {
    let spec = deployment.spec.as_ref();
    let status = deployment.status.as_ref();
    let desired = spec.and_then(|s| s.replicas).unwrap_or(1);
    if desired <= 0 {
        return Rollout::Idle;
    }
    let observed = status.and_then(|s| s.observed_generation);
    if observed.is_none() {
        return Rollout::Unobserved;
    }
    let conditions = status
        .and_then(|s| s.conditions.as_deref())
        .unwrap_or_default();
    let progressing = conditions.iter().find(|c| c.type_ == "Progressing");
    let available = status.and_then(|s| s.available_replicas).unwrap_or(0);
    let updated = status.and_then(|s| s.updated_replicas).unwrap_or(0);
    let existing = status.and_then(|s| s.replicas).unwrap_or(0);
    let older_template = existing > updated;

    if let Some(stalled) = progressing
        .filter(|c| c.status == "False" && c.reason.as_deref() == Some(DEADLINE_EXCEEDED))
    {
        return Rollout::Stalled {
            message: stalled.message.clone(),
            serving: available,
        };
    }
    if let Some(down) = conditions
        .iter()
        .find(|c| c.type_ == "Available" && c.status == "False")
        .filter(|_| available == 0 || older_template)
    {
        return Rollout::Unavailable {
            reason: down.reason.clone(),
            message: down.message.clone(),
        };
    }
    if spec.and_then(|s| s.paused).unwrap_or(false) {
        return Rollout::Paused;
    }
    if behind(deployment.metadata.generation, observed) {
        return Rollout::Unobserved;
    }
    if older_template {
        return Rollout::RollingOut { updated, desired };
    }
    let finished = progressing.is_none_or(|c| c.reason.as_deref() == Some(ROLLED_OUT));
    if updated < desired || (available < desired && !finished) {
        return Rollout::ComingUp { available, desired };
    }
    if available < desired {
        return Rollout::Short { available, desired };
    }
    Rollout::Ready
}

#[must_use]
pub fn statefulset_rollout(set: &StatefulSet) -> Rollout {
    let spec = set.spec.as_ref();
    let status = set.status.as_ref();
    let desired = spec.and_then(|s| s.replicas).unwrap_or(1);
    if desired <= 0 {
        return Rollout::Idle;
    }
    let observed = status.and_then(|s| s.observed_generation);
    if observed.is_none() {
        return Rollout::Unobserved;
    }
    let ready = status.and_then(|s| s.ready_replicas).unwrap_or(0);
    // Clusters before 1.25 never write `availableReplicas`.
    let available = status.and_then(|s| s.available_replicas).unwrap_or(ready);
    if available == 0 {
        return Rollout::Unavailable {
            reason: None,
            message: None,
        };
    }
    if behind(set.metadata.generation, observed) {
        return Rollout::Unobserved;
    }
    let updated = status.and_then(|s| s.updated_replicas).unwrap_or(0);
    let strategy = spec.and_then(|s| s.update_strategy.as_ref());
    let on_delete = strategy.and_then(|s| s.type_.as_deref()) == Some(ON_DELETE);
    let partition = strategy
        .and_then(|s| s.rolling_update.as_ref())
        .and_then(|r| r.partition)
        .filter(|p| *p > 0);
    if !on_delete {
        if let Some(partition) = partition {
            let target = (desired - partition).max(0);
            if updated < target {
                return Rollout::RollingOut {
                    updated,
                    desired: target,
                };
            }
        } else {
            let current = status.and_then(|s| s.current_revision.as_deref());
            let update = status.and_then(|s| s.update_revision.as_deref());
            if current.is_some() && update.is_some() && current != update {
                return Rollout::RollingOut { updated, desired };
            }
        }
    }
    if available < desired {
        return Rollout::Short { available, desired };
    }
    Rollout::Ready
}

#[must_use]
pub fn daemonset_rollout(set: &DaemonSet) -> Rollout {
    let Some(status) = set.status.as_ref() else {
        return Rollout::Unobserved;
    };
    if status.observed_generation.is_none() {
        return Rollout::Unobserved;
    }
    let desired = status.desired_number_scheduled;
    if desired <= 0 {
        return Rollout::Idle;
    }
    let available = status.number_available.unwrap_or(0);
    if available == 0 {
        return Rollout::Unavailable {
            reason: None,
            message: None,
        };
    }
    if behind(set.metadata.generation, status.observed_generation) {
        return Rollout::Unobserved;
    }
    let updated = status.updated_number_scheduled.unwrap_or(0);
    let on_delete = set
        .spec
        .as_ref()
        .and_then(|s| s.update_strategy.as_ref())
        .and_then(|s| s.type_.as_deref())
        == Some(ON_DELETE);
    if !on_delete && updated < desired {
        return Rollout::RollingOut { updated, desired };
    }
    if available < desired {
        return Rollout::Short { available, desired };
    }
    Rollout::Ready
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::api::apps::v1::{
        DaemonSetSpec, DaemonSetStatus, DaemonSetUpdateStrategy, DeploymentCondition,
        DeploymentSpec, DeploymentStatus, RollingUpdateStatefulSetStrategy, StatefulSetSpec,
        StatefulSetStatus, StatefulSetUpdateStrategy,
    };
    use kube::core::ObjectMeta;

    /// The overview prints this word and lists these states, and the screens
    /// print and count the frontend's; the shared file keeps them one answer.
    #[test]
    fn every_state_prints_the_word_the_shared_file_states() {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Shared {
            codes: std::collections::BTreeMap<String, String>,
            needs_attention: Vec<String>,
        }
        let shared: Shared =
            serde_json::from_str(include_str!("../../../../contracts/rollout-codes.json"))
                .expect("rollout codes parse");
        let every = [
            Rollout::Idle,
            Rollout::Stalled {
                message: None,
                serving: 0,
            },
            Rollout::Unavailable {
                reason: None,
                message: None,
            },
            Rollout::Paused,
            Rollout::Unobserved,
            Rollout::RollingOut {
                updated: 0,
                desired: 0,
            },
            Rollout::ComingUp {
                available: 0,
                desired: 0,
            },
            Rollout::Short {
                available: 0,
                desired: 0,
            },
            Rollout::Ready,
        ];
        assert_eq!(every.len(), shared.codes.len());
        for rollout in every {
            let wire = serde_json::to_value(&rollout).expect("serialises");
            let state = wire["state"].as_str().expect("tagged by state");
            assert_eq!(
                shared.codes.get(state).map(String::as_str),
                Some(rollout.code())
            );
            assert_eq!(
                shared.needs_attention.iter().any(|s| s == state),
                rollout.is_problem(),
                "{state}"
            );
        }
    }

    fn condition(type_: &str, status: &str, reason: &str, message: &str) -> DeploymentCondition {
        DeploymentCondition {
            type_: type_.to_string(),
            status: status.to_string(),
            reason: Some(reason.to_string()),
            message: Some(message.to_string()),
            ..Default::default()
        }
    }

    struct Counts {
        desired: i32,
        existing: i32,
        updated: i32,
        available: i32,
    }

    fn deployment(counts: &Counts, conditions: Vec<DeploymentCondition>) -> Deployment {
        Deployment {
            metadata: ObjectMeta {
                generation: Some(2),
                ..Default::default()
            },
            spec: Some(DeploymentSpec {
                replicas: Some(counts.desired),
                ..Default::default()
            }),
            status: Some(DeploymentStatus {
                observed_generation: Some(2),
                replicas: Some(counts.existing),
                updated_replicas: Some(counts.updated),
                ready_replicas: Some(counts.available),
                available_replicas: Some(counts.available),
                conditions: Some(conditions),
                ..Default::default()
            }),
        }
    }

    fn settled(n: i32) -> Counts {
        Counts {
            desired: n,
            existing: n,
            updated: n,
            available: n,
        }
    }

    fn rolled_out() -> DeploymentCondition {
        condition(
            "Progressing",
            "True",
            ROLLED_OUT,
            "ReplicaSet \"cart-1\" has successfully progressed.",
        )
    }

    fn minimum_available() -> DeploymentCondition {
        condition(
            "Available",
            "True",
            "MinimumReplicasAvailable",
            "Deployment has minimum availability.",
        )
    }

    /// The `search` rollout: the new `ReplicaSet` never came up, the old pods
    /// still serve, and the counts alone add up to Ready.
    #[test]
    fn a_rollout_past_its_deadline_is_stalled_while_old_pods_still_serve() {
        let search = deployment(
            &Counts {
                desired: 2,
                existing: 3,
                updated: 1,
                available: 2,
            },
            vec![
                minimum_available(),
                condition(
                    "Progressing",
                    "False",
                    DEADLINE_EXCEEDED,
                    "ReplicaSet \"search-6df9f694b5\" has timed out progressing.",
                ),
            ],
        );
        assert_eq!(
            deployment_rollout(&search),
            Rollout::Stalled {
                message: Some(
                    "ReplicaSet \"search-6df9f694b5\" has timed out progressing.".to_string()
                ),
                serving: 2,
            }
        );
    }

    /// The `checkout` case: every pod crashing, which the counts called
    /// Progressing in calm blue.
    #[test]
    fn a_deployment_whose_available_condition_is_false_is_unavailable() {
        let checkout = deployment(
            &Counts {
                desired: 2,
                existing: 2,
                updated: 2,
                available: 0,
            },
            vec![
                condition(
                    "Available",
                    "False",
                    "MinimumReplicasUnavailable",
                    "Deployment does not have minimum availability.",
                ),
                condition("Progressing", "True", "ReplicaSetUpdated", ""),
            ],
        );
        assert!(matches!(
            deployment_rollout(&checkout),
            Rollout::Unavailable { reason: Some(r), .. } if r == "MinimumReplicasUnavailable"
        ));
    }

    /// Lena scaled `hello-web` from 1 to 2 and the header went red
    /// "Unavailable" for the seconds the second pod took, while the first
    /// served throughout: with maxUnavailable rounding to 0 the controller
    /// writes `Available=False`. Fails if a scale with a pod serving reads as
    /// a fault again, at the first write or after the pod exists.
    #[test]
    fn a_scale_up_with_a_pod_serving_is_coming_up_not_unavailable() {
        let down = || {
            condition(
                "Available",
                "False",
                "MinimumReplicasUnavailable",
                "Deployment does not have minimum availability.",
            )
        };
        let asked = deployment(
            &Counts {
                desired: 2,
                existing: 1,
                updated: 1,
                available: 1,
            },
            vec![down(), rolled_out()],
        );
        let starting = deployment(
            &Counts {
                desired: 2,
                existing: 2,
                updated: 2,
                available: 1,
            },
            vec![
                down(),
                condition(
                    "Progressing",
                    "True",
                    "ReplicaSetUpdated",
                    "ReplicaSet \"hello-web-584d68fccc\" is progressing.",
                ),
            ],
        );
        for scaling in [asked, starting] {
            assert_eq!(
                deployment_rollout(&scaling),
                Rollout::ComingUp {
                    available: 1,
                    desired: 2
                }
            );
        }
    }

    /// Pods of the old template still being replaced while the controller
    /// says too few are up is a rollout losing pods, not a scale. Fails if
    /// any pod serving is enough to drop the fault.
    #[test]
    fn too_few_up_while_an_older_template_is_replaced_stays_unavailable() {
        let replacing = deployment(
            &Counts {
                desired: 3,
                existing: 4,
                updated: 1,
                available: 1,
            },
            vec![
                condition("Available", "False", "MinimumReplicasUnavailable", ""),
                condition("Progressing", "True", "ReplicaSetUpdated", ""),
            ],
        );
        assert!(matches!(
            deployment_rollout(&replacing),
            Rollout::Unavailable { .. }
        ));
    }

    /// `payments` is both down and past its deadline; the stall is the
    /// diagnosis, because it says the controller has given up.
    #[test]
    fn a_stall_outranks_unavailability() {
        let payments = deployment(
            &Counts {
                desired: 1,
                existing: 1,
                updated: 1,
                available: 0,
            },
            vec![
                condition("Available", "False", "MinimumReplicasUnavailable", ""),
                condition("Progressing", "False", DEADLINE_EXCEEDED, ""),
            ],
        );
        assert!(matches!(
            deployment_rollout(&payments),
            Rollout::Stalled { serving: 0, .. }
        ));
    }

    #[test]
    fn a_paused_deployment_says_paused_before_it_says_rolling() {
        let mut paused = deployment(
            &Counts {
                desired: 2,
                existing: 2,
                updated: 0,
                available: 2,
            },
            vec![minimum_available()],
        );
        paused.spec.as_mut().unwrap().paused = Some(true);
        assert_eq!(deployment_rollout(&paused), Rollout::Paused);
    }

    /// Counts written for generation 1 say nothing about generation 2.
    #[test]
    fn a_spec_the_controller_has_not_read_is_unobserved() {
        let mut fresh = deployment(&settled(2), vec![minimum_available(), rolled_out()]);
        fresh.metadata.generation = Some(3);
        assert_eq!(deployment_rollout(&fresh), Rollout::Unobserved);
        fresh.status = None;
        assert_eq!(deployment_rollout(&fresh), Rollout::Unobserved);
    }

    #[test]
    fn new_pods_still_coming_or_old_ones_still_going_is_rolling_out() {
        let coming = deployment(
            &Counts {
                desired: 3,
                existing: 3,
                updated: 1,
                available: 3,
            },
            vec![minimum_available()],
        );
        assert_eq!(
            deployment_rollout(&coming),
            Rollout::RollingOut {
                updated: 1,
                desired: 3
            }
        );
        let going = deployment(
            &Counts {
                desired: 3,
                existing: 4,
                updated: 3,
                available: 3,
            },
            vec![minimum_available()],
        );
        assert!(matches!(
            deployment_rollout(&going),
            Rollout::RollingOut { .. }
        ));
    }

    /// A finished rollout that lost a pod is short, not rolling: nothing is
    /// on its way to replace it until the `ReplicaSet` notices.
    #[test]
    fn a_finished_rollout_missing_a_pod_is_short() {
        let short = deployment(
            &Counts {
                desired: 4,
                existing: 4,
                updated: 4,
                available: 3,
            },
            vec![minimum_available(), rolled_out()],
        );
        assert_eq!(
            deployment_rollout(&short),
            Rollout::Short {
                available: 3,
                desired: 4
            }
        );
    }

    #[test]
    fn ready_is_the_answer_left_when_nothing_else_is_true() {
        let cart = deployment(&settled(2), vec![minimum_available(), rolled_out()]);
        assert_eq!(deployment_rollout(&cart), Rollout::Ready);
        let idle = deployment(&settled(0), vec![]);
        assert_eq!(deployment_rollout(&idle), Rollout::Idle);
    }

    fn statefulset(
        desired: i32,
        status: StatefulSetStatus,
        strategy: Option<StatefulSetUpdateStrategy>,
    ) -> StatefulSet {
        StatefulSet {
            metadata: ObjectMeta {
                generation: Some(1),
                ..Default::default()
            },
            spec: Some(StatefulSetSpec {
                replicas: Some(desired),
                update_strategy: strategy,
                ..Default::default()
            }),
            status: Some(StatefulSetStatus {
                observed_generation: Some(1),
                ..status
            }),
        }
    }

    fn sts_status(ready: i32, updated: i32, current: &str, update: &str) -> StatefulSetStatus {
        StatefulSetStatus {
            replicas: 3,
            ready_replicas: Some(ready),
            available_replicas: Some(ready),
            updated_replicas: Some(updated),
            current_revision: Some(current.to_string()),
            update_revision: Some(update.to_string()),
            ..Default::default()
        }
    }

    #[test]
    fn a_statefulset_between_revisions_is_rolling_out_and_one_with_none_up_is_unavailable() {
        let rolling = statefulset(3, sts_status(3, 1, "db-1", "db-2"), None);
        assert_eq!(
            statefulset_rollout(&rolling),
            Rollout::RollingOut {
                updated: 1,
                desired: 3
            }
        );
        let down = statefulset(3, sts_status(0, 3, "db-2", "db-2"), None);
        assert!(matches!(
            statefulset_rollout(&down),
            Rollout::Unavailable { .. }
        ));
        let ready = statefulset(3, sts_status(3, 3, "db-2", "db-2"), None);
        assert_eq!(statefulset_rollout(&ready), Rollout::Ready);
    }

    /// A partition holds the low ordinals back on purpose, so the rollout is
    /// done once every pod above it is updated, and `OnDelete` rolls nothing.
    #[test]
    fn a_partition_and_on_delete_change_what_finished_means() {
        let partitioned = statefulset(
            3,
            sts_status(3, 2, "db-1", "db-2"),
            Some(StatefulSetUpdateStrategy {
                type_: Some("RollingUpdate".to_string()),
                rolling_update: Some(RollingUpdateStatefulSetStrategy {
                    partition: Some(1),
                    ..Default::default()
                }),
            }),
        );
        assert_eq!(statefulset_rollout(&partitioned), Rollout::Ready);
        let on_delete = statefulset(
            3,
            sts_status(3, 0, "db-1", "db-2"),
            Some(StatefulSetUpdateStrategy {
                type_: Some(ON_DELETE.to_string()),
                rolling_update: None,
            }),
        );
        assert_eq!(statefulset_rollout(&on_delete), Rollout::Ready);
    }

    fn daemonset(desired: i32, available: i32, updated: i32) -> DaemonSet {
        DaemonSet {
            metadata: ObjectMeta {
                generation: Some(1),
                ..Default::default()
            },
            spec: Some(DaemonSetSpec {
                update_strategy: Some(DaemonSetUpdateStrategy {
                    type_: Some("RollingUpdate".to_string()),
                    rolling_update: None,
                }),
                ..Default::default()
            }),
            status: Some(DaemonSetStatus {
                observed_generation: Some(1),
                desired_number_scheduled: desired,
                number_available: Some(available),
                number_unavailable: Some(desired - available),
                updated_number_scheduled: Some(updated),
                ..Default::default()
            }),
        }
    }

    #[test]
    fn a_daemonset_reads_its_node_counts_the_way_kubectl_rollout_status_does() {
        assert_eq!(
            daemonset_rollout(&daemonset(3, 3, 1)),
            Rollout::RollingOut {
                updated: 1,
                desired: 3
            }
        );
        assert_eq!(
            daemonset_rollout(&daemonset(3, 2, 3)),
            Rollout::Short {
                available: 2,
                desired: 3
            }
        );
        assert!(matches!(
            daemonset_rollout(&daemonset(3, 0, 3)),
            Rollout::Unavailable { .. }
        ));
        assert_eq!(daemonset_rollout(&daemonset(0, 0, 0)), Rollout::Idle);
        assert_eq!(daemonset_rollout(&daemonset(3, 3, 3)), Rollout::Ready);
    }
}
