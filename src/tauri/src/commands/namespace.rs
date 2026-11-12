//! Namespace management commands

use crate::commands::helpers::list_cluster_resource_infos;
use crate::error::Result;
use crate::resources::NamespaceInfo;
use crate::state::AppState;
use k8s_openapi::api::core::v1::Namespace;
use tauri::State;

/// List all namespaces
#[tauri::command]
pub async fn list_namespaces(state: State<'_, AppState>) -> Result<Vec<NamespaceInfo>> {
    crate::client::clock::timed(
        &state.perf,
        "listNamespaces",
        list_cluster_resource_infos::<Namespace, NamespaceInfo>(None, state.clone()),
    )
    .await
}

/// One namespace — the trace's "namespace allowed" step peeks at it, because
/// the labels here are exactly what a listener's allowedRoutes selector
/// matches against.
#[tauri::command]
pub async fn get_namespace(name: String, state: State<'_, AppState>) -> Result<NamespaceInfo> {
    let ns: Namespace = crate::client::clock::timed(
        &state.perf,
        "getNamespace",
        crate::commands::helpers::get_cluster_resource(name, state.clone()),
    )
    .await?;
    Ok(NamespaceInfo::from(&ns))
}
