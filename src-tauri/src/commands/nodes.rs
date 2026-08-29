//! Node commands

use crate::commands::filters::ResourceFilters;
use crate::commands::helpers::{
    get_cluster_resource_info, list_cluster_resource_infos, ResourceContext,
};
use crate::drain::{DrainHandle, DrainOptions};
use crate::error::Result;
use crate::resources::NodeInfo;
use crate::state::AppState;
use k8s_openapi::api::core::v1::Node;
use serde::{Deserialize, Serialize};
use tauri::State;

/// Node list filters
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeFilters {
    pub label_selector: Option<String>,
    pub field_selector: Option<String>,
    pub limit: Option<i64>,
    pub ready_only: Option<bool>,
}

/// List all nodes
#[tauri::command]
pub async fn list_nodes(
    filters: Option<NodeFilters>,
    state: State<'_, AppState>,
) -> Result<Vec<NodeInfo>> {
    let filters = filters.unwrap_or_default();
    let base_filters = ResourceFilters {
        namespace: None,
        label_selector: filters.label_selector.clone(),
        field_selector: filters.field_selector.clone(),
        limit: filters.limit,
    };
    let mut nodes: Vec<NodeInfo> =
        list_cluster_resource_infos::<Node, NodeInfo>(Some(base_filters), state).await?;

    if filters.ready_only.unwrap_or(false) {
        nodes.retain(|n| n.status.ready);
    }

    Ok(nodes)
}

/// Get a single node by name
#[tauri::command]
pub async fn get_node(name: String, state: State<'_, AppState>) -> Result<NodeInfo> {
    crate::validation::validate_dns_subdomain(&name)?;
    get_cluster_resource_info::<Node, NodeInfo>(name, state).await
}

/// Cordon a node (mark as unschedulable)
#[tauri::command]
pub async fn cordon_node(name: String, state: State<'_, AppState>) -> Result<()> {
    crate::validation::validate_dns_subdomain(&name)?;
    let ctx = ResourceContext::for_list(&state, None)?;
    let api: kube::Api<Node> = ctx.cluster_api();

    let patch = serde_json::json!({
        "spec": { "unschedulable": true }
    });

    api.patch(
        &name,
        &kube::api::PatchParams::default(),
        &kube::api::Patch::Merge(&patch),
    )
    .await?;

    Ok(())
}

/// Uncordon a node (mark as schedulable)
#[tauri::command]
pub async fn uncordon_node(name: String, state: State<'_, AppState>) -> Result<()> {
    crate::validation::validate_dns_subdomain(&name)?;
    let ctx = ResourceContext::for_list(&state, None)?;
    let api: kube::Api<Node> = ctx.cluster_api();

    let patch = serde_json::json!({
        "spec": { "unschedulable": false }
    });

    api.patch(
        &name,
        &kube::api::PatchParams::default(),
        &kube::api::Patch::Merge(&patch),
    )
    .await?;

    Ok(())
}

/// Start draining a node, and return at once.
///
/// The cordon happens here rather than in the loop, so a node that cannot be
/// closed to scheduling fails the click instead of failing quietly inside a
/// drain the reader is already watching.
///
/// Everything after that arrives as `drain-progress` / `drain-finished`
/// events. See [`crate::drain`] for why a drain has to be able to wait, and
/// for the rule it exists to keep: eviction only, never `DELETE`.
#[tauri::command]
pub async fn start_node_drain(
    name: String,
    options: DrainOptions,
    state: State<'_, AppState>,
) -> Result<DrainHandle> {
    crate::validation::validate_dns_subdomain(&name)?;
    cordon_node(name.clone(), state.clone()).await?;

    let client = ResourceContext::for_list(&state, None)?.client;
    Ok(state.drain_manager.start(client, name, options))
}

/// Release the first event once the frontend is listening.
///
/// # Errors
///
/// Unknown ids error rather than passing quietly, so a typo in the handle
/// surfaces here and not as a drain that seems to emit nothing.
#[tauri::command]
pub fn node_drain_subscribed(drain_id: String, state: State<'_, AppState>) -> Result<()> {
    state.drain_manager.mark_subscribed(&drain_id)
}

/// Stop asking. Pods already evicted stay evicted — an eviction is not a
/// transaction, and pretending it could be undone would be the worse lie.
#[tauri::command]
pub fn cancel_node_drain(drain_id: String, state: State<'_, AppState>) {
    state.drain_manager.cancel(&drain_id);
}
