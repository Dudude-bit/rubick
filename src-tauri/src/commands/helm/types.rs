//! Helm DTOs — both the frontend-facing shapes and the internal
//! Helm-secret structures used by `secret::decode_helm_release`.

use serde::{Deserialize, Serialize};

/// Helm release info (unified format for frontend)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelmRelease {
    pub name: String,
    pub namespace: String,
    pub revision: i32,
    pub status: String,
    pub chart: String,
    pub app_version: Option<String>,
    pub updated: String,
    /// Source: "native" for helm CLI releases, "flux" for Flux `HelmReleases`
    pub source: String,
    /// Additional info for Flux releases
    pub suspended: Option<bool>,
    pub source_ref: Option<String>,
}

/// Helm release detail (from Kubernetes Secret)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelmReleaseDetail {
    pub name: String,
    pub namespace: String,
    pub revision: i32,
    pub status: String,
    pub chart: String,
    pub chart_version: String,
    pub app_version: Option<String>,
    pub first_deployed: Option<String>,
    pub last_deployed: Option<String>,
    pub description: Option<String>,
    pub values: serde_json::Value,
    pub manifest: String,
    pub notes: Option<String>,
}

/// Helm revision history entry
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelmRevision {
    pub revision: i32,
    pub updated: String,
    pub status: String,
    pub chart: String,
    pub app_version: Option<String>,
    pub description: Option<String>,
}

/// Helm repository info
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelmRepository {
    pub name: String,
    pub url: String,
}

/// Helm chart search result
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelmChartSearchResult {
    pub name: String,
    pub version: String,
    pub app_version: String,
    pub description: String,
}

/// Helm install/upgrade options
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelmInstallOptions {
    pub release_name: String,
    pub chart: String,
    pub namespace: String,
    pub version: Option<String>,
    pub values: Option<String>, // YAML string
    pub create_namespace: bool,
    pub wait: bool,
    pub timeout: Option<String>, // e.g. "5m0s"
}

// ============================================================================
// Internal: Helm secret release shape
// ============================================================================

#[derive(Debug, Deserialize)]
pub(super) struct HelmSecretRelease {
    pub name: String,
    pub namespace: String,
    pub version: i32,
    pub info: HelmSecretInfo,
    pub chart: HelmSecretChart,
    pub config: serde_json::Value,
    #[serde(default)]
    pub manifest: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct HelmSecretInfo {
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub first_deployed: Option<String>,
    #[serde(default)]
    pub last_deployed: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct HelmSecretChart {
    pub metadata: HelmSecretChartMetadata,
}

#[derive(Debug, Deserialize)]
pub(super) struct HelmSecretChartMetadata {
    pub name: String,
    pub version: String,
    #[serde(rename = "appVersion", default)]
    pub app_version: Option<String>,
}
