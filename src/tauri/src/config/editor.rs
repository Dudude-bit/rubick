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
    pub history: std::collections::BTreeMap<String, Vec<YamlHistoryEntry>>,
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
    /// The cluster it was opened in. Absent on items saved before the
    /// address named the cluster.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    /// The defining CRD, `<plural>.<group>`, for a custom resource.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crd: Option<String>,
    /// Timestamp in milliseconds
    pub timestamp: i64,
}

impl RecentItem {
    fn same_object(&self, other: &RecentItem) -> bool {
        self.context == other.context
            && self.crd == other.crd
            && self.kind == other.kind
            && self.namespace == other.namespace
            && self.name == other.name
    }
}

impl RecentItemsConfig {
    /// Add a recent item, maintaining the max limit
    pub fn add_item(&mut self, item: RecentItem) {
        self.items.retain(|i| !i.same_object(&item));
        // Add to front
        self.items.insert(0, item);
        self.items.truncate(MAX_RECENT_ITEMS);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(context: &str, name: &str) -> RecentItem {
        RecentItem {
            name: name.to_string(),
            namespace: Some("web".to_string()),
            kind: "Pod".to_string(),
            context: Some(context.to_string()),
            crd: None,
            timestamp: 0,
        }
    }

    /// The config written before recents named their cluster still loads;
    /// rejecting it would empty the palette's history on upgrade.
    #[test]
    fn an_item_saved_with_a_path_and_no_cluster_still_reads() {
        let old =
            r#"{"name":"api","namespace":"web","kind":"Pod","path":"/pods/web/api","timestamp":1}"#;
        let read: RecentItem = serde_json::from_str(old).expect("old item");
        assert_eq!(read.name, "api");
        assert_eq!(read.context, None);
    }

    /// One pod opened twice is one recent; the same name in two clusters is
    /// two different objects, and keeping only one would drop the other.
    #[test]
    fn the_same_object_is_kept_once_and_its_namesake_elsewhere_is_kept_too() {
        let mut recents = RecentItemsConfig::default();
        recents.add_item(item("prod", "api"));
        recents.add_item(item("prod", "api"));
        recents.add_item(item("dev", "api"));
        assert_eq!(recents.items.len(), 2);
    }
}
