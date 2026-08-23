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
    /// Default kubeconfig path
    pub kubeconfig_path: Option<PathBuf>,
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

/// Cache configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheConfig {
    /// Enable caching
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Cache TTL in seconds
    #[serde(default = "default_cache_ttl")]
    pub ttl_seconds: u64,
    /// Maximum cache entries
    #[serde(default = "default_max_entries")]
    pub max_entries: usize,
}

fn default_cache_ttl() -> u64 {
    60
}
fn default_max_entries() -> usize {
    1000
}

impl Default for CacheConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            ttl_seconds: default_cache_ttl(),
            max_entries: default_max_entries(),
        }
    }
}

// ============================================================================
// Plugins
// ============================================================================

/// Plugin configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginsConfig {
    /// Enable kubectl plugins
    #[serde(default = "default_true")]
    pub kubectl_plugins: bool,
    /// Additional plugin directories
    #[serde(default)]
    pub plugin_dirs: Vec<PathBuf>,
    /// Plugin execution timeout in seconds
    #[serde(default = "default_plugin_timeout")]
    pub timeout_seconds: u64,
    /// Disabled plugins
    #[serde(default)]
    pub disabled: Vec<String>,
}

fn default_plugin_timeout() -> u64 {
    60
}

impl Default for PluginsConfig {
    fn default() -> Self {
        Self {
            kubectl_plugins: true,
            plugin_dirs: vec![],
            timeout_seconds: default_plugin_timeout(),
            disabled: vec![],
        }
    }
}

// ============================================================================
// Logging
// ============================================================================

/// Logging configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoggingConfig {
    /// Log level
    #[serde(default = "default_log_level")]
    pub level: String,
    /// Log to file
    #[serde(default)]
    pub file: Option<PathBuf>,
    /// Max log file size in MB
    #[serde(default = "default_log_size")]
    pub max_size_mb: u64,
}

fn default_log_level() -> String {
    "info".to_string()
}
fn default_log_size() -> u64 {
    10
}

impl Default for LoggingConfig {
    fn default() -> Self {
        Self {
            level: default_log_level(),
            file: None,
            max_size_mb: default_log_size(),
        }
    }
}
