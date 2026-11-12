//! Helm DTOs — both the frontend-facing shapes and the internal
//! Helm-secret structures used by `secret::decode_helm_release`.

use crate::commands::helpers::shown_manifest;
use crate::resources::{withhold_strings, withhold_text, ReleaseWithheld};
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
    /// Why this release could not be read, where it could not be. A secret
    /// that will not decode used to be dropped with a warning nobody sees,
    /// and the page then reported the survivors as the whole truth — "this
    /// cluster has no releases" produced by a read that failed.
    pub unreadable: Option<String>,
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
    /// What the app left out of the three above, and where.
    pub withheld: ReleaseWithheld,
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
    /// Why this revision could not be read; it is here by its label alone.
    pub unreadable: Option<String>,
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
    /// The values the installer supplied. Helm leaves the field out
    /// altogether when there were none, which is what a chart installed on
    /// its defaults looks like — and every release like that failed to
    /// decode, was warned about where nobody reads, and left the Helm page
    /// saying the cluster has none.
    #[serde(default, rename = "config")]
    stored_values: serde_json::Value,
    #[serde(default, rename = "manifest")]
    stored_manifest: String,
}

/// A release's values, manifest and notes as they may leave this process.
pub(super) struct ShownRelease {
    pub values: serde_json::Value,
    pub manifest: String,
    pub notes: Option<String>,
    pub withheld: ReleaseWithheld,
}

impl HelmSecretRelease {
    /// The one reading of what a release stores that can hold a private
    /// key. A guard in `main.rs` holds every other reader out.
    pub fn shown(&self) -> ShownRelease {
        let mut values = self.stored_values.clone();
        let mut notes = self.info.stored_notes.clone();
        let (manifest, documents) = shown_manifest(&self.stored_manifest);
        let withheld = ReleaseWithheld {
            values: withhold_strings(&mut values),
            manifest: documents,
            notes: notes.as_mut().is_some_and(withhold_text),
        };
        ShownRelease {
            values,
            manifest,
            notes,
            withheld,
        }
    }
}

#[derive(Debug, Deserialize)]
pub(super) struct HelmSecretInfo {
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub first_deployed: Option<String>,
    #[serde(default)]
    pub last_deployed: Option<String>,
    #[serde(default, rename = "description")]
    stored_description: Option<String>,
    #[serde(default, rename = "notes")]
    stored_notes: Option<String>,
}

impl HelmSecretInfo {
    /// The release's one line about itself, as it may leave this process:
    /// Helm writes a failed upgrade's error there, and an error quotes what
    /// it failed on.
    pub fn description(&self) -> Option<String> {
        let stored = self.stored_description.as_deref();
        stored.map(crate::resources::shown_text)
    }
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
