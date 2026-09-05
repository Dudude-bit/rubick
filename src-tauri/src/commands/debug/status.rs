//! Pod / container status inspection helpers used by `get_debug_status`.

use k8s_openapi::api::core::v1::Pod;

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
                        },
                    };
                }
                if let Some(ref waiting) = state.waiting {
                    let reason = waiting
                        .reason
                        .clone()
                        .unwrap_or_else(|| "Waiting".to_string());
                    if reason.contains("ImagePull") && reason.contains("Back") {
                        return DebugStatus::Failed {
                            error: format!("Image pull failed: {reason}"),
                        };
                    }
                    if reason.contains("Err") {
                        return DebugStatus::Failed {
                            error: waiting.message.clone().unwrap_or(reason),
                        };
                    }
                    return DebugStatus::Pending { reason };
                }
                if let Some(ref terminated) = state.terminated {
                    let reason = terminated
                        .reason
                        .clone()
                        .unwrap_or_else(|| "Terminated".to_string());
                    return DebugStatus::Failed {
                        error: format!("Container terminated: {reason}"),
                    };
                }
            }
            DebugStatus::Pending {
                reason: "Unknown state".to_string(),
            }
        }
    }
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
            return DebugStatus::Failed { error: reason };
        }
        "Succeeded" => {
            return DebugStatus::Failed {
                error: "Pod completed".to_string(),
            };
        }
        "Pending" => {
            let reason = get_pending_reason(pod);
            return DebugStatus::Pending { reason };
        }
        _ => {}
    }

    // Check container statuses
    let statuses = pod
        .status
        .as_ref()
        .and_then(|s| s.container_statuses.as_ref());

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
                            is_new_pod: true,
                        },
                    };
                }
                if let Some(ref waiting) = state.waiting {
                    let reason = waiting
                        .reason
                        .clone()
                        .unwrap_or_else(|| "Waiting".to_string());
                    if reason.contains("ImagePull") && reason.contains("Back") {
                        return DebugStatus::Failed {
                            error: format!("Image pull failed: {reason}"),
                        };
                    }
                    if reason.contains("Err") || reason.contains("CrashLoop") {
                        return DebugStatus::Failed {
                            error: waiting.message.clone().unwrap_or(reason),
                        };
                    }
                    return DebugStatus::Pending { reason };
                }
                if let Some(ref terminated) = state.terminated {
                    let reason = terminated
                        .reason
                        .clone()
                        .unwrap_or_else(|| "Terminated".to_string());
                    return DebugStatus::Failed {
                        error: format!("Container terminated: {reason}"),
                    };
                }
            }
            DebugStatus::Pending {
                reason: "Unknown state".to_string(),
            }
        }
    }
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
