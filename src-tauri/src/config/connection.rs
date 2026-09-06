//! Persisted connection state — port-forward configurations and
//! image registry settings.

use serde::{Deserialize, Serialize};

// ============================================================================
// Port-forward configurations
// ============================================================================

/// Port-forward configuration store
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PortForwardConfigStore {
    /// Saved port-forward configs
    #[serde(default)]
    pub configs: Vec<PortForwardConfig>,
}

/// Stored port-forward configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortForwardConfig {
    pub id: String,
    pub context: String,
    pub name: String,
    pub pod: String,
    pub namespace: String,
    pub local_port: u16,
    pub remote_port: u16,
    #[serde(default)]
    pub auto_reconnect: bool,
    #[serde(default)]
    pub auto_start: bool,
    pub created_at: String,
}

// ============================================================================
// Registry configurations
// ============================================================================

/// Registry configurations storage
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RegistriesConfig {
    /// Registry configurations (key = registry ID)
    #[serde(default)]
    pub registries: std::collections::BTreeMap<String, RegistryConfigEntry>,
}

/// Stored registry configuration (unified: connection settings + credentials)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryConfigEntry {
    /// Display label
    pub label: String,
    /// Provider type (docker-hub, registry-v2, harbor, gcr, ecr)
    pub provider: String,
    /// Base URL for API access
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    /// Host for the registry
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    /// Project (for GCR, Harbor)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// AWS Account ID (for ECR)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    /// AWS Region (for ECR)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,

    // Credentials (merged from RegistryCredential)
    /// Auth type (none, basic, bearer)
    #[serde(default = "default_auth_type")]
    pub auth_type: String,
    /// Username for basic auth
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    /// Password for basic auth
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    /// Token for bearer auth
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
}

fn default_auth_type() -> String {
    "none".to_string()
}
