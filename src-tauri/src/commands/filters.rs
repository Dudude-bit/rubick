//! Common filter structures for resource commands
//!
//! Provides unified filter structures for listing Kubernetes resources.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Base filters for Kubernetes resources
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ResourceFilters {
    pub namespace: Option<String>,
    pub label_selector: Option<String>,
    pub field_selector: Option<String>,
    pub limit: Option<i64>,
}

/// Pod-specific filters
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PodFilters {
    #[serde(flatten)]
    pub base: ResourceFilters,
    /// Filter by pod phase (Running, Pending, etc.)
    pub status_filter: Option<String>,
    /// Label selector as key-value pairs (alternative to `label_selector` string)
    pub selector: Option<BTreeMap<String, String>>,
    /// Filter by node name
    pub node_name: Option<String>,
}

impl PodFilters {
    /// Build the effective label selector string, combining `label_selector` and selector map
    #[must_use]
    pub fn build_label_selector(&self) -> Option<String> {
        let mut parts = Vec::new();

        // Add label_selector string if present
        if let Some(ls) = &self.base.label_selector {
            if !ls.is_empty() {
                parts.push(ls.clone());
            }
        }

        // Add selector map entries using the helper
        if let Some(selector) = &self.selector {
            if !selector.is_empty() {
                parts.push(super::helpers::build_label_selector(selector));
            }
        }

        if parts.is_empty() {
            None
        } else {
            Some(parts.join(","))
        }
    }

    /// Build the effective field selector string
    #[must_use]
    pub fn build_field_selector(&self) -> Option<String> {
        let mut parts = Vec::new();

        // Add field_selector string if present
        if let Some(fs) = &self.base.field_selector {
            if !fs.is_empty() {
                parts.push(fs.clone());
            }
        }

        if let Some(node) = &self.node_name {
            parts.push(format!("spec.nodeName={node}"));
        }

        if parts.is_empty() {
            None
        } else {
            Some(parts.join(","))
        }
    }
}

// Implement Deref to allow accessing base fields directly
impl std::ops::Deref for PodFilters {
    type Target = ResourceFilters;

    fn deref(&self) -> &Self::Target {
        &self.base
    }
}

/// Service-specific filters
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ServiceFilters {
    #[serde(flatten)]
    pub base: ResourceFilters,
    pub service_type: Option<String>,
}

impl std::ops::Deref for ServiceFilters {
    type Target = ResourceFilters;

    fn deref(&self) -> &Self::Target {
        &self.base
    }
}

/// Secret-specific filters
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SecretFilters {
    #[serde(flatten)]
    pub base: ResourceFilters,
    pub secret_type: Option<String>,
}

impl std::ops::Deref for SecretFilters {
    type Target = ResourceFilters;

    fn deref(&self) -> &Self::Target {
        &self.base
    }
}
