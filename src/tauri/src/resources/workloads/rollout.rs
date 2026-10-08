//! Where a workload's rollout stands, read from its conditions before its
//! counts. Every screen that draws a workload's health reads this: the list,
//! the peek, the page, the overview and the connections graph.

use chrono::{DateTime, Utc};
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, StatefulSet};
use k8s_openapi::api::core::v1::Pod;
use serde::{Deserialize, Serialize};

use super::replicaset::POD_TEMPLATE_HASH;
use crate::resources::{
    condition_is_true, pending_since, restarts, stuck_reason, PENDING_GRACE_SECONDS,
};
use crate::utils::Moment;

const DEADLINE_EXCEEDED: &str = "ProgressDeadlineExceeded";
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
    // A scale never moves the Progressing reason off NewReplicaSetAvailable,
    // so whether a short count is still coming up is for the pods to say.
    let refused = conditions
        .iter()
        .any(|c| c.type_ == "ReplicaFailure" && c.status == "True");
    let ready = status.and_then(|s| s.ready_replicas).unwrap_or(0);
    let min_ready = spec.and_then(|s| s.min_ready_seconds).unwrap_or(0);
    if (updated < desired && !refused) || settling(min_ready, ready, available, desired) {
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
    let min_ready = spec.and_then(|s| s.min_ready_seconds).unwrap_or(0);
    let settling = settling(min_ready, ready, available, desired);
    if available == 0 && !settling {
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
    if settling {
        return Rollout::ComingUp { available, desired };
    }
    if available < desired {
        return Rollout::Short { available, desired };
    }
    Rollout::Ready
}

/// Every pod wanted is ready and some are still inside `minReadySeconds`,
/// which is the controller's wait and not a fault.
fn settling(min_ready: i32, ready: i32, available: i32, desired: i32) -> bool {
    min_ready > 0 && ready >= desired && available < desired
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
    let min_ready = set
        .spec
        .as_ref()
        .and_then(|s| s.min_ready_seconds)
        .unwrap_or(0);
    let settling = settling(min_ready, status.number_ready, available, desired);
    if available == 0 && !settling {
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
    if settling {
        return Rollout::ComingUp { available, desired };
    }
    if available < desired {
        return Rollout::Short { available, desired };
    }
    Rollout::Ready
}

/// How long a running pod may stay not ready with no fault showing before the
/// wait is its fault: the progress deadline a Deployment gets when it names none.
pub const START_GRACE_SECONDS: i64 = 600;

/// Where one pod stands in coming up, for the verdict of the set that runs it.
///
/// A `StatefulSet` or `DaemonSet` writes no condition that tells a pod still
/// starting from one that never will, and its counts are the same for both:
/// read alone, they called a scale whose new pod was being created `Degraded`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum PodStart {
    /// Ready, finished, or on its way out: nothing about it is still to come.
    Settled,
    /// Not ready and showing no fault; once `until` passes, the wait is the fault.
    Starting { until: DateTime<Utc> },
    /// Not ready, and showing why it will not be: a stuck container, a
    /// restart, a failed run.
    Failing,
}

/// The pod's own answer, read without a clock so a watched row stays true:
/// the reader compares `until` with its own now.
#[must_use]
pub fn pod_start(pod: &Pod) -> PodStart {
    if pod.metadata.deletion_timestamp.is_some() {
        return PodStart::Settled;
    }
    let status = pod.status.as_ref();
    let phase = status.and_then(|s| s.phase.as_deref());
    match phase {
        Some("Succeeded") => return PodStart::Settled,
        Some("Failed") => return PodStart::Failing,
        _ => {}
    }
    if condition_is_true(status, "Ready") {
        return PodStart::Settled;
    }
    if stuck_reason(pod).is_some() || restarts(pod).0 > 0 {
        return PodStart::Failing;
    }
    // The overview calls a pod Pending past this grace a problem, so the set
    // that runs it cannot call it coming up any longer than that.
    let (since, grace) = if phase.is_none_or(|p| p == "Pending") {
        (pending_since(pod), PENDING_GRACE_SECONDS)
    } else {
        (
            pod.metadata.creation_timestamp.as_ref().map(Moment::moment),
            START_GRACE_SECONDS,
        )
    };
    since.map_or(PodStart::Failing, |at| PodStart::Starting {
        until: at + chrono::Duration::seconds(grace),
    })
}

/// A set short of available pods is coming up while some of its pods are
/// still starting and none shows a fault; otherwise it stays as it read.
///
/// `src/contracts/set-rollout-conformance.json` holds the answers, and
/// `withStarts` in `src/ui/lib/workload-status.ts` owes the same ones.
#[must_use]
pub fn with_starts<'a>(
    rollout: Rollout,
    starts: impl IntoIterator<Item = &'a PodStart>,
    now: DateTime<Utc>,
) -> Rollout {
    let Rollout::Short { available, desired } = rollout else {
        return rollout;
    };
    let mut coming = false;
    for start in starts {
        match start {
            PodStart::Settled => {}
            PodStart::Starting { until } if *until > now => coming = true,
            PodStart::Starting { .. } | PodStart::Failing => return rollout,
        }
    }
    if coming {
        Rollout::ComingUp { available, desired }
    } else {
        rollout
    }
}

/// [`with_starts`] over the pods themselves.
#[must_use]
pub fn with_pods<'a>(
    rollout: Rollout,
    pods: impl IntoIterator<Item = &'a Pod>,
    now: DateTime<Utc>,
) -> Rollout {
    let starts: Vec<PodStart> = pods.into_iter().map(pod_start).collect();
    with_starts(rollout, &starts, now)
}

/// The Deployment a pod runs for: its controller is a `ReplicaSet` the
/// Deployment named `<deployment>-<pod-template-hash>`.
#[must_use]
pub fn deployment_of(pod: &Pod) -> Option<&str> {
    let hash = pod.metadata.labels.as_ref()?.get(POD_TEMPLATE_HASH)?;
    let owner = pod
        .metadata
        .owner_references
        .iter()
        .flatten()
        .find(|o| o.controller == Some(true) && o.kind == "ReplicaSet")?;
    owner
        .name
        .strip_suffix(hash.as_str())?
        .strip_suffix('-')
        .filter(|name| !name.is_empty())
}

/// The workload whose verdict a pod's start counts toward, by kind and name.
#[must_use]
pub fn workload_of(pod: &Pod) -> Option<(&str, &str)> {
    if let Some(deployment) = deployment_of(pod) {
        return Some(("Deployment", deployment));
    }
    pod.metadata
        .owner_references
        .iter()
        .flatten()
        .find(|o| o.controller == Some(true))
        .map(|o| (o.kind.as_str(), o.name.as_str()))
}

/// Whether a pod is one of the workload's own, as its verdict counts them:
/// a Deployment's by name through its `ReplicaSets`, any other's by uid.
#[must_use]
pub fn runs_for(pod: &Pod, kind: &str, name: &str, uid: Option<&str>) -> bool {
    if kind == "Deployment" {
        return deployment_of(pod) == Some(name);
    }
    uid.is_some_and(|uid| {
        pod.metadata
            .owner_references
            .iter()
            .flatten()
            .any(|o| o.controller == Some(true) && o.uid == uid)
    })
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

    const ROLLED_OUT: &str = "NewReplicaSetAvailable";

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
    /// writes `Available=False`, and a scale leaves Progressing at
    /// `NewReplicaSetAvailable`. Fails if a scale with a pod serving reads as
    /// a fault before its pod exists, or as one while that pod is starting.
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
        let coming = Rollout::ComingUp {
            available: 1,
            desired: 2,
        };
        assert_eq!(deployment_rollout(&asked), coming);
        let starting = deployment(
            &Counts {
                desired: 2,
                existing: 2,
                updated: 2,
                available: 1,
            },
            vec![down(), rolled_out()],
        );
        assert_eq!(
            with_pods(
                deployment_rollout(&starting),
                &[serving("hello-web-0"), creating("hello-web-1")],
                Utc::now()
            ),
            coming
        );
    }

    /// Dana scaled `cart` from 3 to 4 and kubectl printed Progressing
    /// `NewReplicaSetAvailable` throughout while the header read amber
    /// "Degraded 3/4 ready" until the new pod was up: a scale never turns the
    /// reason to `ReplicaSetUpdated`. Fails if the Deployment's own pods are
    /// not what tells a pod still being created from one that will not start.
    #[test]
    fn a_deployment_scaling_up_reads_its_pods_as_a_set_does() {
        let cart = deployment(
            &Counts {
                desired: 4,
                existing: 4,
                updated: 4,
                available: 3,
            },
            vec![minimum_available(), rolled_out()],
        );
        let short = Rollout::Short {
            available: 3,
            desired: 4,
        };
        assert_eq!(deployment_rollout(&cart), short);
        let serving_three = || ["cart-a", "cart-b", "cart-c"].map(serving);
        let [a, b, c] = serving_three();
        assert_eq!(
            with_pods(
                deployment_rollout(&cart),
                &[a, b, c, creating("cart-d")],
                Utc::now()
            ),
            Rollout::ComingUp {
                available: 3,
                desired: 4
            }
        );
        let [a, b, c] = serving_three();
        assert_eq!(
            with_pods(
                deployment_rollout(&cart),
                &[a, b, c, waiting_on("cart-d", "ImagePullBackOff")],
                Utc::now()
            ),
            short
        );
    }

    /// A scale the `ReplicaSet` could not carry out (a quota, a webhook) keeps
    /// the new pods uncreated for good, and the controller says so in
    /// `ReplicaFailure`. Fails if that reads as pods still coming.
    #[test]
    fn a_scale_the_replica_set_cannot_create_is_short_not_coming_up() {
        let refused = deployment(
            &Counts {
                desired: 4,
                existing: 3,
                updated: 3,
                available: 3,
            },
            vec![
                minimum_available(),
                rolled_out(),
                condition(
                    "ReplicaFailure",
                    "True",
                    "FailedCreate",
                    "pods \"cart-9df89489c-x2x4q\" is forbidden: exceeded quota: shop-pods",
                ),
            ],
        );
        assert_eq!(
            deployment_rollout(&refused),
            Rollout::Short {
                available: 3,
                desired: 4
            }
        );
    }

    /// A Deployment's pods are owned by its `ReplicaSet`, so the Deployment is
    /// read off the `ReplicaSet`'s name. Fails if a pod of another Deployment
    /// whose name starts the same, or of a bare `ReplicaSet`, is counted.
    #[test]
    fn a_pod_runs_for_the_deployment_its_replica_set_is_named_after() {
        let owned = |owner: &str, hash: Option<&str>| -> Pod {
            let mut labels = serde_json::json!({ "app": "cart" });
            if let Some(hash) = hash {
                labels[POD_TEMPLATE_HASH] = hash.into();
            }
            pod(serde_json::json!({
                "metadata": {
                    "name": format!("{owner}-x2x4q"),
                    "labels": labels,
                    "ownerReferences": [{
                        "apiVersion": "apps/v1", "kind": "ReplicaSet",
                        "name": owner, "uid": owner, "controller": true,
                    }],
                },
            }))
        };
        let cart = owned("cart-9df89489c", Some("9df89489c"));
        assert_eq!(deployment_of(&cart), Some("cart"));
        assert_eq!(workload_of(&cart), Some(("Deployment", "cart")));
        assert!(runs_for(&cart, "Deployment", "cart", None));
        let api = owned("cart-api-5d4c8f7b9", Some("5d4c8f7b9"));
        assert!(!runs_for(&api, "Deployment", "cart", None));
        let bare = owned("cart-legacy", None);
        assert_eq!(deployment_of(&bare), None);
        assert_eq!(workload_of(&bare), Some(("ReplicaSet", "cart-legacy")));
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

    /// A set whose pods are all ready and some still inside `minReadySeconds`
    /// read Degraded, and with none available yet Unavailable, while the
    /// controller was only waiting. Fails if either comes back, or if a set
    /// with a pod not ready stops reading short.
    #[test]
    fn a_set_waiting_out_min_ready_seconds_is_coming_up() {
        let waiting = |ready: i32, available: i32| {
            let mut set = statefulset(
                3,
                StatefulSetStatus {
                    available_replicas: Some(available),
                    ..sts_status(ready, 3, "db-2", "db-2")
                },
                None,
            );
            set.spec.as_mut().unwrap().min_ready_seconds = Some(30);
            statefulset_rollout(&set)
        };
        assert_eq!(
            waiting(3, 2),
            Rollout::ComingUp {
                available: 2,
                desired: 3
            }
        );
        assert_eq!(
            waiting(3, 0),
            Rollout::ComingUp {
                available: 0,
                desired: 3
            }
        );
        assert_eq!(
            waiting(2, 2),
            Rollout::Short {
                available: 2,
                desired: 3
            }
        );

        let mut daemon = daemonset(3, 1, 3);
        daemon.spec.as_mut().unwrap().min_ready_seconds = Some(30);
        daemon.status.as_mut().unwrap().number_ready = 3;
        assert_eq!(
            daemonset_rollout(&daemon),
            Rollout::ComingUp {
                available: 1,
                desired: 3
            }
        );
        daemon.spec.as_mut().unwrap().min_ready_seconds = None;
        assert_eq!(
            daemonset_rollout(&daemon),
            Rollout::Short {
                available: 1,
                desired: 3
            }
        );
    }

    /// Both halves read a set's pods through one table; fails if this side
    /// answers any case differently from what the TypeScript list draws.
    #[test]
    fn a_set_with_its_pods_reads_as_the_shared_file_says() {
        #[derive(serde::Deserialize)]
        struct Case {
            name: String,
            rollout: Rollout,
            pods: Vec<PodStart>,
            is: Rollout,
        }
        #[derive(serde::Deserialize)]
        struct Corpus {
            now: DateTime<Utc>,
            cases: Vec<Case>,
        }
        let corpus: Corpus = serde_json::from_str(include_str!(
            "../../../../contracts/set-rollout-conformance.json"
        ))
        .expect("the corpus parses");
        for case in corpus.cases {
            assert_eq!(
                with_starts(case.rollout, &case.pods, corpus.now),
                case.is,
                "{}",
                case.name
            );
        }
    }

    fn at(seconds_ago: i64) -> String {
        (Utc::now() - chrono::Duration::seconds(seconds_ago)).to_rfc3339()
    }

    fn pod(value: serde_json::Value) -> Pod {
        serde_json::from_value(value).expect("a pod")
    }

    /// `web-1` as the kubelet writes it the second after a scale: scheduled,
    /// its container still being created.
    fn creating(name: &str) -> Pod {
        pod(serde_json::json!({
            "metadata": { "name": name, "creationTimestamp": at(5) },
            "status": {
                "phase": "Pending",
                "conditions": [
                    { "type": "PodScheduled", "status": "True", "lastTransitionTime": at(4) },
                    { "type": "Ready", "status": "False" },
                ],
                "containerStatuses": [{
                    "name": "web", "image": "web", "imageID": "", "ready": false,
                    "restartCount": 0, "state": { "waiting": { "reason": "ContainerCreating" } },
                }],
            },
        }))
    }

    fn serving(name: &str) -> Pod {
        pod(serde_json::json!({
            "metadata": { "name": name, "creationTimestamp": at(3600) },
            "status": {
                "phase": "Running",
                "conditions": [{ "type": "Ready", "status": "True" }],
            },
        }))
    }

    fn waiting_on(name: &str, reason: &str) -> Pod {
        let mut pod = creating(name);
        let status = pod.status.as_mut().expect("a status");
        status.phase = Some("Running".to_string());
        status.container_statuses.as_mut().expect("containers")[0]
            .state
            .as_mut()
            .expect("a state")
            .waiting
            .as_mut()
            .expect("waiting")
            .reason = Some(reason.to_string());
        pod
    }

    /// The pod's own answer decides the set's word, so each shape a pod is
    /// seen in during a scale has to land on the right side. Fails if a
    /// stuck, restarted or failed pod reads as still starting, or a pod
    /// being created reads as a fault.
    #[test]
    fn a_pod_being_created_is_starting_and_a_stuck_one_is_failing() {
        assert!(matches!(
            pod_start(&creating("web-1")),
            PodStart::Starting { until } if until > Utc::now()
        ));
        for reason in [
            "CrashLoopBackOff",
            "ImagePullBackOff",
            "CreateContainerConfigError",
        ] {
            assert_eq!(
                pod_start(&waiting_on("web-1", reason)),
                PodStart::Failing,
                "{reason}"
            );
        }
        let mut restarted = waiting_on("web-1", "ContainerCreating");
        restarted
            .status
            .as_mut()
            .expect("a status")
            .container_statuses
            .as_mut()
            .expect("containers")[0]
            .restart_count = 1;
        assert_eq!(pod_start(&restarted), PodStart::Failing);
        let mut failed = creating("web-1");
        failed.status.as_mut().expect("a status").phase = Some("Failed".to_string());
        assert_eq!(pod_start(&failed), PodStart::Failing);

        assert_eq!(pod_start(&serving("web-0")), PodStart::Settled);
        let mut leaving = creating("web-1");
        leaving.metadata.deletion_timestamp = leaving.metadata.creation_timestamp.clone();
        assert_eq!(pod_start(&leaving), PodStart::Settled);
    }

    /// A pod Pending past the overview's grace is already listed there as a
    /// problem; a running one that never turns ready gets the progress
    /// deadline. Fails if either waits longer than that.
    #[test]
    fn a_start_lasts_the_pending_grace_or_the_progress_deadline() {
        let mut stuck = creating("web-1");
        stuck
            .status
            .as_mut()
            .expect("a status")
            .conditions
            .as_mut()
            .expect("conditions")[0]
            .last_transition_time =
            serde_json::from_value(serde_json::json!(at(PENDING_GRACE_SECONDS + 1)))
                .expect("a time");
        assert!(matches!(pod_start(&stuck), PodStart::Starting { until } if until < Utc::now()));

        let mut unready = serving("web-1");
        unready.status.as_mut().expect("a status").conditions = None;
        unready.metadata.creation_timestamp =
            serde_json::from_value(serde_json::json!(at(START_GRACE_SECONDS - 60)))
                .expect("a time");
        assert!(matches!(pod_start(&unready), PodStart::Starting { until } if until > Utc::now()));
        unready.metadata.creation_timestamp =
            serde_json::from_value(serde_json::json!(at(START_GRACE_SECONDS + 60)))
                .expect("a time");
        assert!(matches!(pod_start(&unready), PodStart::Starting { until } if until < Utc::now()));
    }

    /// Lena's scale, on the two kinds that write no Progressing condition:
    /// one pod serving, the new one being created, and the counts alone said
    /// Degraded. Fails if the pods do not turn that into coming up, or if a
    /// new pod that will not start is let off as one that is coming.
    #[test]
    fn a_set_scaling_up_with_its_new_pod_starting_is_coming_up_and_one_with_it_stuck_is_short() {
        let set = statefulset(
            2,
            StatefulSetStatus {
                replicas: 2,
                ready_replicas: Some(1),
                available_replicas: Some(1),
                updated_replicas: Some(2),
                current_revision: Some("web-1".to_string()),
                update_revision: Some("web-1".to_string()),
                ..Default::default()
            },
            None,
        );
        let daemon = daemonset(2, 1, 2);
        let now = Utc::now();
        for short in [statefulset_rollout(&set), daemonset_rollout(&daemon)] {
            assert_eq!(
                short,
                Rollout::Short {
                    available: 1,
                    desired: 2
                }
            );
            assert_eq!(
                with_pods(short.clone(), &[serving("web-0"), creating("web-1")], now),
                Rollout::ComingUp {
                    available: 1,
                    desired: 2
                }
            );
            assert_eq!(
                with_pods(
                    short.clone(),
                    &[serving("web-0"), waiting_on("web-1", "ImagePullBackOff")],
                    now
                ),
                short
            );
        }
    }
}
