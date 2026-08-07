//! Pod-specific commands

use k8s_openapi::api::core::v1::Pod;
use kube::api::ListParams;
use tauri::State;

use crate::commands::filters::PodFilters;
use crate::commands::helpers::{get_resource_info, ResourceContext};
use crate::error::Result;
use crate::resources::PodInfo;
use crate::state::AppState;

/// List pods with optional filters
///
/// Supports filtering by:
/// - namespace: Kubernetes namespace
/// - label_selector: Label selector string (e.g., "app=nginx,env=prod")
/// - selector: Label selector as key-value map (alternative to label_selector)
/// - field_selector: Field selector string
/// - node_name: Filter pods running on a specific node
/// - status_filter: Filter by pod phase (Running, Pending, Failed, etc.)
/// - limit: Maximum number of pods to return
#[tauri::command]
pub async fn list_pods(
    filters: Option<PodFilters>,
    state: State<'_, AppState>,
) -> Result<Vec<PodInfo>> {
    let filters = filters.unwrap_or_default();
    let ctx = ResourceContext::for_list(&state, filters.base.namespace.clone())?;
    let api: kube::Api<Pod> = ctx.namespaced_or_cluster_api();

    // Build list params with combined selectors
    let mut lp = ListParams::default();
    if let Some(label_sel) = filters.build_label_selector() {
        lp = lp.labels(&label_sel);
    }
    if let Some(field_sel) = filters.build_field_selector() {
        lp = lp.fields(&field_sel);
    }
    if let Some(limit) = filters.base.limit {
        lp = lp.limit(limit.try_into().unwrap_or(u32::MAX));
    }

    let pod_list = api.list(&lp).await?;
    let mut pods: Vec<PodInfo> = pod_list.items.iter().map(PodInfo::from).collect();

    // Client-side, and against both readings of "status": the caller may
    // be naming the phase (`Running`) or the status the app shows
    // (`CrashLoopBackOff`), and only one of those is a phase at all.
    if let Some(status) = &filters.status_filter {
        pods.retain(|p| {
            p.status.phase.eq_ignore_ascii_case(status)
                || p.status.display.eq_ignore_ascii_case(status)
        });
    }

    Ok(pods)
}

/// Get a single pod by name
#[tauri::command]
pub async fn get_pod(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<PodInfo> {
    crate::validation::validate_dns_label(&name)?;
    get_resource_info::<Pod, PodInfo>(name, namespace, state).await
}

/// Delete a pod
#[tauri::command]
pub async fn delete_pod(
    name: String,
    namespace: Option<String>,
    force: Option<bool>,
    state: State<'_, AppState>,
) -> Result<()> {
    crate::validation::validate_dns_label(&name)?;

    let delete_params = if force.unwrap_or(false) {
        Some(kube::api::DeleteParams::default().grace_period(0))
    } else {
        None
    };

    crate::commands::helpers::delete_resource::<Pod>(name, namespace, state, delete_params).await
}

/// Restart a pod (delete and let the controller recreate it)
#[tauri::command]
pub async fn restart_pod(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<()> {
    // Restarting a standalone pod just deletes it
    // For pods managed by controllers, the controller will recreate it
    delete_pod(name, namespace, Some(false), state).await
}
