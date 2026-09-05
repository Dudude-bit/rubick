//! Editor and palette state — YAML editor history, infrastructure
//! builder canvas state, and Command Palette recent items.

use serde::{Deserialize, Serialize};

// ============================================================================
// YAML Editor History
// ============================================================================

/// YAML editor configuration
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct YamlEditorConfig {
    /// History entries by resource key (kind:namespace:name)
    #[serde(default)]
    pub history: std::collections::HashMap<String, Vec<YamlHistoryEntry>>,
}

/// YAML history entry
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YamlHistoryEntry {
    /// Timestamp in milliseconds
    pub timestamp: i64,
    /// YAML content
    pub content: String,
    /// Optional label
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

// ============================================================================
// Infrastructure Builder State
// ============================================================================

/// Infrastructure builder configuration
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct InfrastructureBuilderConfig {
    /// State per context
    #[serde(default)]
    pub contexts: std::collections::HashMap<String, InfrastructureBuilderState>,
}

/// Infrastructure builder state for a context
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct InfrastructureBuilderState {
    /// `ReactFlow` nodes as JSON
    #[serde(default)]
    pub nodes: Vec<serde_json::Value>,
    /// `ReactFlow` edges as JSON
    #[serde(default)]
    pub edges: Vec<serde_json::Value>,
    /// YAML text content
    #[serde(default)]
    pub yaml_text: String,
    /// Extra manifests that couldn't be parsed
    #[serde(default)]
    pub extra_manifests: Vec<serde_json::Value>,
}

// ============================================================================
// Recent Items (Command Palette)
// ============================================================================

/// Maximum number of recent items to store
const MAX_RECENT_ITEMS: usize = 10;

/// Recent items configuration
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RecentItemsConfig {
    /// Recent items list
    #[serde(default)]
    pub items: Vec<RecentItem>,
}

/// Recent item entry
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentItem {
    /// Resource name
    pub name: String,
    /// Namespace (if namespaced)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    /// Resource kind
    pub kind: String,
    /// Navigation path
    pub path: String,
    /// Timestamp in milliseconds
    pub timestamp: i64,
}

impl RecentItemsConfig {
    /// Add a recent item, maintaining the max limit
    pub fn add_item(&mut self, item: RecentItem) {
        // Remove existing item with same path
        self.items.retain(|i| i.path != item.path);
        // Add to front
        self.items.insert(0, item);
        self.items.truncate(MAX_RECENT_ITEMS);
    }
}
