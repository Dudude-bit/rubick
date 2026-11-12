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
#[serde(rename_all = "camelCase", from = "SavedRecents")]
pub struct RecentItemsConfig {
    /// The recents of 4.21 and older, kept as they were saved. Such a build
    /// cannot read an item here without a `path`, and starts on defaults
    /// with the whole file moved aside: nothing of this build's goes here.
    items: Vec<PathedRecent>,
    /// Recent items list. Its own field for the reason `scopes` is: an older
    /// build ignores it, and loses these on its next save rather than its
    /// settings on its next start.
    pub objects: Vec<RecentItem>,
}

/// A recent as 4.21 and older save it: an address, in no named cluster.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathedRecent {
    name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    namespace: Option<String>,
    kind: String,
    path: String,
    timestamp: i64,
}

/// What `items` can hold on disk. Builds of this version saved theirs there
/// for a while, without a `path`.
#[derive(Deserialize)]
#[serde(untagged)]
enum SavedRecent {
    Pathed(PathedRecent),
    Object(RecentItem),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedRecents {
    #[serde(default)]
    items: Vec<SavedRecent>,
    #[serde(default)]
    objects: Vec<RecentItem>,
}

impl From<SavedRecents> for RecentItemsConfig {
    fn from(saved: SavedRecents) -> Self {
        let mut recents = Self {
            items: Vec::new(),
            objects: saved.objects,
        };
        for item in saved.items {
            match item {
                SavedRecent::Pathed(old) => recents.items.push(old),
                // One with no cluster is an older build's that lost its
                // path here: it opens nowhere, in either build.
                SavedRecent::Object(object) if object.context.is_some() => {
                    recents.objects.push(object);
                }
                SavedRecent::Object(_) => {}
            }
        }
        recents.objects.truncate(MAX_RECENT_ITEMS);
        recents
    }
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
        self.objects.retain(|i| !i.same_object(&item));
        // Add to front
        self.objects.insert(0, item);
        self.objects.truncate(MAX_RECENT_ITEMS);
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

    /// One pod opened twice is one recent; the same name in two clusters is
    /// two different objects, and keeping only one would drop the other.
    #[test]
    fn the_same_object_is_kept_once_and_its_namesake_elsewhere_is_kept_too() {
        let mut recents = RecentItemsConfig::default();
        recents.add_item(item("prod", "api"));
        recents.add_item(item("prod", "api"));
        recents.add_item(item("dev", "api"));
        assert_eq!(recents.objects.len(), 2);
    }
}
