//! How a change to the pod template reaches the pods, resolved to numbers the
//! way each controller resolves them. A restart is such a change, so its
//! confirmation states this.

use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, StatefulSet};
use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
use serde::{Deserialize, Serialize};

const ON_DELETE: &str = "OnDelete";
const RECREATE: &str = "Recreate";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "strategy", rename_all = "camelCase")]
pub enum RolloutPlan {
    /// A Deployment's `RollingUpdate`, its fenceposts resolved against `replicas`.
    Rolling {
        replicas: i32,
        surge: i32,
        unavailable: i32,
    },
    /// Every old pod stops before any new one starts.
    Recreate { replicas: i32 },
    /// A `StatefulSet`'s `RollingUpdate`: from the highest ordinal down to
    /// `partition`, `unavailable` at a time.
    Ordered {
        replicas: i32,
        start: i32,
        partition: i32,
        unavailable: i32,
    },
    /// Nothing changes until somebody deletes a pod.
    OnDelete { replicas: i32 },
    /// A `DaemonSet`'s `RollingUpdate`, node by node.
    Nodes {
        nodes: i32,
        surge: i32,
        unavailable: i32,
    },
}

/// `GetScaledValueFromIntOrPercent`: a percentage of `total`, rounded the
/// way the caller's controller rounds it.
fn scaled(value: Option<&IntOrString>, total: i32, round_up: bool, default: i32) -> i32 {
    let percent = |text: &str| -> Option<i64> { text.strip_suffix('%')?.parse().ok() };
    match value {
        None => default,
        Some(IntOrString::Int(n)) => *n,
        Some(IntOrString::String(text)) => match percent(text) {
            Some(pct) => {
                let share = pct * i64::from(total);
                let rounded = if round_up {
                    (share + 99).div_euclid(100)
                } else {
                    share.div_euclid(100)
                };
                i32::try_from(rounded).unwrap_or(default)
            }
            None => text.parse().unwrap_or(default),
        },
    }
}

#[must_use]
pub fn deployment_plan(deployment: &Deployment) -> RolloutPlan {
    let spec = deployment.spec.as_ref();
    let replicas = spec.and_then(|s| s.replicas).unwrap_or(1);
    let strategy = spec.and_then(|s| s.strategy.as_ref());
    if strategy.and_then(|s| s.type_.as_deref()) == Some(RECREATE) {
        return RolloutPlan::Recreate { replicas };
    }
    let rolling = strategy.and_then(|s| s.rolling_update.as_ref());
    let quarter = IntOrString::String("25%".to_string());
    // `ResolveFenceposts`: surge rounds up, unavailability rounds down.
    let surge = scaled(
        Some(
            rolling
                .and_then(|r| r.max_surge.as_ref())
                .unwrap_or(&quarter),
        ),
        replicas,
        true,
        0,
    );
    let mut unavailable = scaled(
        Some(
            rolling
                .and_then(|r| r.max_unavailable.as_ref())
                .unwrap_or(&quarter),
        ),
        replicas,
        false,
        0,
    );
    // Both rounding to zero would stall; the controller allows one instead.
    if surge == 0 && unavailable == 0 {
        unavailable = 1;
    }
    RolloutPlan::Rolling {
        replicas,
        surge,
        unavailable,
    }
}

#[must_use]
pub fn statefulset_plan(set: &StatefulSet) -> RolloutPlan {
    let spec = set.spec.as_ref();
    let replicas = spec.and_then(|s| s.replicas).unwrap_or(1);
    let strategy = spec.and_then(|s| s.update_strategy.as_ref());
    if strategy.and_then(|s| s.type_.as_deref()) == Some(ON_DELETE) {
        return RolloutPlan::OnDelete { replicas };
    }
    let rolling = strategy.and_then(|s| s.rolling_update.as_ref());
    let start = spec
        .and_then(|s| s.ordinals.as_ref())
        .and_then(|o| o.start)
        .unwrap_or(0);
    RolloutPlan::Ordered {
        replicas,
        start,
        partition: rolling.and_then(|r| r.partition).unwrap_or(0),
        unavailable: scaled(
            rolling.and_then(|r| r.max_unavailable.as_ref()),
            replicas,
            false,
            1,
        )
        .max(1),
    }
}

#[must_use]
pub fn daemonset_plan(set: &DaemonSet) -> RolloutPlan {
    let nodes = set
        .status
        .as_ref()
        .map_or(0, |s| s.desired_number_scheduled);
    let strategy = set.spec.as_ref().and_then(|s| s.update_strategy.as_ref());
    if strategy.and_then(|s| s.type_.as_deref()) == Some(ON_DELETE) {
        return RolloutPlan::OnDelete { replicas: nodes };
    }
    let rolling = strategy.and_then(|s| s.rolling_update.as_ref());
    // The DaemonSet controller rounds both up.
    let surge = scaled(rolling.and_then(|r| r.max_surge.as_ref()), nodes, true, 0);
    let mut unavailable = scaled(
        rolling.and_then(|r| r.max_unavailable.as_ref()),
        nodes,
        true,
        1,
    );
    if nodes > 0 && surge == 0 && unavailable == 0 {
        unavailable = 1;
    }
    RolloutPlan::Nodes {
        nodes,
        surge,
        unavailable,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::api::apps::v1::{
        DaemonSetSpec, DaemonSetStatus, DaemonSetUpdateStrategy, DeploymentSpec,
        DeploymentStrategy, RollingUpdateDaemonSet, RollingUpdateDeployment,
        RollingUpdateStatefulSetStrategy, StatefulSetSpec, StatefulSetUpdateStrategy,
    };

    fn pct(text: &str) -> IntOrString {
        IntOrString::String(text.to_string())
    }

    fn deployment(
        replicas: i32,
        surge: Option<IntOrString>,
        unavailable: Option<IntOrString>,
    ) -> Deployment {
        Deployment {
            spec: Some(DeploymentSpec {
                replicas: Some(replicas),
                strategy: Some(DeploymentStrategy {
                    type_: Some("RollingUpdate".to_string()),
                    rolling_update: Some(RollingUpdateDeployment {
                        max_surge: surge,
                        max_unavailable: unavailable,
                    }),
                }),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    /// The defaults on `cart`'s two replicas: 25% surge rounds up to one,
    /// 25% unavailable rounds down to none.
    #[test]
    fn a_deployment_rounds_surge_up_and_unavailability_down() {
        assert_eq!(
            deployment_plan(&deployment(2, Some(pct("25%")), Some(pct("25%")))),
            RolloutPlan::Rolling {
                replicas: 2,
                surge: 1,
                unavailable: 0
            }
        );
        assert_eq!(
            deployment_plan(&deployment(10, Some(pct("25%")), Some(pct("25%")))),
            RolloutPlan::Rolling {
                replicas: 10,
                surge: 3,
                unavailable: 2
            }
        );
        assert_eq!(
            deployment_plan(&deployment(
                3,
                Some(IntOrString::Int(1)),
                Some(IntOrString::Int(0))
            )),
            RolloutPlan::Rolling {
                replicas: 3,
                surge: 1,
                unavailable: 0
            }
        );
    }

    /// Two fenceposts that both round to zero would stall a rollout forever,
    /// so the controller lets one pod go instead.
    #[test]
    fn fenceposts_that_both_round_to_zero_allow_one_unavailable() {
        assert_eq!(
            deployment_plan(&deployment(3, Some(pct("10%")), Some(pct("10%")))),
            RolloutPlan::Rolling {
                replicas: 3,
                surge: 1,
                unavailable: 0
            }
        );
        assert_eq!(
            deployment_plan(&deployment(3, Some(IntOrString::Int(0)), Some(pct("10%")))),
            RolloutPlan::Rolling {
                replicas: 3,
                surge: 0,
                unavailable: 1
            }
        );
    }

    #[test]
    fn a_recreate_deployment_stops_everything_first() {
        let mut recreate = deployment(3, None, None);
        recreate.spec.as_mut().unwrap().strategy = Some(DeploymentStrategy {
            type_: Some(RECREATE.to_string()),
            rolling_update: None,
        });
        assert_eq!(
            deployment_plan(&recreate),
            RolloutPlan::Recreate { replicas: 3 }
        );
    }

    #[test]
    fn a_statefulset_goes_one_ordinal_at_a_time_down_to_its_partition() {
        let set = |strategy: StatefulSetUpdateStrategy| StatefulSet {
            spec: Some(StatefulSetSpec {
                replicas: Some(3),
                update_strategy: Some(strategy),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert_eq!(
            statefulset_plan(&set(StatefulSetUpdateStrategy {
                type_: Some("RollingUpdate".to_string()),
                rolling_update: Some(RollingUpdateStatefulSetStrategy {
                    partition: Some(1),
                    max_unavailable: None,
                }),
            })),
            RolloutPlan::Ordered {
                replicas: 3,
                start: 0,
                partition: 1,
                unavailable: 1
            }
        );
        assert_eq!(
            statefulset_plan(&set(StatefulSetUpdateStrategy {
                type_: Some(ON_DELETE.to_string()),
                rolling_update: None,
            })),
            RolloutPlan::OnDelete { replicas: 3 }
        );
    }

    #[test]
    fn a_daemonset_rounds_its_node_fenceposts_up() {
        let set = DaemonSet {
            spec: Some(DaemonSetSpec {
                update_strategy: Some(DaemonSetUpdateStrategy {
                    type_: Some("RollingUpdate".to_string()),
                    rolling_update: Some(RollingUpdateDaemonSet {
                        max_surge: None,
                        max_unavailable: Some(pct("10%")),
                    }),
                }),
                ..Default::default()
            }),
            status: Some(DaemonSetStatus {
                desired_number_scheduled: 12,
                ..Default::default()
            }),
            ..Default::default()
        };
        assert_eq!(
            daemonset_plan(&set),
            RolloutPlan::Nodes {
                nodes: 12,
                surge: 0,
                unavailable: 2
            }
        );
    }
}
