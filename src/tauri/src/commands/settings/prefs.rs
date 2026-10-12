//! Application preferences — theme, YAML editor history, recent items,
//! updater settings, cluster preferences, and the trivial `AppInfo` command.

use crate::config::{ClusterPreferences, RecentItem, UpdaterConfig, YamlHistoryEntry};
use crate::error::Result;
use serde::{Deserialize, Serialize};

use super::helpers::{off_main, read_config, with_config};

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
#[must_use]
pub fn get_app_info(app: tauri::AppHandle) -> AppInfo {
    let package_info = app.package_info();
    AppInfo {
        version: package_info.version.to_string(),
        name: package_info.name.clone(),
        tauri_version: tauri::VERSION.to_string(),
        os: std::env::consts::OS.to_string(),
    }
}

// ============================================================================
// Theme
// ============================================================================

#[tauri::command]
pub async fn get_theme_config() -> Result<ThemeConfig> {
    read_config(|config| ThemeConfig {
        theme: config.theme.theme.clone(),
        accent_color: config.theme.accent_color.clone(),
        font_size: config.theme.font_size,
        compact: config.theme.compact,
    })
    .await
}

#[tauri::command]
pub async fn save_theme_config(theme: ThemeConfig) -> Result<()> {
    with_config(move |config| {
        config.theme.theme = theme.theme;
        config.theme.accent_color = theme.accent_color;
        config.theme.font_size = theme.font_size;
        config.theme.compact = theme.compact;
    })
    .await
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
pub async fn get_yaml_history(resource_key: String) -> Result<Vec<YamlHistoryEntryDto>> {
    read_config(move |config| {
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
    .await
}

#[tauri::command]
pub async fn add_yaml_history_entry(
    resource_key: String,
    entry: YamlHistoryEntryDto,
) -> Result<()> {
    let history_entry = YamlHistoryEntry {
        timestamp: entry.timestamp,
        content: entry.content,
        label: entry.label,
    };

    with_config(move |config| {
        let entries = config.yaml_editor.history.entry(resource_key).or_default();
        // Add to front, limit to 20 entries
        entries.insert(0, history_entry);
        entries.truncate(20);
    })
    .await
}

// ============================================================================
// Recent items (Command Palette)
// ============================================================================

#[tauri::command]
pub async fn get_recent_items() -> Result<Vec<RecentItem>> {
    read_config(|config| config.recent_items.items.clone()).await
}

#[tauri::command]
pub async fn add_recent_item(item: RecentItem) -> Result<()> {
    with_config(move |config| {
        config.recent_items.add_item(item);
    })
    .await
}

// ============================================================================
// Updater settings
// ============================================================================

#[tauri::command]
pub async fn get_updater_settings() -> Result<UpdaterConfig> {
    read_config(|config| config.updater.clone()).await
}

#[tauri::command]
pub async fn save_updater_settings(settings: UpdaterConfig) -> Result<()> {
    with_config(move |config| {
        config.updater = settings;
    })
    .await
}

/// Whether this build can install an update it downloads.
///
/// The Flatpak bundle cannot: it replaces `current_exe`, which lives in
/// `/app`, a read-only mount. The download succeeds and the install fails,
/// every half hour, for what `flatpak update` does anyway. Asked of the
/// backend because the webview cannot see the sandbox.
#[tauri::command]
pub async fn updater_can_install() -> Result<bool> {
    off_main(|| Ok(!crate::cli::paths::PathResolver::in_sandbox())).await
}

// ============================================================================
// Cluster preferences
// ============================================================================

#[tauri::command]
pub async fn get_cluster_preferences() -> Result<ClusterPreferences> {
    read_config(|config| config.cluster_preferences.clone()).await
}

#[tauri::command]
pub async fn save_cluster_preferences(
    last_context: Option<String>,
    context: Option<String>,
    namespace: Option<String>,
    scope: Option<Vec<String>>,
) -> Result<()> {
    with_config(move |config| {
        if let Some(ctx) = last_context {
            config.cluster_preferences.last_context = Some(ctx);
        }

        if let (Some(ctx), Some(ns)) = (context.clone(), namespace) {
            config.cluster_preferences.namespaces.insert(ctx, ns);
        }

        // Written even when empty: clearing the selection back to the whole
        // cluster is a choice, and leaving the old list behind would restore
        // it the next time that context is opened.
        if let (Some(ctx), Some(scope)) = (context, scope) {
            config.cluster_preferences.scopes.insert(ctx, scope);
        }
    })
    .await
}
