//! Metrics API commands
//!
//! Tauri commands for fetching resource usage metrics from Kubernetes Metrics API

use crate::error::Result;
use crate::metrics::{get_node_metrics, get_pod_metrics, NodeMetricsResponse, PodMetricsResponse};
use crate::state::AppState;
use tauri::State;

/// Get pod metrics from Metrics API
#[tauri::command]
pub async fn get_pods_metrics(
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<PodMetricsResponse> {
    get_pod_metrics(namespace.as_deref(), &state).await
}

/// Get node metrics from Metrics API
#[tauri::command]
pub async fn get_nodes_metrics(state: State<'_, AppState>) -> Result<NodeMetricsResponse> {
    get_node_metrics(&state).await
}
