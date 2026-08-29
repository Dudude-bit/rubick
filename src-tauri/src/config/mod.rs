//! Application configuration.
//!
//! Configuration is loaded from a TOML file (`~/.config/k8s-gui/config.toml`
//! on Linux/macOS, `%APPDATA%/k8s-gui/config.toml` on Windows) with
//! sensible defaults for missing fields. Top-level [`AppConfig`]
//! aggregates the per-domain configs declared in the submodules:
//!
//! - `app`        — Theme / Kubernetes / Cache / Plugins / Logging
//! - `cloud`      — GCP / Azure profiles, kubeconfig context bindings, CLI paths
//! - `connection` — port-forward and registry persisted state
//! - `editor`     — YAML editor history, infra builder canvas, Recent Items
//! - `integrations` — addresses and credentials for configured integrations
//!
//! Two singleton domains live here in `mod.rs` because they're each
//! a single struct used directly by `AppConfig`: `UpdaterConfig` and
//! `ClusterPreferences`.

mod app;
mod cloud;
mod connection;
mod editor;
mod integrations;
pub mod private_file;

use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub use app::{default_true, KubernetesConfig, ThemeConfig};
pub use cloud::{AzureProfile, CliPathsConfig, CloudConfig, ContextBinding, GcpProfile};
pub use connection::{
    PortForwardConfig, PortForwardConfigStore, RegistriesConfig, RegistryConfigEntry,
};
pub use editor::{
    InfrastructureBuilderConfig, InfrastructureBuilderState, RecentItem, RecentItemsConfig,
    YamlEditorConfig, YamlHistoryEntry,
};
pub use integrations::{ConnectionEntry, IntegrationsConfig, LokiEntry, PrometheusEntry};

/// Application configuration
///
/// Every setting the app keeps in `config.toml`.
///
/// It used to name cache, plugins and logging too. Those three sections were
/// written to every user's file and parsed back out of it, and nothing read
/// them — `logging.level = "debug"` was a line somebody could set and watch
/// do nothing. A setting that is only stored is worse than a missing one:
/// the missing one does not promise anything.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppConfig {
    /// UI theme
    pub theme: ThemeConfig,
    /// Kubernetes configuration
    pub kubernetes: KubernetesConfig,
    /// Cloud provider configuration
    #[serde(default)]
    pub cloud: CloudConfig,
    /// Port-forward configuration
    #[serde(default)]
    pub port_forward: PortForwardConfigStore,
    /// CLI tools paths
    #[serde(default)]
    pub cli_paths: CliPathsConfig,
    /// Registry configurations, credentials included
    #[serde(default)]
    pub registries: RegistriesConfig,
    /// Integrations the reader configures, per kubeconfig context
    #[serde(default)]
    pub integrations: IntegrationsConfig,
    /// YAML editor history
    #[serde(default)]
    pub yaml_editor: YamlEditorConfig,
    /// Infrastructure builder state per context
    #[serde(default)]
    pub infrastructure_builder: InfrastructureBuilderConfig,
    /// Recent items for command palette
    #[serde(default)]
    pub recent_items: RecentItemsConfig,
    /// Updater configuration
    #[serde(default)]
    pub updater: UpdaterConfig,
    /// Cluster preferences (last context, namespaces)
    #[serde(default)]
    pub cluster_preferences: ClusterPreferences,
}

impl AppConfig {
    /// Load configuration from file
    ///
    /// Attempts to load configuration from the default config file location.
    /// If the file doesn't exist, returns the default configuration.
    ///
    /// # Returns
    ///
    /// Returns the loaded configuration or default configuration if file doesn't exist.
    ///
    /// # Errors
    ///
    /// Returns `Error::Config` if:
    /// - Config directory cannot be determined
    /// - Config file cannot be read
    /// - Config file contains invalid TOML
    pub fn load() -> Result<Self> {
        let config_path = Self::config_path()?;

        if config_path.exists() {
            // A config written by an older version is world-readable and holds
            // credentials. Reading it is the moment we know it exists.
            private_file::harden(&config_path);

            let content = std::fs::read_to_string(&config_path)
                .map_err(|e| Error::Config(format!("Failed to read config: {e}")))?;

            let config: Self = toml::from_str(&content)
                .map_err(|e| Error::Config(format!("Failed to parse config: {e}")))?;

            Ok(config)
        } else {
            // Return default config
            Ok(Self::default())
        }
    }

    /// Get the configuration file path
    ///
    /// Returns the default path where the configuration file should be located.
    ///
    /// # Errors
    ///
    /// Returns `Error::Config` if the config directory cannot be determined.
    pub fn config_path() -> Result<PathBuf> {
        let config_dir = dirs::config_dir()
            .ok_or_else(|| Error::Config("Could not determine config directory".to_string()))?;

        Ok(config_dir.join("k8s-gui").join("config.toml"))
    }
}

// ============================================================================
// Updater Configuration
// ============================================================================

/// Updater configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterConfig {
    /// Enable automatic update checks
    #[serde(default = "default_true")]
    pub auto_check_enabled: bool,
}

impl Default for UpdaterConfig {
    fn default() -> Self {
        Self {
            auto_check_enabled: true,
        }
    }
}

// ============================================================================
// Cluster Preferences
// ============================================================================

/// Cluster preferences configuration
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClusterPreferences {
    /// Last selected context
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "last_context"
    )]
    pub last_context: Option<String>,
    /// Namespace per context.
    ///
    /// One namespace or none — the wire value. Kept because a build without
    /// multi-namespace scopes reads this field straight into its current
    /// namespace, and a joined list here would have such a build asking the
    /// API server for a namespace called `a,b`.
    #[serde(default)]
    pub namespaces: std::collections::HashMap<String, String>,
    /// The whole selection per context, where there is more than one.
    ///
    /// Its own field rather than a joined `namespaces` value, for the reason
    /// above: an older build ignores a field it does not know and keeps
    /// reading `namespaces`, so downgrading loses the extra namespaces
    /// instead of asking for a namespace that cannot exist.
    #[serde(default)]
    pub scopes: std::collections::HashMap<String, Vec<String>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config() {
        let config = AppConfig::default();
        assert_eq!(config.theme.theme, "dark");
        assert_eq!(config.kubernetes.default_namespace, "default");
    }

    /// Every config file written before those three sections were removed
    /// still has them, and a reader whose settings failed to load because of
    /// a section the app stopped caring about would lose their theme, their
    /// cluster bindings and their saved port-forwards over it.
    #[test]
    fn a_file_still_carrying_the_removed_sections_loads() {
        let old_file = r#"
[theme]
theme = "light"

[kubernetes]
default_namespace = "production"

[cache]
enabled = false
ttl_seconds = 120
max_entries = 4000

[plugins]
kubectl_plugins = false
plugin_dirs = ["/opt/kubectl-plugins"]
timeout_seconds = 30
disabled = ["kubectl-foo"]

[logging]
level = "debug"
max_size_mb = 50
"#;

        let parsed: AppConfig =
            toml::from_str(old_file).expect("an unknown section is not a broken config");
        assert_eq!(parsed.theme.theme, "light");
        assert_eq!(parsed.kubernetes.default_namespace, "production");
    }

    #[test]
    fn test_config_serialization() {
        let config = AppConfig::default();
        let toml_str = toml::to_string(&config).unwrap();
        let parsed: AppConfig = toml::from_str(&toml_str).unwrap();

        assert_eq!(config.theme.theme, parsed.theme.theme);
    }
}
