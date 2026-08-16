//! Registry DTOs — frontend-facing shapes plus the internal Docker
//! `config.json` decoding structs.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryAuth {
    pub auth_type: String,
    pub username: Option<String>,
    pub password: Option<String>,
    pub token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryConfig {
    pub id: String,
    pub provider: String,
    pub base_url: Option<String>,
    pub host: Option<String>,
    pub project: Option<String>,
    pub account_id: Option<String>,
    pub region: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrySearchRequest {
    pub query: String,
    pub registry: RegistryConfig,
    pub auth: Option<RegistryAuth>,
    pub use_saved_auth: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryImageResult {
    pub id: String,
    pub name: String,
    pub description: String,
    pub is_official: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryImportEntry {
    pub server: String,
    pub host: String,
    pub base_url: String,
    pub is_docker_hub: bool,
    pub auth: Option<RegistryAuth>,
}

// ============================================================================
// Internal: Docker config.json decoding
// ============================================================================

#[derive(Debug, Deserialize)]
pub(super) struct DockerConfigFile {
    pub auths: Option<HashMap<String, DockerAuthEntry>>,
}

#[derive(Debug, Deserialize)]
pub(super) struct DockerAuthEntry {
    pub auth: Option<String>,
    #[serde(rename = "identitytoken")]
    pub identity_token: Option<String>,
}
