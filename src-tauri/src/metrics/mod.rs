//! Kubernetes Metrics API integration.
//!
//! Provides functionality to fetch resource usage metrics (CPU, Memory)
//! from the Kubernetes Metrics API (`/apis/metrics.k8s.io/v1beta1/`).
//!
//! - `types`: frontend Metrics types + internal serde shapes
//! - `parse`: kube `DynamicObject` → frontend types, status mapping,
//!   shared `fetch_metrics` generic helper

mod parse;
mod types;

pub use types::{
    MetricsStatus, MetricsStatusKind, NodeMetrics, NodeMetricsResponse, PodMetrics,
    PodMetricsResponse,
};

use crate::error::Result;
use crate::state::AppState;

use parse::{fetch_metrics, parse_node_metric, parse_pod_metric};

/// Get pod metrics from Metrics API
pub async fn get_pod_metrics(
    namespace: Option<&str>,
    state: &AppState,
) -> Result<PodMetricsResponse> {
    let (status, data) = fetch_metrics(state, namespace, "PodMetrics", parse_pod_metric).await?;
    Ok(PodMetricsResponse { status, data })
}

/// Get node metrics from Metrics API
pub async fn get_node_metrics(state: &AppState) -> Result<NodeMetricsResponse> {
    let (status, data) = fetch_metrics(state, None, "NodeMetrics", parse_node_metric).await?;
    Ok(NodeMetricsResponse { status, data })
}
