//! The status `kubectl get pod` prints, and the restart tally beside it.
//!
//! `.status.phase` is not that status. A pod whose only container has
//! crashed 653 times still reports `Running` — the pod is scheduled and
//! started, which is all the phase ever claimed. kubectl derives the
//! answer people actually mean from the container states, and this is
//! that derivation, ported from `printPod` in
//! `pkg/printers/internalversion/printers.go`.
//!
//! It lives in Rust rather than beside `statusRole` in TypeScript because
//! it reads fields the frontend is not sent and has no reason to be: init
//! container statuses, the sidecar restart policy of each init container,
//! termination signals, and `metadata.deletionTimestamp`. Deriving it here
//! ships one string instead of the four collections needed to recompute
//! it, and the watch stream — which builds `PodInfo` through the same
//! `From` impl — gets it for free.

use crate::utils::Moment;
use chrono::{DateTime, Utc};
use k8s_openapi::api::core::v1::{
    Container, ContainerStateTerminated, ContainerStatus, Pod, PodStatus,
};

/// The kubelet's placeholder while it sets a pod up; kubectl skips it in
/// favour of the `Init:i/n` progress counter.
const POD_INITIALIZING: &str = "PodInitializing";
const SCHEDULING_GATED: &str = "SchedulingGated";
/// `node.NodeUnreachablePodReason` — a pod on a node that stopped answering.
const NODE_UNREACHABLE: &str = "NodeLost";

/// A container's restart policy value that makes an init container a sidecar.
const ALWAYS: &str = "Always";

fn terminated_reason(t: &ContainerStateTerminated) -> String {
    match t.reason.as_deref().filter(|r| !r.is_empty()) {
        Some(reason) => reason.to_string(),
        None => match t.signal.unwrap_or(0) {
            0 => format!("ExitCode:{}", t.exit_code),
            signal => format!("Signal:{signal}"),
        },
    }
}

fn is_terminal(phase: &str) -> bool {
    phase == "Succeeded" || phase == "Failed"
}

fn restarts_always(pod: &Pod) -> bool {
    pod.spec
        .as_ref()
        .and_then(|s| s.restart_policy.as_deref())
        .is_none_or(|policy| policy == ALWAYS)
}

/// Whether a pod condition is asserted true.
///
/// `Ready` is the one that decides whether a Service puts the pod in its
/// endpoints, which makes it the last hop of every traffic path.
#[must_use]
pub fn condition_is_true(status: Option<&PodStatus>, type_: &str) -> bool {
    status.and_then(|s| s.conditions.as_ref()).is_some_and(|c| {
        c.iter()
            .any(|cond| cond.type_ == type_ && cond.status == "True")
    })
}

fn last_terminated(cs: &ContainerStatus) -> Option<&ContainerStateTerminated> {
    cs.last_state.as_ref()?.terminated.as_ref()
}

/// Init containers that keep running alongside the app containers.
///
/// The one place that judgement is made. `ContainerInfo` ships it to
/// the frontend as a phase so nothing downstream has to know that a
/// sidecar is spelled `restartPolicy: Always` on an init container.
#[must_use]
pub fn is_sidecar(container: &Container) -> bool {
    container.restart_policy.as_deref() == Some(ALWAYS)
}

fn sidecar_at(pod: &Pod, index: usize) -> bool {
    pod.spec
        .as_ref()
        .and_then(|s| s.init_containers.as_ref())
        .and_then(|c| c.get(index))
        .is_some_and(is_sidecar)
}

/// The first init container that has not finished, if there is one. It
/// decides the whole pod's status, which is why the search stops at it.
fn blocking_init(pod: &Pod) -> Option<(usize, &ContainerStatus)> {
    pod.status
        .as_ref()
        .and_then(|s| s.init_container_statuses.as_ref())?
        .iter()
        .enumerate()
        .find(|(index, cs)| {
            let done = cs
                .state
                .as_ref()
                .and_then(|s| s.terminated.as_ref())
                .is_some_and(|t| t.exit_code == 0);
            let up = sidecar_at(pod, *index) && cs.started.unwrap_or(false);
            !done && !up
        })
}

/// The status kubectl would print for this pod.
#[must_use]
pub fn display_status(pod: &Pod) -> String {
    let status = pod.status.as_ref();
    let phase = status
        .and_then(|s| s.phase.clone())
        .unwrap_or_else(|| "Unknown".to_string());

    let mut reason = status
        .and_then(|s| s.reason.clone())
        .filter(|r| !r.is_empty())
        .unwrap_or_else(|| phase.clone());

    if let Some(conditions) = status.and_then(|s| s.conditions.as_ref()) {
        if conditions
            .iter()
            .any(|c| c.type_ == "PodScheduled" && c.reason.as_deref() == Some(SCHEDULING_GATED))
        {
            reason = SCHEDULING_GATED.to_string();
        }
    }

    let init_total = pod
        .spec
        .as_ref()
        .and_then(|s| s.init_containers.as_ref())
        .map_or(0, std::vec::Vec::len);

    let blocking = blocking_init(pod);
    if let Some((index, cs)) = blocking {
        reason = if let Some(t) = cs.state.as_ref().and_then(|s| s.terminated.as_ref()) {
            format!("Init:{}", terminated_reason(t))
        } else {
            let waiting = cs
                .state
                .as_ref()
                .and_then(|s| s.waiting.as_ref())
                .and_then(|w| w.reason.as_deref())
                .filter(|r| !r.is_empty() && *r != POD_INITIALIZING);
            match waiting {
                Some(r) => format!("Init:{r}"),
                None => format!("Init:{index}/{init_total}"),
            }
        };
    }

    if blocking.is_none() || condition_is_true(status, "Initialized") {
        let mut has_running = false;
        if let Some(statuses) = status.and_then(|s| s.container_statuses.as_ref()) {
            // Backwards, so the first container's verdict is the one left
            // standing — kubectl overwrites `reason` as it walks.
            for cs in statuses.iter().rev() {
                let waiting = cs
                    .state
                    .as_ref()
                    .and_then(|s| s.waiting.as_ref())
                    .and_then(|w| w.reason.as_deref())
                    .filter(|r| !r.is_empty());
                let terminated = cs.state.as_ref().and_then(|s| s.terminated.as_ref());
                let running = cs.state.as_ref().and_then(|s| s.running.as_ref());

                if let Some(r) = waiting {
                    reason = r.to_string();
                } else if let Some(t) = terminated {
                    reason = terminated_reason(t);
                } else if cs.ready && running.is_some() {
                    has_running = true;
                }
            }
        }

        // A job pod whose sidecar is still up is not finished.
        if reason == "Completed" && has_running {
            reason = if condition_is_true(status, "Ready") {
                "Running".to_string()
            } else {
                "NotReady".to_string()
            };
        }
    }

    if pod.metadata.deletion_timestamp.is_some() {
        if status.and_then(|s| s.reason.as_deref()) == Some(NODE_UNREACHABLE) {
            return "Unknown".to_string();
        }
        // kubectl prints `Completed` once the kubelet marks a deleted pod
        // Succeeded, which reads as a finished run for a Deployment's pod.
        // One that restarts its containers is terminal only on its way out.
        if !is_terminal(&phase) || restarts_always(pod) {
            return "Terminating".to_string();
        }
    }

    reason
}

/// How long after a container's last exit its pod still counts as
/// crash-looping. The kubelet's back-off tops out at five minutes and resets
/// only once a container has run for ten, so a loop comes round inside this.
pub const CRASH_LOOP_WINDOW_SECONDS: i64 = 15 * 60;

/// Whether this pod is crash-looping, read the same in every phase of the
/// kubelet's back-off cycle.
///
/// kubectl's status is one instant of the cycle: `CrashLoopBackOff` while the
/// kubelet waits, `Error` or `OOMKilled` the moment the container dies, and
/// `Running` for the seconds it is up. Counted by that word, the same pod is
/// healthy on one read and crash-looping on the next. A container waiting in
/// `CrashLoopBackOff`, or one that has restarted twice or more and last exited
/// inside the back-off window, is crash-looping whichever instant this is.
#[must_use]
pub fn crash_looping(pod: &Pod, now: DateTime<Utc>) -> bool {
    let Some(status) = running_status(pod) else {
        return false;
    };
    let waiting = status.container_statuses.iter().flatten().any(|cs| {
        cs.state
            .as_ref()
            .and_then(|s| s.waiting.as_ref())
            .and_then(|w| w.reason.as_deref())
            == Some("CrashLoopBackOff")
    });
    waiting
        || looping_exit(pod)
            .is_some_and(|at| now - at < chrono::Duration::seconds(CRASH_LOOP_WINDOW_SECONDS))
}

/// When the latest exit of a container that has restarted twice or more
/// ended, on a running pod: what [`crash_looping`] measures its window from,
/// shipped so a reader with its own clock measures the same window.
#[must_use]
pub fn looping_exit(pod: &Pod) -> Option<DateTime<Utc>> {
    running_status(pod)?
        .container_statuses
        .iter()
        .flatten()
        .filter(|cs| cs.restart_count >= 2)
        .filter_map(|cs| {
            cs.state
                .as_ref()
                .and_then(|s| s.terminated.as_ref())
                .or_else(|| last_terminated(cs))?
                .finished_at
                .as_ref()
                .map(Moment::moment)
        })
        .max()
}

/// Whether a running pod has a container that restarted while neither its
/// state nor its `lastState` says how a run ended: the kubelet does not
/// always report the last exit, and fifteen restarts with none reported are
/// a question it left open, not a sign of health.
#[must_use]
pub fn exit_unreported(pod: &Pod) -> bool {
    running_status(pod).is_some_and(|status| {
        status.container_statuses.iter().flatten().any(|cs| {
            cs.restart_count > 0
                && cs
                    .state
                    .as_ref()
                    .and_then(|s| s.terminated.as_ref())
                    .is_none()
                && last_terminated(cs).is_none()
        })
    })
}

fn running_status(pod: &Pod) -> Option<&k8s_openapi::api::core::v1::PodStatus> {
    let status = pod.status.as_ref()?;
    (status.phase.as_deref() == Some("Running") && pod.metadata.deletion_timestamp.is_none())
        .then_some(status)
}

/// Longest a pod may sit Pending before it counts as a problem. Scheduling
/// and image pulls take seconds; without this grace every `CronJob` tick
/// paints the panel red and the signal is gone.
pub const PENDING_GRACE_SECONDS: i64 = 60;

/// How long a pod may stay not ready with no fault showing before the wait is
/// its fault: the progress deadline a Deployment gets when it names none.
pub const START_GRACE_SECONDS: i64 = 600;

/// How long a Pending pod may wait before the wait is a problem. One the
/// scheduler has placed is pulling images or running init containers, which
/// a fresh cluster takes minutes over, and a fault there shows as a stuck
/// reason or a restart long before this runs out.
#[must_use]
pub fn pending_grace(pod: &Pod) -> i64 {
    if condition_is_true(pod.status.as_ref(), "PodScheduled") {
        START_GRACE_SECONDS
    } else {
        PENDING_GRACE_SECONDS
    }
}

/// Whether a Pending pod is still inside the wait [`pending_grace`] gives it.
/// An undated pod is not: an unknown age is not evidence that it is young.
#[must_use]
pub fn within_pending_grace(pod: &Pod, now: DateTime<Utc>) -> bool {
    pending_since(pod).is_some_and(|t| now - t < chrono::Duration::seconds(pending_grace(pod)))
}

/// Waiting-state reasons that mean the pod is stuck, not starting up.
pub const STUCK_WAITING_REASONS: &[&str] = &[
    "CrashLoopBackOff",
    "ImagePullBackOff",
    "ErrImagePull",
    "CreateContainerConfigError",
    "CreateContainerError",
    "InvalidImageName",
];

/// Reason and message of the first container stuck in a back-off / image-pull
/// loop rather than starting up. The single most common real incident, and the
/// reason string the API gives for it is already precise.
#[must_use]
pub fn stuck_reason(pod: &Pod) -> Option<(String, Option<String>)> {
    pod.status
        .as_ref()?
        .container_statuses
        .as_ref()?
        .iter()
        .find_map(|c| {
            let waiting = c.state.as_ref()?.waiting.as_ref()?;
            let reason = waiting.reason.as_deref()?;
            STUCK_WAITING_REASONS
                .contains(&reason)
                .then(|| (reason.to_string(), waiting.message.clone()))
        })
}

/// When a Pending pod started waiting: its last scheduling decision, or its
/// creation where there was none yet.
#[must_use]
pub fn pending_since(pod: &Pod) -> Option<DateTime<Utc>> {
    pod.status
        .as_ref()
        .and_then(|s| s.conditions.as_ref())
        .and_then(|cs| cs.iter().find(|c| c.type_ == "PodScheduled"))
        .and_then(|c| c.last_transition_time.as_ref())
        .or(pod.metadata.creation_timestamp.as_ref())
        .map(Moment::moment)
}

/// Restarts as kubectl counts them, and when the last one happened.
///
/// Not a plain sum over `containerStatuses`: a sidecar's restarts count
/// too, and while a pod is still initializing the number that matters is
/// the init containers' own.
#[must_use]
pub fn restarts(pod: &Pod) -> (i32, Option<DateTime<Utc>>) {
    fn note(slot: &mut Option<DateTime<Utc>>, cs: &ContainerStatus) {
        if let Some(at) = last_terminated(cs).and_then(|t| t.finished_at.as_ref()) {
            if slot.is_none_or(|current| current < at.moment()) {
                *slot = Some(at.moment());
            }
        }
    }

    let status = pod.status.as_ref();
    let mut total = 0;
    let mut sidecar_total = 0;
    let mut last: Option<DateTime<Utc>> = None;
    let mut sidecar_last: Option<DateTime<Utc>> = None;

    if let Some(statuses) = status.and_then(|s| s.init_container_statuses.as_ref()) {
        for (index, cs) in statuses.iter().enumerate() {
            total += cs.restart_count;
            note(&mut last, cs);
            if sidecar_at(pod, index) {
                sidecar_total += cs.restart_count;
                note(&mut sidecar_last, cs);
            }
        }
    }

    if blocking_init(pod).is_some() && !condition_is_true(status, "Initialized") {
        return (total, last);
    }

    total = sidecar_total;
    last = sidecar_last;
    if let Some(statuses) = status.and_then(|s| s.container_statuses.as_ref()) {
        for cs in statuses {
            total += cs.restart_count;
            note(&mut last, cs);
        }
    }

    (total, last)
}

#[cfg(test)]
mod tests {
    use super::*;

    use k8s_openapi::api::core::v1::{
        Container, ContainerState, ContainerStateRunning, ContainerStateTerminated,
        ContainerStateWaiting, PodCondition, PodSpec,
    };
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::Time;

    fn pod(phase: &str) -> Pod {
        Pod {
            spec: Some(PodSpec::default()),
            status: Some(PodStatus {
                phase: Some(phase.to_string()),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    fn status(name: &str, state: ContainerState, ready: bool) -> ContainerStatus {
        ContainerStatus {
            name: name.to_string(),
            ready,
            state: Some(state),
            ..Default::default()
        }
    }

    fn waiting(reason: &str) -> ContainerState {
        ContainerState {
            waiting: Some(ContainerStateWaiting {
                reason: Some(reason.to_string()),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    fn terminated(exit_code: i32, reason: Option<&str>) -> ContainerState {
        ContainerState {
            terminated: Some(ContainerStateTerminated {
                exit_code,
                reason: reason.map(str::to_string),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    fn running() -> ContainerState {
        ContainerState {
            running: Some(ContainerStateRunning::default()),
            ..Default::default()
        }
    }

    fn condition(type_: &str, value: &str) -> PodCondition {
        PodCondition {
            type_: type_.to_string(),
            status: value.to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn healthy_pod_stays_running() {
        let mut p = pod("Running");
        let s = p.status.as_mut().unwrap();
        s.container_statuses = Some(vec![status("app", running(), true)]);
        s.conditions = Some(vec![condition("Ready", "True")]);
        assert_eq!(display_status(&p), "Running");
    }

    /// kubectl walks the containers and overwrites the reason as it goes,
    /// so the first container's verdict is the one that stands. Its only
    /// check was a shared corpus case deleted with the corpus; removing the
    /// `.rev()` would show the second container's reason with nothing failing.
    #[test]
    fn the_first_containers_reason_is_the_one_shown() {
        let mut p = pod("Pending");
        p.status.as_mut().unwrap().container_statuses = Some(vec![
            status("app", waiting("ImagePullBackOff"), false),
            status("sidecar", waiting("CrashLoopBackOff"), false),
        ]);
        assert_eq!(display_status(&p), "ImagePullBackOff");
    }

    #[test]
    fn crash_looping_pod_reads_crashloopbackoff_not_running() {
        let mut p = pod("Running");
        p.status.as_mut().unwrap().container_statuses =
            Some(vec![status("app", waiting("CrashLoopBackOff"), false)]);
        assert_eq!(display_status(&p), "CrashLoopBackOff");
    }

    #[test]
    fn a_terminated_container_reports_its_reason() {
        let mut p = pod("Running");
        p.status.as_mut().unwrap().container_statuses =
            Some(vec![status("app", terminated(1, Some("Error")), false)]);
        assert_eq!(display_status(&p), "Error");
    }

    #[test]
    fn a_reasonless_termination_falls_back_to_its_exit_code() {
        let mut p = pod("Running");
        p.status.as_mut().unwrap().container_statuses =
            Some(vec![status("app", terminated(3, None), false)]);
        assert_eq!(display_status(&p), "ExitCode:3");
    }

    #[test]
    fn a_signalled_termination_names_the_signal() {
        let mut p = pod("Running");
        let mut cs = status("app", terminated(0, None), false);
        cs.state
            .as_mut()
            .unwrap()
            .terminated
            .as_mut()
            .unwrap()
            .signal = Some(9);
        p.status.as_mut().unwrap().container_statuses = Some(vec![cs]);
        assert_eq!(display_status(&p), "Signal:9");
    }

    #[test]
    fn the_pods_own_reason_beats_the_phase() {
        let mut p = pod("Failed");
        p.status.as_mut().unwrap().reason = Some("Evicted".to_string());
        assert_eq!(display_status(&p), "Evicted");
    }

    #[test]
    fn a_pending_pod_with_no_containers_yet_stays_pending() {
        assert_eq!(display_status(&pod("Pending")), "Pending");
    }

    #[test]
    fn a_deleted_pod_reads_terminating() {
        let mut p = pod("Running");
        p.metadata.deletion_timestamp = Some(Time(
            crate::utils::moment::as_cluster_time(Utc::now())
                .expect("an instant this test wrote itself"),
        ));
        p.status.as_mut().unwrap().container_statuses = Some(vec![status("app", running(), true)]);
        assert_eq!(display_status(&p), "Terminating");
    }

    /// Dana deleted `shop/cart-9df89489c-nrql9` and its peek said `Completed`
    /// for three seconds before it was gone: nginx exits 0 on SIGTERM and the
    /// kubelet marks the deleted pod Succeeded. Fails if a Deployment's pod
    /// on its way out reads as a finished run on the list, page or peek.
    #[test]
    fn a_deployment_pod_deleted_and_stopped_reads_terminating_not_completed() {
        let deleted: Pod = serde_json::from_value(serde_json::json!({
            "metadata": {
                "name": "cart-9df89489c-nrql9",
                "namespace": "shop",
                "deletionTimestamp": "2026-10-06T21:37:28Z",
                "deletionGracePeriodSeconds": 30,
                "ownerReferences": [{
                    "apiVersion": "apps/v1",
                    "kind": "ReplicaSet",
                    "name": "cart-9df89489c",
                    "uid": "5b0e7c1a-3f43-4d0b-9f0e-2a1c9f6d7e10",
                    "controller": true,
                }],
            },
            "spec": {
                "nodeName": "node01",
                "restartPolicy": "Always",
                "containers": [{ "name": "cart", "image": "nginx:1.27-alpine" }],
            },
            "status": {
                "phase": "Succeeded",
                "conditions": [
                    { "type": "Ready", "status": "False", "reason": "PodCompleted" },
                    { "type": "ContainersReady", "status": "False", "reason": "PodCompleted" },
                ],
                "containerStatuses": [{
                    "name": "cart",
                    "ready": false,
                    "started": false,
                    "restartCount": 0,
                    "image": "docker.io/library/nginx:1.27-alpine",
                    "imageID": "",
                    "state": { "terminated": {
                        "exitCode": 0,
                        "reason": "Completed",
                        "startedAt": "2026-10-06T21:20:13Z",
                        "finishedAt": "2026-10-06T21:37:28Z",
                    } },
                }],
            },
        }))
        .expect("a pod the kubelet wrote");

        assert_eq!(display_status(&deleted), "Terminating");
        assert_eq!(
            super::super::PodRow::from(&deleted).status.display,
            super::super::PodInfo::from(&deleted).status.display
        );
    }

    #[test]
    fn a_deleted_pod_on_a_lost_node_reads_unknown() {
        let mut p = pod("Running");
        p.metadata.deletion_timestamp = Some(Time(
            crate::utils::moment::as_cluster_time(Utc::now())
                .expect("an instant this test wrote itself"),
        ));
        p.status.as_mut().unwrap().reason = Some(NODE_UNREACHABLE.to_string());
        assert_eq!(display_status(&p), "Unknown");
    }

    #[test]
    fn a_finished_pod_keeps_its_completion_through_deletion() {
        let mut p = pod("Succeeded");
        p.spec.as_mut().unwrap().restart_policy = Some("Never".to_string());
        p.metadata.deletion_timestamp = Some(Time(
            crate::utils::moment::as_cluster_time(Utc::now())
                .expect("an instant this test wrote itself"),
        ));
        p.status.as_mut().unwrap().container_statuses =
            Some(vec![status("app", terminated(0, Some("Completed")), false)]);
        assert_eq!(display_status(&p), "Completed");
    }

    #[test]
    fn an_init_container_failure_is_prefixed() {
        let mut p = pod("Pending");
        p.spec.as_mut().unwrap().init_containers = Some(vec![Container::default()]);
        p.status.as_mut().unwrap().init_container_statuses =
            Some(vec![status("setup", terminated(1, Some("Error")), false)]);
        assert_eq!(display_status(&p), "Init:Error");
    }

    #[test]
    fn an_init_container_still_working_reports_progress() {
        let mut p = pod("Pending");
        p.spec.as_mut().unwrap().init_containers =
            Some(vec![Container::default(), Container::default()]);
        p.status.as_mut().unwrap().init_container_statuses = Some(vec![
            status("first", terminated(0, Some("Completed")), false),
            status("second", waiting(POD_INITIALIZING), false),
        ]);
        assert_eq!(display_status(&p), "Init:1/2");
    }

    #[test]
    fn a_started_sidecar_does_not_hold_the_pod_in_init() {
        let mut p = pod("Running");
        p.spec.as_mut().unwrap().init_containers = Some(vec![Container {
            restart_policy: Some(ALWAYS.to_string()),
            ..Default::default()
        }]);
        let mut sidecar = status("proxy", running(), true);
        sidecar.started = Some(true);
        let s = p.status.as_mut().unwrap();
        s.init_container_statuses = Some(vec![sidecar]);
        s.container_statuses = Some(vec![status("app", running(), true)]);
        s.conditions = Some(vec![condition("Ready", "True")]);
        assert_eq!(display_status(&p), "Running");
    }

    #[test]
    fn a_completed_container_beside_a_running_one_is_not_completed() {
        let mut p = pod("Running");
        let s = p.status.as_mut().unwrap();
        s.container_statuses = Some(vec![
            status("app", terminated(0, Some("Completed")), false),
            status("sidecar", running(), true),
        ]);
        s.conditions = Some(vec![condition("Ready", "True")]);
        assert_eq!(display_status(&p), "Running");
    }

    #[test]
    fn restarts_sum_app_containers_and_carry_the_last_time() {
        let mut p = pod("Running");
        let mut cs = status("app", waiting("CrashLoopBackOff"), false);
        cs.restart_count = 653;
        let when = Utc::now();
        cs.last_state = Some(ContainerState {
            terminated: Some(ContainerStateTerminated {
                exit_code: 1,
                reason: Some("Error".to_string()),
                finished_at: Some(Time(
                    crate::utils::moment::as_cluster_time(when)
                        .expect("an instant this test wrote itself"),
                )),
                ..Default::default()
            }),
            ..Default::default()
        });
        p.status.as_mut().unwrap().container_statuses = Some(vec![cs]);
        assert_eq!(restarts(&p), (653, Some(when)));
    }

    fn exited(
        now: DateTime<Utc>,
        seconds_ago: i64,
        reason: &str,
        code: i32,
    ) -> ContainerStateTerminated {
        ContainerStateTerminated {
            exit_code: code,
            reason: Some(reason.to_string()),
            finished_at: Some(Time(
                crate::utils::moment::as_cluster_time(now - chrono::Duration::seconds(seconds_ago))
                    .expect("an instant this test wrote itself"),
            )),
            ..Default::default()
        }
    }

    /// One container, 9 restarts, at one instant of its back-off cycle.
    fn looping(state: ContainerState, last_exit: ContainerStateTerminated, restarts: i32) -> Pod {
        let mut p = pod("Running");
        let mut cs = status("app", state, false);
        cs.restart_count = restarts;
        cs.last_state = Some(ContainerState {
            terminated: Some(last_exit),
            ..Default::default()
        });
        p.status.as_mut().unwrap().container_statuses = Some(vec![cs]);
        p
    }

    /// Dana's checkout pods read "Running" on the Overview whenever the read
    /// caught them between crashes, and `CrashLoopBackOff` a minute later.
    /// Fails if any instant of the cycle reads as not crash-looping.
    #[test]
    fn a_crash_loop_is_one_answer_at_every_instant_of_its_back_off() {
        let now = Utc::now();
        let waiting_phase = looping(waiting("CrashLoopBackOff"), exited(now, 40, "Error", 1), 9);
        let died_now = {
            let mut p = looping(running(), exited(now, 200, "Error", 1), 9);
            p.status
                .as_mut()
                .unwrap()
                .container_statuses
                .as_mut()
                .unwrap()[0]
                .state = Some(ContainerState {
                terminated: Some(exited(now, 1, "OOMKilled", 137)),
                ..Default::default()
            });
            p
        };
        let up_for_seconds = looping(running(), exited(now, 20, "Error", 1), 9);
        for (instant, p) in [
            ("waiting", &waiting_phase),
            ("terminated", &died_now),
            ("running", &up_for_seconds),
        ] {
            assert!(
                crash_looping(p, now),
                "the {instant} instant read as not crash-looping"
            );
        }
        assert_eq!(display_status(&up_for_seconds), "Running");
    }

    /// Sam's checkout pod read green Running in its header between crashes
    /// while the Overview said `CrashLoopBackOff`. The page, the list and
    /// Connections measure the window from what the row and the fact ship;
    /// fails if the running instant ships no exit to any of them, or a pod
    /// restarted once ships one.
    #[test]
    fn a_running_crash_looper_ships_the_exit_its_window_is_measured_from() {
        let now = Utc::now();
        let up = looping(running(), exited(now, 20, "Error", 1), 9);
        let at = looping_exit(&up).expect("the last exit is shipped");
        assert_eq!(
            at.timestamp(),
            (now - chrono::Duration::seconds(20)).timestamp()
        );
        assert_eq!(
            crate::resources::PodRow::from(&up).status.looping_exit_at,
            Some(at)
        );
        assert!(matches!(
            crate::resources::published::pod_ref(&up, "shop").facts,
            Some(crate::resources::ObjectFacts::Pod { looping_exit_at: Some(fact), .. }) if fact == at
        ));
        let rebooted = looping(running(), exited(now, 30, "Unknown", 255), 1);
        assert_eq!(looping_exit(&rebooted), None);
    }

    /// The frontend measures the same window from the same file; fails if one
    /// side's number moves alone.
    #[test]
    fn the_crash_loop_window_matches_the_shared_file() {
        const FILE: &str = include_str!("../../../../contracts/crash-loop.json");
        let file: serde_json::Value = serde_json::from_str(FILE).expect("json");
        assert_eq!(file["windowSeconds"], CRASH_LOOP_WINDOW_SECONDS);
    }

    /// Sam's checkout pod read green Running with fifteen restarts while the
    /// kubelet reported no last exit. The frontend reads the same cases off
    /// what the row ships; fails if this side calls one of them otherwise,
    /// or ships a different exit or none.
    #[test]
    fn crash_loop_cases_match_the_shared_file() {
        const FILE: &str = include_str!("../../../../contracts/crash-loop.json");
        let file: serde_json::Value = serde_json::from_str(FILE).expect("json");
        for case in file["cases"].as_array().expect("cases") {
            let name = case["name"].as_str().expect("name");
            let pod: Pod = serde_json::from_value(serde_json::json!({
                "metadata": { "name": "checkout", "namespace": "shop" },
                "spec": { "containers": [{ "name": "app" }] },
                "status": { "phase": "Running", "containerStatuses": case["containerStatuses"] }
            }))
            .expect("pod");
            let now = DateTime::parse_from_rfc3339(case["now"].as_str().expect("now"))
                .expect("now")
                .with_timezone(&Utc);
            let row = crate::resources::PodRow::from(&pod);
            assert_eq!(row.status.display, case["display"], "{name}");
            assert_eq!(
                serde_json::to_value(row.status.looping_exit_at).expect("value"),
                case["loopingExitAt"],
                "{name}"
            );
            assert_eq!(row.status.exit_unreported, case["exitUnreported"], "{name}");
            assert_eq!(crash_looping(&pod, now), case["looping"], "{name}");
        }
    }

    /// Fails if a pod that crashed long ago, or restarted once with its
    /// node, is called crash-looping now.
    #[test]
    fn a_pod_that_settled_or_restarted_once_is_not_crash_looping() {
        let now = Utc::now();
        let settled = looping(running(), exited(now, 20 * 60, "Error", 1), 9);
        let rebooted = looping(running(), exited(now, 30, "Unknown", 255), 1);
        assert!(!crash_looping(&settled, now));
        assert!(!crash_looping(&rebooted, now));
    }
}
