//! Resource serialization helpers

use serde::{Deserialize, Serialize};

/// Owner reference
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OwnerReference {
    pub api_version: String,
    pub kind: String,
    pub name: String,
    pub uid: String,
    #[serde(default)]
    pub controller: Option<bool>,
    #[serde(default)]
    pub block_owner_deletion: Option<bool>,
}
