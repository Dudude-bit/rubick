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

fn condition_is_true(status: Option<&PodStatus>, type_: &str) -> bool {
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
        .map_or(0, |c| c.len());

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
        if !is_terminal(&phase) {
            return "Terminating".to_string();
        }
    }

    reason
}

/// Restarts as kubectl counts them, and when the last one happened.
///
/// Not a plain sum over `containerStatuses`: a sidecar's restarts count
/// too, and while a pod is still initializing the number that matters is
/// the init containers' own.
pub fn restarts(pod: &Pod) -> (i32, Option<DateTime<Utc>>) {
    fn note(slot: &mut Option<DateTime<Utc>>, cs: &ContainerStatus) {
        if let Some(at) = last_terminated(cs).and_then(|t| t.finished_at.as_ref()) {
            if slot.is_none_or(|current| current < at.0) {
                *slot = Some(at.0);
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
        p.metadata.deletion_timestamp = Some(Time(Utc::now()));
        p.status.as_mut().unwrap().container_statuses = Some(vec![status("app", running(), true)]);
        assert_eq!(display_status(&p), "Terminating");
    }

    #[test]
    fn a_deleted_pod_on_a_lost_node_reads_unknown() {
        let mut p = pod("Running");
        p.metadata.deletion_timestamp = Some(Time(Utc::now()));
        p.status.as_mut().unwrap().reason = Some(NODE_UNREACHABLE.to_string());
        assert_eq!(display_status(&p), "Unknown");
    }

    #[test]
    fn a_finished_pod_keeps_its_completion_through_deletion() {
        let mut p = pod("Succeeded");
        p.metadata.deletion_timestamp = Some(Time(Utc::now()));
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
                finished_at: Some(Time(when)),
                ..Default::default()
            }),
            ..Default::default()
        });
        p.status.as_mut().unwrap().container_statuses = Some(vec![cs]);
        assert_eq!(restarts(&p), (653, Some(when)));
    }
}
