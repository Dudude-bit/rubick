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
