//! Tauri commands that operate on existing debug sessions: delete /
//! list / get-status / extend-timeout / cancel.

use std::time::{SystemTime, UNIX_EPOCH};

use k8s_openapi::api::core::v1::Pod;
use kube::api::Api;
use tauri::State;

use crate::commands::helpers::ResourceContext;
use crate::error::{Error, Result};
use crate::state::AppState;

use super::status::{check_container_status, check_ephemeral_container_status};
use super::types::{DebugOperationType, DebugStatus, MadePod};

/// Delete a debug pod
#[tauri::command]
pub async fn delete_debug_pod(
    pod_name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<()> {
    crate::validation::validate_name::<Pod>(&pod_name)?;

    let ctx = ResourceContext::for_command(&state, namespace)?;
    let api: Api<Pod> = ctx.namespaced_api();

    // Verify it's a debug pod before deleting
    let pod = api.get(&pod_name).await?;
    let labels = pod.metadata.labels.unwrap_or_default();

    // Either label: this app makes throwaway pods two ways now — the debug
    // toolbox and the Checks tab's copy — and "is this one of ours" is one
    // question. Knowing only the older label left the newer pods deletable
    // by nothing here.
    let ours = ["k8s-gui/debug-pod", "k8s-gui/check-pod"]
        .iter()
        .any(|label| labels.get(*label).map(String::as_str) == Some("true"));
    if !ours {
        return Err(Error::InvalidInput(format!(
            "Pod '{pod_name}' is not a throwaway pod created by k8s-gui"
        )));
    }

    api.delete(&pod_name, &kube::api::DeleteParams::default())
        .await?;

    Ok(())
}

/// Get status of a debug operation
#[tauri::command]
pub async fn get_debug_status(
    operation_id: String,
    state: State<'_, AppState>,
) -> Result<DebugStatus> {
    crate::client::clock::timed(
        &state.perf,
        "getDebugStatus",
        debug_status(&state, operation_id),
    )
    .await
}

async fn debug_status(state: &AppState, operation_id: String) -> Result<DebugStatus> {
    // Get operation from storage
    let operation = state
        .debug_operations
        .get(&operation_id)
        .map(|r| r.clone())
        .ok_or_else(|| Error::InvalidInput(format!("Operation {operation_id} not found")))?;

    // Check timeout
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    if now > operation.created_at + u64::from(operation.timeout_seconds) {
        // Don't remove on timeout - user may choose "Keep Waiting"
        return Ok(DebugStatus::Timeout);
    }

    // Get Kubernetes client using ResourceContext
    let ctx = ResourceContext::for_command(state, Some(operation.namespace.clone()))?;
    let api: Api<Pod> = Api::namespaced(ctx.client.clone(), &operation.namespace);

    let pod = match api.get(&operation.pod_name).await {
        Ok(p) => p,
        Err(kube::Error::Api(e)) if e.code == 404 => {
            state.debug_operations.remove(&operation_id);
            return Ok(DebugStatus::failed("Pod not found"));
        }
        Err(e) => return Err(Error::from(e)),
    };

    // Check container status based on operation type
    let status = match operation.operation_type {
        DebugOperationType::Ephemeral => {
            check_ephemeral_container_status(&pod, &operation.container_name)
        }
        DebugOperationType::CopyPod | DebugOperationType::NodeDebug => {
            check_container_status(&pod, &operation.container_name)
        }
    };

    // If ready or failed, remove from storage
    match status {
        DebugStatus::Ready { .. } => {
            state.debug_operations.remove(&operation_id);
            Ok(status)
        }
        DebugStatus::Failed { error, .. } => {
            state.debug_operations.remove(&operation_id);
            // A pod made for a debugger that will not run has nothing to
            // enter, and a copy goes on running the workload a second
            // time: it is removed here, or handed back by name.
            let pod = match operation.operation_type {
                DebugOperationType::Ephemeral => None,
                DebugOperationType::CopyPod | DebugOperationType::NodeDebug => Some(MadePod {
                    deleted: removed(&api, &operation.pod_name).await,
                    name: operation.pod_name,
                }),
            };
            Ok(DebugStatus::Failed { error, pod })
        }
        waiting => Ok(waiting),
    }
}

/// Whether `name` is confirmed gone: deleted now, or not there to delete.
async fn removed(api: &Api<Pod>, name: &str) -> bool {
    match api.delete(name, &kube::api::DeleteParams::default()).await {
        Ok(_) => true,
        Err(kube::Error::Api(e)) => e.code == 404,
        Err(_) => false,
    }
}

/// Extend debug operation timeout (for "Keep Waiting" action)
#[tauri::command]
pub async fn extend_debug_timeout(
    operation_id: String,
    additional_seconds: Option<u32>,
    state: State<'_, AppState>,
) -> Result<()> {
    let additional = additional_seconds.unwrap_or(120);

    // Update the operation's created_at to effectively extend the timeout
    if let Some(mut operation) = state.debug_operations.get_mut(&operation_id) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        // Reset created_at to now, so timeout_seconds applies from now
        operation.created_at = now;
        // Optionally update timeout if provided
        if additional_seconds.is_some() {
            operation.timeout_seconds = additional;
        }
        Ok(())
    } else {
        Err(Error::InvalidInput(format!(
            "Operation {operation_id} not found"
        )))
    }
}

/// Cancel a debug operation and cleanup resources
#[tauri::command]
pub async fn cancel_debug_operation(
    operation_id: String,
    state: State<'_, AppState>,
) -> Result<()> {
    // Get and remove operation from storage
    let operation = state
        .debug_operations
        .remove(&operation_id)
        .map(|(_, op)| op)
        .ok_or_else(|| Error::InvalidInput(format!("Operation {operation_id} not found")))?;

    // For CopyPod and NodeDebug, delete the created pod
    match operation.operation_type {
        DebugOperationType::CopyPod | DebugOperationType::NodeDebug => {
            let ctx = ResourceContext::for_command(&state, Some(operation.namespace.clone()))?;
            let api: Api<Pod> = ctx.namespaced_api();

            // Delete the pod, ignore if not found
            match api
                .delete(&operation.pod_name, &kube::api::DeleteParams::default())
                .await
            {
                Ok(_) => {}
                Err(kube::Error::Api(e)) if e.code == 404 => {}
                Err(e) => return Err(Error::from(e)),
            }
        }
        DebugOperationType::Ephemeral => {
            // Cannot remove ephemeral container, it will be cleaned up with the pod
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::served::{
        test_server::{connected, failure},
        ServedIndex,
    };
    use crate::commands::debug::DebugOperation;

    const MADE: &str = "/api/v1/namespaces/shop/pods/orders-debug-1";

    fn waited_on(operation_type: DebugOperationType) -> DebugOperation {
        DebugOperation {
            id: "op".into(),
            operation_type,
            pod_name: "orders-debug-1".into(),
            container_name: "debugger-1".into(),
            namespace: "shop".into(),
            created_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
            timeout_seconds: 120,
        }
    }

    /// A running pod whose debugger ran to its end: `curlimages/curl` with
    /// no command, say.
    fn debugger_exited() -> String {
        let exited = serde_json::json!([{
            "name": "debugger-1",
            "state": { "terminated": { "exitCode": 0, "reason": "Completed" } },
            "ready": false, "restartCount": 0, "image": "", "imageID": "",
        }]);
        serde_json::json!({
            "apiVersion": "v1", "kind": "Pod",
            "metadata": { "name": "orders-debug-1", "namespace": "shop" },
            "spec": { "containers": [{ "name": "app" }, { "name": "debugger-1" }] },
            "status": {
                "phase": "Running",
                "containerStatuses": exited,
                "ephemeralContainerStatuses": exited,
            },
        })
        .to_string()
    }

    async fn status_of(
        operation_type: DebugOperationType,
        delete: (u16, String),
    ) -> (DebugStatus, usize, bool) {
        let (state, hits) = connected(ServedIndex::default(), move |path, nth| match path {
            MADE if nth == 1 => (200, debugger_exited()),
            MADE => delete.clone(),
            _ => (404, "{}".into()),
        })
        .await;
        state
            .debug_operations
            .insert("op".into(), waited_on(operation_type));
        let status = debug_status(&state, "op".into()).await.expect("a status");
        let asked = hits.lock().unwrap().get(MADE).copied().unwrap_or(0);
        (status, asked, state.debug_operations.is_empty())
    }

    /// A copy whose debugger exited was forgotten where it stood: every
    /// container of the workload running a second time, for an hour, with
    /// Cancel answering "Operation not found".
    #[tokio::test]
    async fn a_copy_whose_debugger_failed_is_deleted_and_reported_gone() {
        for made in [DebugOperationType::CopyPod, DebugOperationType::NodeDebug] {
            let (status, asked, forgotten) = status_of(made, (200, debugger_exited())).await;
            assert_eq!(
                status,
                DebugStatus::Failed {
                    error: "Container terminated: Completed".into(),
                    pod: Some(MadePod {
                        name: "orders-debug-1".into(),
                        deleted: true,
                    }),
                }
            );
            assert_eq!(asked, 2, "read once, then deleted");
            assert!(forgotten);
        }
    }

    /// A reader allowed to create pods and not to delete them: the copy is
    /// still there, and the answer names it rather than saying nothing.
    #[tokio::test]
    async fn a_copy_that_cannot_be_deleted_is_handed_back_by_name() {
        let (status, _, _) =
            status_of(DebugOperationType::CopyPod, failure(403, "Forbidden")).await;
        assert!(
            matches!(
                &status,
                DebugStatus::Failed { pod: Some(MadePod { name, deleted: false }), .. }
                    if name == "orders-debug-1"
            ),
            "{status:?}"
        );
    }

    /// The pod an ephemeral container was added to is the reader's own
    /// workload, not something this app made.
    #[tokio::test]
    async fn an_ephemeral_debugger_that_failed_deletes_nothing() {
        let (status, asked, _) =
            status_of(DebugOperationType::Ephemeral, (200, debugger_exited())).await;
        assert!(
            matches!(status, DebugStatus::Failed { pod: None, .. }),
            "{status:?}"
        );
        assert_eq!(asked, 1, "read, and not deleted");
    }
}
