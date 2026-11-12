//! Pod / container status inspection helpers used by `get_debug_status`.

use k8s_openapi::api::core::v1::{ContainerStateWaiting, Pod};

use super::types::{DebugResult, DebugStatus};

/// Check ephemeral container status
pub(super) fn check_ephemeral_container_status(pod: &Pod, container_name: &str) -> DebugStatus {
    let statuses = pod
        .status
        .as_ref()
        .and_then(|s| s.ephemeral_container_statuses.as_ref());

    let container_status = statuses.and_then(|list| list.iter().find(|c| c.name == container_name));

    match container_status {
        None => DebugStatus::Pending {
            reason: "Container not yet created".to_string(),
        },
        Some(cs) => {
            if let Some(ref state) = cs.state {
                if state.running.is_some() {
                    let ns = pod.metadata.namespace.clone().unwrap_or_default();
                    let pod_name = pod.metadata.name.clone().unwrap_or_default();
                    return DebugStatus::Ready {
                        result: DebugResult {
                            pod_name,
                            container_name: container_name.to_string(),
                            namespace: ns,
                            is_new_pod: false,
                            sees_root_of: pointed_at(pod, container_name),
                        },
                    };
                }
                if let Some(ref waiting) = state.waiting {
                    let reason = waiting
                        .reason
                        .clone()
                        .unwrap_or_else(|| "Waiting".to_string());
                    if reason.contains("ImagePull") && reason.contains("Back") {
                        return DebugStatus::failed(format!("Image pull failed: {reason}"));
                    }
                    if reason.contains("Err") {
                        return DebugStatus::failed(waiting.message.clone().unwrap_or(reason));
                    }
                    return DebugStatus::Pending { reason };
                }
                if let Some(ref terminated) = state.terminated {
                    let reason = terminated
                        .reason
                        .clone()
                        .unwrap_or_else(|| "Terminated".to_string());
                    return DebugStatus::failed(format!("Container terminated: {reason}"));
                }
            }
            DebugStatus::Pending {
                reason: "Unknown state".to_string(),
            }
        }
    }
}

/// The container an ephemeral one was pointed at, whose process namespace it
/// joined: that container's process is its process 1. `None` where it was
/// pointed at none, and where the pod shares one process namespace, in which
/// process 1 is the pause container whatever it was pointed at.
fn pointed_at(pod: &Pod, container_name: &str) -> Option<String> {
    let spec = pod.spec.as_ref()?;
    if spec.share_process_namespace == Some(true) {
        return None;
    }
    spec.ephemeral_containers
        .as_ref()?
        .iter()
        .find(|c| c.name == container_name)?
        .target_container_name
        .clone()
        .filter(|target| !target.is_empty())
}

/// Check regular container status
pub(super) fn check_container_status(pod: &Pod, container_name: &str) -> DebugStatus {
    let phase = pod
        .status
        .as_ref()
        .and_then(|s| s.phase.as_ref())
        .map_or("Unknown", std::string::String::as_str);

    match phase {
        "Failed" => {
            let reason = pod
                .status
                .as_ref()
                .and_then(|s| s.reason.clone())
                .unwrap_or_else(|| "Pod failed".to_string());
            return DebugStatus::failed(reason);
        }
        "Succeeded" => {
            return DebugStatus::failed("Pod completed".to_string());
        }
        _ => {}
    }

    // Check container statuses
    let statuses = pod
        .status
        .as_ref()
        .and_then(|s| s.container_statuses.as_ref());

    let container_status = statuses.and_then(|list| list.iter().find(|c| c.name == container_name));

    if phase == "Pending" {
        // A container that never started keeps its pod Pending, so what the
        // kubelet said of it is read before the pod's conditions: an image
        // that cannot be pulled waited two minutes as `ContainersNotReady`.
        let waiting = container_status
            .and_then(|cs| cs.state.as_ref())
            .and_then(|state| state.waiting.as_ref());
        return match waiting.map(waiting_status) {
            Some(failed @ DebugStatus::Failed { .. }) => failed,
            _ => DebugStatus::Pending {
                reason: get_pending_reason(pod),
            },
        };
    }

    match container_status {
        None => DebugStatus::Pending {
            reason: "Container not yet created".to_string(),
        },
        Some(cs) => {
            if let Some(ref state) = cs.state {
                if state.running.is_some() {
                    let ns = pod.metadata.namespace.clone().unwrap_or_default();
                    let pod_name = pod.metadata.name.clone().unwrap_or_default();
                    return DebugStatus::Ready {
                        result: DebugResult {
                            pod_name,
                            container_name: container_name.to_string(),
                            namespace: ns,
                            is_new_pod: true,
                            sees_root_of: None,
                        },
                    };
                }
                if let Some(ref waiting) = state.waiting {
                    return waiting_status(waiting);
                }
                if let Some(ref terminated) = state.terminated {
                    let reason = terminated
                        .reason
                        .clone()
                        .unwrap_or_else(|| "Terminated".to_string());
                    return DebugStatus::failed(format!("Container terminated: {reason}"));
                }
            }
            DebugStatus::Pending {
                reason: "Unknown state".to_string(),
            }
        }
    }
}

/// A waiting container of a pod this app made: still coming, or stopped by
/// something that waiting longer does not fix.
fn waiting_status(waiting: &ContainerStateWaiting) -> DebugStatus {
    let reason = waiting
        .reason
        .clone()
        .unwrap_or_else(|| "Waiting".to_string());
    if reason.contains("ImagePull") && reason.contains("Back") {
        return DebugStatus::failed(format!("Image pull failed: {reason}"));
    }
    if reason.contains("Err") || reason.contains("CrashLoop") {
        return DebugStatus::failed(waiting.message.clone().unwrap_or(reason));
    }
    DebugStatus::Pending { reason }
}

/// Get reason for pending pod
fn get_pending_reason(pod: &Pod) -> String {
    if let Some(status) = &pod.status {
        if let Some(conditions) = &status.conditions {
            for cond in conditions {
                if cond.status == "False" {
                    if let Some(reason) = &cond.reason {
                        return reason.clone();
                    }
                }
            }
        }
        if let Some(statuses) = &status.container_statuses {
            for cs in statuses {
                if let Some(state) = &cs.state {
                    if let Some(waiting) = &state.waiting {
                        return waiting
                            .reason
                            .clone()
                            .unwrap_or_else(|| "Waiting".to_string());
                    }
                }
            }
        }
    }
    "Scheduling".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn debugged(target: Option<&str>, shared: bool) -> Pod {
        serde_json::from_value(serde_json::json!({
            "metadata": { "name": "cart", "namespace": "shop" },
            "spec": {
                "shareProcessNamespace": shared,
                "containers": [{ "name": "app" }, { "name": "proxy" }],
                "ephemeralContainers": [{
                    "name": "debugger-1",
                    "targetContainerName": target,
                }],
            },
            "status": {
                "ephemeralContainerStatuses": [{
                    "name": "debugger-1",
                    "state": { "running": {} },
                    "ready": false, "restartCount": 0, "image": "", "imageID": "",
                }],
            },
        }))
        .expect("a pod")
    }

    fn sees(pod: &Pod) -> Option<String> {
        match check_ephemeral_container_status(pod, "debugger-1") {
            DebugStatus::Ready { result } => result.sees_root_of,
            other => panic!("not ready: {other:?}"),
        }
    }

    fn made(phase: &str, waiting: Option<(&str, &str)>) -> Pod {
        let state = waiting.map_or_else(
            || serde_json::json!({ "running": {} }),
            |(reason, message)| serde_json::json!({ "waiting": { "reason": reason, "message": message } }),
        );
        serde_json::from_value(serde_json::json!({
            "metadata": { "name": "cart-debug-1", "namespace": "shop" },
            "spec": { "containers": [{ "name": "debugger" }] },
            "status": {
                "phase": phase,
                "conditions": [{
                    "type": "ContainersReady", "status": "False",
                    "reason": "ContainersNotReady",
                }],
                "containerStatuses": [{
                    "name": "debugger",
                    "state": state,
                    "ready": false, "restartCount": 0, "image": "", "imageID": "",
                }],
            },
        }))
        .expect("a pod")
    }

    /// A container that never started leaves its pod Pending, which is
    /// where an image that cannot be pulled always is: read by phase first,
    /// the dialog waited out its two minutes under `ContainersNotReady`.
    #[test]
    fn an_image_that_cannot_be_pulled_fails_a_pending_debug_pod_at_once() {
        for (reason, said) in [
            ("ErrImagePull", "pull access denied for nope"),
            ("ImagePullBackOff", "Image pull failed: ImagePullBackOff"),
        ] {
            let pod = made("Pending", Some((reason, "pull access denied for nope")));
            match check_container_status(&pod, "debugger") {
                DebugStatus::Failed { error, .. } => assert_eq!(error, said),
                other => panic!("{reason} kept waiting: {other:?}"),
            }
        }
    }

    /// The other side: a pod still pulling is waiting, not failed.
    #[test]
    fn a_pending_debug_pod_still_creating_its_container_keeps_waiting() {
        let pod = made("Pending", Some(("ContainerCreating", "")));
        assert!(matches!(
            check_container_status(&pod, "debugger"),
            DebugStatus::Pending { reason } if reason == "ContainersNotReady"
        ));
    }

    /// The Files tab labels what it reads through a debug container with this
    /// name; without it the label was whichever container the tab had open.
    #[test]
    fn a_debug_container_reports_the_container_it_was_pointed_at() {
        assert_eq!(sees(&debugged(Some("proxy"), false)), Some("proxy".into()));
    }

    /// With one process namespace for the pod, process 1 is the pause
    /// container: its root listed under an app container's name is a lie.
    #[test]
    fn a_debug_container_in_a_shared_process_namespace_sees_no_one_containers_root() {
        assert_eq!(sees(&debugged(Some("proxy"), true)), None);
    }

    /// Pointed at nothing, its process 1 is its own.
    #[test]
    fn a_debug_container_pointed_at_nothing_sees_no_other_containers_root() {
        assert_eq!(sees(&debugged(None, false)), None);
    }
}
