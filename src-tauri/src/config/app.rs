//! Application-level configuration types: Theme, Kubernetes
//! connection, Cache, Plugins, Logging.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

// ============================================================================
// Shared default fns (used by serde defaults across this module)
// ============================================================================

#[must_use]
pub fn default_true() -> bool {
    true
}

// ============================================================================
// Theme
// ============================================================================

/// Theme configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThemeConfig {
    /// Theme mode (light, dark, system)
    #[serde(default = "default_theme")]
    pub theme: String,
    /// Accent color
    #[serde(default = "default_accent_color")]
    pub accent_color: String,
    /// Font size
    #[serde(default = "default_font_size")]
    pub font_size: u8,
    /// Compact mode
    #[serde(default)]
    pub compact: bool,
}

fn default_theme() -> String {
    "dark".to_string()
}
fn default_accent_color() -> String {
    "#3b82f6".to_string()
}
fn default_font_size() -> u8 {
    14
}

impl Default for ThemeConfig {
    fn default() -> Self {
        Self {
            theme: default_theme(),
            accent_color: default_accent_color(),
            font_size: default_font_size(),
            compact: false,
        }
    }
}

// ============================================================================
// Kubernetes
// ============================================================================

/// Kubernetes configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KubernetesConfig {
    /// The first pinned kubeconfig, or none.
    ///
    /// Kept beside [`Self::kubeconfig_paths`] rather than replaced by it: a
    /// build without multiple files reads this one and would otherwise find
    /// nothing pinned at all. It holds the first of the list, so downgrading
    /// loses the extra files instead of the lot.
    pub kubeconfig_path: Option<PathBuf>,
    /// Every pinned kubeconfig, in the order they are merged.
    ///
    /// Empty means nothing is pinned and the default lookup applies —
    /// `$KUBECONFIG` if it is set, `~/.kube/config` otherwise.
    #[serde(default)]
    pub kubeconfig_paths: Vec<PathBuf>,
    /// Default namespace
    #[serde(default = "default_namespace")]
    pub default_namespace: String,
    /// Request timeout in seconds
    #[serde(default = "default_timeout")]
    pub timeout_seconds: u64,
    /// Enable watch functionality
    #[serde(default = "default_true")]
    pub enable_watch: bool,
    /// Refresh interval in seconds
    #[serde(default = "default_refresh_interval")]
    pub refresh_interval: u64,
}

fn default_namespace() -> String {
    "default".to_string()
}
fn default_timeout() -> u64 {
    30
}
fn default_refresh_interval() -> u64 {
    30
}

impl Default for KubernetesConfig {
    fn default() -> Self {
        Self {
            kubeconfig_path: None,
            kubeconfig_paths: Vec::new(),
            default_namespace: default_namespace(),
            timeout_seconds: default_timeout(),
            enable_watch: true,
            refresh_interval: default_refresh_interval(),
        }
    }
}

// ============================================================================
// Cache
// ============================================================================

// ============================================================================
// Plugins
// ============================================================================

// ============================================================================
// Logging
// ============================================================================
