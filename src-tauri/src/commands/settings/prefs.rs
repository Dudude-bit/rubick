//! Application preferences — theme, YAML editor history, infrastructure
//! builder canvas state, recent items, updater settings, cluster
//! preferences, and the trivial AppInfo command.

use crate::config::{
    ClusterPreferences, InfrastructureBuilderState as ConfigBuilderState, RecentItem,
    UpdaterConfig, YamlHistoryEntry,
};
use crate::error::Result;
use serde::{Deserialize, Serialize};

use super::helpers::{read_config, with_config};

// ============================================================================
// AppInfo (build/version metadata)
// ============================================================================

/// Theme configuration (frontend-facing shape)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeConfig {
    pub theme: String,
    pub accent_color: String,
    pub font_size: u8,
    pub compact: bool,
}

/// Kubernetes configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesConfig {
    pub default_namespace: String,
    pub kubeconfig_path: Option<String>,
    pub timeout_seconds: u64,
    pub enable_watch: bool,
    pub refresh_interval: u64,
}

/// Cache configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheConfig {
    pub enabled: bool,
    pub ttl_seconds: u64,
    pub max_entries: usize,
}

/// Plugin configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginConfig {
    pub kubectl_plugins: bool,
    pub plugin_dirs: Vec<String>,
    pub timeout_seconds: u64,
    pub disabled: Vec<String>,
}

/// Logging configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoggingConfig {
    pub level: String,
    pub file: Option<String>,
}

/// Keyboard shortcut
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyboardShortcut {
    pub id: String,
    pub action: String,
    pub keys: String,
    pub description: String,
}

/// App info
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub name: String,
    pub tauri_version: String,
    /// Host OS: "macos" | "windows" | "linux". Drives which modifier
    /// glyph the UI prints — the frontend must never guess this from a
    /// user agent string, which lies inside a webview.
    pub os: String,
}

/// Get application version and build info
#[tauri::command]
pub fn get_app_info(app: tauri::AppHandle) -> AppInfo {
    let package_info = app.package_info();
    AppInfo {
        version: package_info.version.to_string(),
        name: package_info.name.to_string(),
        tauri_version: tauri::VERSION.to_string(),
        os: std::env::consts::OS.to_string(),
    }
}

// ============================================================================
// Theme
// ============================================================================

#[tauri::command]
pub fn get_theme_config() -> Result<ThemeConfig> {
    read_config(|config| ThemeConfig {
        theme: config.theme.theme.clone(),
        accent_color: config.theme.accent_color.clone(),
        font_size: config.theme.font_size,
        compact: config.theme.compact,
    })
}

#[tauri::command]
pub fn save_theme_config(theme: ThemeConfig) -> Result<()> {
    with_config(|config| {
        config.theme.theme = theme.theme;
        config.theme.accent_color = theme.accent_color;
        config.theme.font_size = theme.font_size;
        config.theme.compact = theme.compact;
    })
}

// ============================================================================
// YAML editor history
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YamlHistoryEntryDto {
    pub timestamp: i64,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[tauri::command]
pub fn get_yaml_history(resource_key: String) -> Result<Vec<YamlHistoryEntryDto>> {
    read_config(|config| {
        config
            .yaml_editor
            .history
            .get(&resource_key)
            .map(|entries| {
                entries
                    .iter()
                    .map(|e| YamlHistoryEntryDto {
                        timestamp: e.timestamp,
                        content: e.content.clone(),
                        label: e.label.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default()
    })
}

#[tauri::command]
pub fn add_yaml_history_entry(resource_key: String, entry: YamlHistoryEntryDto) -> Result<()> {
    let history_entry = YamlHistoryEntry {
        timestamp: entry.timestamp,
        content: entry.content,
        label: entry.label,
    };

    with_config(|config| {
        let entries = config.yaml_editor.history.entry(resource_key).or_default();
        // Add to front, limit to 20 entries
        entries.insert(0, history_entry);
        entries.truncate(20);
    })
}

#[tauri::command]
pub fn get_all_yaml_history() -> Result<std::collections::HashMap<String, Vec<YamlHistoryEntryDto>>>
{
    read_config(|config| {
        config
            .yaml_editor
            .history
            .iter()
            .map(|(k, v)| {
                let entries = v
                    .iter()
                    .map(|e| YamlHistoryEntryDto {
                        timestamp: e.timestamp,
                        content: e.content.clone(),
                        label: e.label.clone(),
                    })
                    .collect();
                (k.clone(), entries)
            })
            .collect()
    })
}

// ============================================================================
// Infrastructure builder canvas state
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InfrastructureBuilderStateDto {
    pub nodes: Vec<serde_json::Value>,
    pub edges: Vec<serde_json::Value>,
    pub yaml_text: String,
    pub extra_manifests: Vec<serde_json::Value>,
}

#[tauri::command]
pub fn get_infrastructure_state(context: String) -> Result<InfrastructureBuilderStateDto> {
    read_config(|config| {
        let state = config
            .infrastructure_builder
            .contexts
            .get(&context)
            .cloned()
            .unwrap_or_default();
        InfrastructureBuilderStateDto {
            nodes: state.nodes,
            edges: state.edges,
            yaml_text: state.yaml_text,
            extra_manifests: state.extra_manifests,
        }
    })
}

#[tauri::command]
pub fn save_infrastructure_state(
    context: String,
    state: InfrastructureBuilderStateDto,
) -> Result<()> {
    let builder_state = ConfigBuilderState {
        nodes: state.nodes,
        edges: state.edges,
        yaml_text: state.yaml_text,
        extra_manifests: state.extra_manifests,
    };

    with_config(|config| {
        config
            .infrastructure_builder
            .contexts
            .insert(context, builder_state);
    })
}

#[tauri::command]
pub fn clear_infrastructure_state(context: String) -> Result<()> {
    with_config(|config| {
        config.infrastructure_builder.contexts.remove(&context);
    })
}

// ============================================================================
// Recent items (Command Palette)
// ============================================================================

#[tauri::command]
pub fn get_recent_items() -> Result<Vec<RecentItem>> {
    read_config(|config| config.recent_items.items.clone())
}

#[tauri::command]
pub fn add_recent_item(item: RecentItem) -> Result<()> {
    with_config(|config| {
        config.recent_items.add_item(item);
    })
}

// ============================================================================
// Updater settings
// ============================================================================

#[tauri::command]
pub fn get_updater_settings() -> Result<UpdaterConfig> {
    read_config(|config| config.updater.clone())
}

#[tauri::command]
pub fn save_updater_settings(settings: UpdaterConfig) -> Result<()> {
    with_config(|config| {
        config.updater = settings;
    })
}

// ============================================================================
// Cluster preferences
// ============================================================================

#[tauri::command]
pub fn get_cluster_preferences() -> Result<ClusterPreferences> {
    read_config(|config| config.cluster_preferences.clone())
}

#[tauri::command]
pub fn save_cluster_preferences(
    last_context: Option<String>,
    context: Option<String>,
    namespace: Option<String>,
) -> Result<()> {
    with_config(|config| {
        if let Some(ctx) = last_context {
            config.cluster_preferences.last_context = Some(ctx);
        }

        if let (Some(ctx), Some(ns)) = (context, namespace) {
            config.cluster_preferences.namespaces.insert(ctx, ns);
        }
    })
}
