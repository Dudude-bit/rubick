//! Frontend-facing Metrics API types + the internal serde shapes
//! used to deserialize the kube `DynamicObject` responses from the
//! `metrics.k8s.io/v1beta1` API group.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MetricsStatusKind {
    Available,
    NotInstalled,
    Forbidden,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricsStatus {
    pub status: MetricsStatusKind,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PodMetricsResponse {
    pub status: MetricsStatus,
    pub data: Vec<PodMetrics>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeMetricsResponse {
    pub status: MetricsStatus,
    pub data: Vec<NodeMetrics>,
}

/// Pod metrics from Metrics API (values are in millicores/bytes)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PodMetrics {
    pub name: String,
    pub namespace: String,
    pub cpu_millicores: Option<f64>,
    pub memory_bytes: Option<u64>,
}

/// Node metrics from Metrics API (values are in millicores/bytes)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeMetrics {
    pub name: String,
    pub cpu_millicores: Option<f64>,
    pub memory_bytes: Option<u64>,
}

// ============================================================================
// Internal serde shapes for the metrics.k8s.io DynamicObject responses
// ============================================================================

#[derive(Debug, Deserialize)]
pub(super) struct PodMetricsItem {
    pub metadata: PodMetricsMetadata,
    #[serde(rename = "containers")]
    pub containers: Vec<ContainerMetrics>,
}

#[derive(Debug, Deserialize)]
pub(super) struct PodMetricsMetadata {
    pub name: String,
    pub namespace: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct ContainerMetrics {
    pub usage: ContainerUsage,
}

#[derive(Debug, Deserialize)]
pub(super) struct ContainerUsage {
    pub cpu: Option<String>,
    pub memory: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct NodeMetricsItem {
    pub metadata: NodeMetricsMetadata,
    pub usage: ContainerUsage,
}

#[derive(Debug, Deserialize)]
pub(super) struct NodeMetricsMetadata {
    pub name: String,
}
