//! Why a pod is red or amber, from the deepest evidence its own status
//! carries. The list, the page, the peek, Needs attention and Share read this
//! one answer; none of them works out its own.
//!
//! Evidence the pod does not carry, a run's log or the kubelet's events, is a
//! slot that says `notRead` until the reader that fetched it fills it in.

use chrono::{DateTime, Utc};
use k8s_openapi::api::core::v1::{ContainerStateTerminated, ContainerStatus, Pod};
use serde::{Deserialize, Serialize};

use super::pod_display::{
    blocking_init, condition_is_true, container_restarting_until, counted, last_terminated,
    pod_verdict,
};
use crate::utils::Moment;

/// The most of a termination message carried: its end is what says why.
const SAID_TAIL: usize = 1024;

/// The cause a pod's surfaces lead with, one variant per mechanism.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "says", rename_all = "camelCase")]
pub enum PodCause {
    /// A container's runs end, and how the last one did.
    Exits {
        container: String,
        restarts: i32,
        /// `None` where the kubelet restarted it and reported no exit.
        run: Option<EndedRun>,
        /// For a container up again since, when that exit stops being news;
        /// `None` while it is down. The reader compares it with its own clock.
        until: Option<DateTime<Utc>>,
    },
}

/// One ended run of a container, as the kubelet recorded it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndedRun {
    pub code: i32,
    pub signal: Option<i32>,
    /// The kubelet's word: `Error`, `OOMKilled`, `Completed`, `StartError`.
    pub reason: Option<String>,
    pub started: Option<DateTime<Utc>>,
    pub ended: Option<DateTime<Utc>>,
    /// The run before the one the container is in, which `--previous` reads.
    pub previous: bool,
    /// The tail of the container's termination message, as it wrote it.
    pub said: Option<String>,
    /// What the run printed before it ended.
    pub log: Evidence,
}

/// What a reader found where the pod's own status stops.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "says", rename_all = "camelCase")]
pub enum Evidence {
    /// A line of a log, and whether it is the last one.
    Line {
        text: String,
        last: bool,
    },
    /// The kubelet's own event, quoted.
    Event {
        text: String,
        count: i32,
        at: Option<DateTime<Utc>>,
    },
    /// Nobody asked for it yet.
    NotRead,
    Reading,
    /// Asked, and there was none: the run printed nothing, or no event is kept.
    Nothing,
    /// The node no longer holds that run's log.
    Gone,
    Refused,
    Failed {
        said: String,
    },
}

/// What is wrong with this pod and why, or `None` where nothing this reads is.
///
/// Read without a clock, so a watched row stays true: a container down now
/// comes before one up since its last exit, which carries when it stops
/// counting. A pod being deleted, or one with the kubelet's own verdict on it
/// as a whole, is not explained by its containers.
#[must_use]
pub fn pod_cause(pod: &Pod) -> Option<PodCause> {
    if pod.metadata.deletion_timestamp.is_some() || pod_verdict(pod).is_some() {
        return None;
    }
    let status = pod.status.as_ref()?;
    let initializing = status.phase.as_deref().is_none_or(|p| p == "Pending")
        && !condition_is_true(Some(status), "Initialized");
    let candidates = match blocking_init(pod).filter(|_| initializing) {
        Some((_, held)) => vec![held],
        None => counted(pod),
    };
    let running = status.phase.as_deref() == Some("Running");
    candidates
        .iter()
        .find_map(|cs| down(cs))
        .or_else(|| candidates.iter().find_map(|cs| up_again(cs, running)))
}

/// A container down after a run that ended badly, or backing off from one.
fn down(cs: &ContainerStatus) -> Option<PodCause> {
    let state = cs.state.as_ref()?;
    if let Some(ended) = state
        .terminated
        .as_ref()
        .filter(|t| t.exit_code != 0 || t.signal.unwrap_or(0) != 0)
    {
        return Some(exits(cs, Some(ended_run(ended, false)), None));
    }
    let waiting = state.waiting.as_ref()?.reason.as_deref()?;
    (waiting == "CrashLoopBackOff")
        .then(|| exits(cs, last_terminated(cs).map(|t| ended_run(t, true)), None))
}

/// A container up again after exits that are still news, or after restarts
/// the kubelet reported no exit for.
fn up_again(cs: &ContainerStatus, running: bool) -> Option<PodCause> {
    if let Some(until) = container_restarting_until(cs) {
        let run = last_terminated(cs).map(|t| ended_run(t, true));
        return Some(exits(cs, run, Some(until)));
    }
    let unreported = running
        && cs.restart_count > 0
        && last_terminated(cs).is_none()
        && cs
            .state
            .as_ref()
            .and_then(|s| s.terminated.as_ref())
            .is_none();
    unreported.then(|| exits(cs, None, None))
}

fn exits(cs: &ContainerStatus, run: Option<EndedRun>, until: Option<DateTime<Utc>>) -> PodCause {
    PodCause::Exits {
        container: cs.name.clone(),
        restarts: cs.restart_count,
        run,
        until,
    }
}

fn ended_run(t: &ContainerStateTerminated, previous: bool) -> EndedRun {
    EndedRun {
        code: t.exit_code,
        signal: t.signal.filter(|s| *s != 0),
        reason: t.reason.clone().filter(|r| !r.is_empty()),
        // The kubelet writes the epoch as the start of a run that never began.
        started: t
            .started_at
            .as_ref()
            .map(Moment::moment)
            .filter(|at| at.timestamp() > 0),
        ended: t.finished_at.as_ref().map(Moment::moment),
        previous,
        said: t
            .message
            .as_deref()
            .map(str::trim)
            .filter(|m| !m.is_empty())
            .map(tail),
        log: Evidence::NotRead,
    }
}

fn tail(message: &str) -> String {
    let mut start = message.len().saturating_sub(SAID_TAIL);
    while !message.is_char_boundary(start) {
        start += 1;
    }
    message[start..].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pod(json: serde_json::Value) -> Pod {
        serde_json::from_value(json).expect("a pod this test wrote itself")
    }

    /// `shop/checkout` as the kubelet reports it between two runs: backing
    /// off, its last exit 1 with the app's own message kept.
    fn backing_off() -> Pod {
        pod(serde_json::json!({
            "metadata": {"name": "checkout-7c9", "namespace": "shop"},
            "spec": {"containers": [{"name": "api", "image": "shop/checkout:1"}]},
            "status": {
                "phase": "Running",
                "containerStatuses": [{
                    "name": "api", "image": "shop/checkout:1", "imageID": "", "ready": false,
                    "restartCount": 7,
                    "state": {"waiting": {"reason": "CrashLoopBackOff", "message": "back-off 5m0s restarting failed container=api"}},
                    "lastState": {"terminated": {
                        "exitCode": 1, "reason": "Error",
                        "message": "starting\nError: couldn't find key DB_PASSWORD in Secret checkout-db\n",
                        "startedAt": "2026-10-12T10:00:00Z", "finishedAt": "2026-10-12T10:00:03Z"
                    }}
                }]
            }
        }))
    }

    /// The headline every surface used to print for a loop was the restart
    /// count. Fails if the loop stops carrying the exit it backs off from.
    #[test]
    fn a_container_backing_off_is_explained_by_the_run_it_backs_off_from() {
        let Some(PodCause::Exits {
            container,
            restarts,
            run: Some(run),
            until,
        }) = pod_cause(&backing_off())
        else {
            panic!("a crash loop has a cause");
        };
        assert_eq!(container, "api");
        assert_eq!(restarts, 7);
        assert_eq!(until, None, "down now, so news until it is up again");
        assert_eq!(run.code, 1);
        assert_eq!(run.reason.as_deref(), Some("Error"));
        assert!(
            run.previous,
            "the run it backs off from is the previous one"
        );
        assert_eq!(
            run.ended.map(|at| at.to_rfc3339()),
            Some("2026-10-12T10:00:03+00:00".to_string())
        );
        assert_eq!(
            run.said.as_deref(),
            Some("starting\nError: couldn't find key DB_PASSWORD in Secret checkout-db")
        );
        assert_eq!(run.log, Evidence::NotRead);
    }

    /// A loop the kubelet reports no exit for is still a loop, and says so
    /// rather than inventing one. Fails if it is dropped as having no cause.
    #[test]
    fn a_loop_with_no_exit_reported_still_has_a_cause_and_no_run() {
        let mut pod = backing_off();
        pod.status
            .as_mut()
            .unwrap()
            .container_statuses
            .as_mut()
            .unwrap()[0]
            .last_state = None;
        assert!(matches!(
            pod_cause(&pod),
            Some(PodCause::Exits {
                run: None,
                until: None,
                ..
            })
        ));
    }

    /// A container sitting in a failed exit is the current run, which the
    /// log reads without `--previous`.
    #[test]
    fn a_container_that_just_exited_is_its_current_run() {
        let mut pod = backing_off();
        let cs = &mut pod
            .status
            .as_mut()
            .unwrap()
            .container_statuses
            .as_mut()
            .unwrap()[0];
        cs.state = cs.last_state.take();
        let Some(PodCause::Exits { run: Some(run), .. }) = pod_cause(&pod) else {
            panic!("a failed exit has a cause");
        };
        assert!(!run.previous);
    }

    /// Up again after short exits: the cause is the last exit, and it says
    /// when it stops being news. Fails if a running container's recent exits
    /// are dropped, or carried as though it were still down.
    #[test]
    fn a_container_up_again_after_short_exits_carries_until_when() {
        let mut pod = backing_off();
        let cs = &mut pod
            .status
            .as_mut()
            .unwrap()
            .container_statuses
            .as_mut()
            .unwrap()[0];
        cs.state = serde_json::from_value(
            serde_json::json!({"running": {"startedAt": "2026-10-12T10:00:30Z"}}),
        )
        .unwrap();
        let Some(PodCause::Exits {
            until: Some(until),
            run: Some(run),
            ..
        }) = pod_cause(&pod)
        else {
            panic!("recent exits are a cause");
        };
        assert!(run.previous);
        assert_eq!(until.to_rfc3339(), "2026-10-12T11:00:03+00:00");
    }

    /// A pod held on its init container is explained by that container,
    /// not by app containers that never started.
    #[test]
    fn a_pod_held_in_init_is_explained_by_the_init_container() {
        let pod = pod(serde_json::json!({
            "metadata": {"name": "init-demo"},
            "spec": {
                "initContainers": [{"name": "migrate"}],
                "containers": [{"name": "app"}]
            },
            "status": {
                "phase": "Pending",
                "conditions": [{"type": "Initialized", "status": "False"}],
                "initContainerStatuses": [{
                    "name": "migrate", "image": "", "imageID": "", "ready": false, "restartCount": 4,
                    "state": {"waiting": {"reason": "CrashLoopBackOff"}},
                    "lastState": {"terminated": {"exitCode": 2, "reason": "Error"}}
                }],
                "containerStatuses": [{
                    "name": "app", "image": "", "imageID": "", "ready": false, "restartCount": 0,
                    "state": {"waiting": {"reason": "PodInitializing"}}
                }]
            }
        }));
        assert!(matches!(
            pod_cause(&pod),
            Some(PodCause::Exits { container, .. }) if container == "migrate"
        ));
    }

    /// The kubelet's verdict on the whole pod outranks its containers: an
    /// evicted pod's container reads exit 137 because the node stopped it.
    #[test]
    fn an_evicted_pod_is_not_explained_by_its_containers() {
        let mut pod = backing_off();
        let status = pod.status.as_mut().unwrap();
        status.phase = Some("Failed".to_string());
        status.reason = Some("Evicted".to_string());
        assert_eq!(pod_cause(&pod), None);
    }

    /// A healthy pod has no cause, a restart long ago included.
    #[test]
    fn a_running_pod_with_old_or_no_exits_has_no_cause() {
        let healthy = pod(serde_json::json!({
            "metadata": {"name": "web"},
            "spec": {"containers": [{"name": "web"}]},
            "status": {
                "phase": "Running",
                "containerStatuses": [{
                    "name": "web", "image": "", "imageID": "", "ready": true, "restartCount": 1,
                    "state": {"running": {"startedAt": "2026-10-12T10:00:30Z"}},
                    "lastState": {"terminated": {"exitCode": 0, "reason": "Completed"}}
                }]
            }
        }));
        assert_eq!(pod_cause(&healthy), None);
    }

    /// A termination message is the kubelet's to cap; the end is what says
    /// why, and a cut never splits a character.
    #[test]
    fn a_long_termination_message_keeps_its_end_whole() {
        let message = format!("{}é{}", "x".repeat(2000), "Error: the end");
        let kept = tail(&message);
        assert!(kept.ends_with("Error: the end"));
        assert!(kept.len() <= SAID_TAIL);
    }
}
