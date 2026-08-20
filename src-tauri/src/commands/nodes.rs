//! Node commands

use crate::commands::filters::ResourceFilters;
use crate::commands::helpers::{
    get_cluster_resource_info, list_cluster_resource_infos, ResourceContext,
};
use crate::error::Result;
use crate::resources::NodeInfo;
use crate::state::AppState;
use k8s_openapi::api::core::v1::{Node, Pod};
use kube::api::ListParams;
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

/// Drain a node (evict all pods)
#[tauri::command]
pub async fn drain_node(
    name: String,
    ignore_daemonsets: Option<bool>,
    force: Option<bool>,
    state: State<'_, AppState>,
) -> Result<()> {
    crate::validation::validate_dns_subdomain(&name)?;
    // First cordon the node
    cordon_node(name.clone(), state.clone()).await?;

    let ctx = ResourceContext::for_list(&state, None)?;
    let api: kube::Api<Pod> = ctx.namespaced_or_cluster_api();

    let params = ListParams::default().fields(&format!("spec.nodeName={name}"));
    let pods = api.list(&params).await?;

    let ignore_daemonsets = ignore_daemonsets.unwrap_or(true);
    let force = force.unwrap_or(false);

    let mut eviction_errors: Vec<String> = Vec::new();

    for pod in pods.items {
        let pod_name = pod.metadata.name.clone().unwrap_or_default();
        let namespace = pod
            .metadata
            .namespace
            .clone()
            .unwrap_or_else(|| "default".to_string());

        // Skip DaemonSet pods if configured
        if ignore_daemonsets {
            if let Some(refs) = &pod.metadata.owner_references {
                if refs.iter().any(|r| r.kind == "DaemonSet") {
                    continue;
                }
            }
        }

        // Check if pod is unmanaged (no owner references) - requires force
        let is_unmanaged = pod
            .metadata
            .owner_references
            .as_ref()
            .is_none_or(std::vec::Vec::is_empty);

        if is_unmanaged && !force {
            eviction_errors.push(format!(
                "Pod {namespace}/{pod_name} is not managed by a controller. Use --force to delete."
            ));
            continue;
        }

        // Check for local storage (emptyDir) - requires force
        let has_local_storage = pod
            .spec
            .as_ref()
            .and_then(|s| s.volumes.as_ref())
            .is_some_and(|volumes| volumes.iter().any(|v| v.empty_dir.is_some()));

        if has_local_storage && !force {
            eviction_errors.push(format!(
                "Pod {namespace}/{pod_name} has local storage (emptyDir). Use --force to delete."
            ));
            continue;
        }

        // Evict the pod
        let pod_ctx = ResourceContext::for_command(&state, Some(namespace.clone()))?;
        let pod_api: kube::Api<Pod> = pod_ctx.namespaced_api();
        let evict_params = kube::api::EvictParams::default();

        match pod_api.evict(&pod_name, &evict_params).await {
            Ok(_) => {
                tracing::info!("Successfully evicted pod {}/{}", namespace, pod_name);
            }
            Err(e) => {
                let error_msg = format!("Failed to evict pod {namespace}/{pod_name}: {e}");
                tracing::warn!("{}", error_msg);

                // If force is enabled, try to delete the pod directly
                if force {
                    tracing::info!("Force deleting pod {}/{}", namespace, pod_name);
                    if let Err(delete_err) = pod_api.delete(&pod_name, &Default::default()).await {
                        eviction_errors.push(format!(
                            "Failed to force delete pod {namespace}/{pod_name}: {delete_err}"
                        ));
                    }
                } else {
                    eviction_errors.push(error_msg);
                }
            }
        }
    }

    if !eviction_errors.is_empty() {
        return Err(crate::error::Error::Internal(format!(
            "Drain completed with errors:\n{}",
            eviction_errors.join("\n")
        )));
    }

    Ok(())
}
