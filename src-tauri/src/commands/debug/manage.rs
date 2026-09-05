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
use super::types::{DebugOperationType, DebugStatus};

/// Delete a debug pod
#[tauri::command]
pub async fn delete_debug_pod(
    pod_name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<()> {
    crate::validation::validate_dns_label(&pod_name)?;

    let ctx = ResourceContext::for_command(&state, namespace)?;
    let api: Api<Pod> = ctx.namespaced_api();

    // Verify it's a debug pod before deleting
    let pod = api.get(&pod_name).await?;
    let labels = pod.metadata.labels.unwrap_or_default();

    if labels
        .get("k8s-gui/debug-pod")
        .map(std::string::String::as_str)
        != Some("true")
    {
        return Err(Error::InvalidInput(format!(
            "Pod '{pod_name}' is not a debug pod created by k8s-gui"
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
    let ctx = ResourceContext::for_command(&state, Some(operation.namespace.clone()))?;
    let api: Api<Pod> = Api::namespaced(ctx.client.clone(), &operation.namespace);

    let pod = match api.get(&operation.pod_name).await {
        Ok(p) => p,
        Err(kube::Error::Api(e)) if e.code == 404 => {
            state.debug_operations.remove(&operation_id);
            return Ok(DebugStatus::Failed {
                error: "Pod not found".to_string(),
            });
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
    match &status {
        DebugStatus::Ready { .. } | DebugStatus::Failed { .. } => {
            state.debug_operations.remove(&operation_id);
        }
        _ => {}
    }

    Ok(status)
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
