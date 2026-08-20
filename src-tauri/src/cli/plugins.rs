//! Generic plugin discovery for CLI tools.

use crate::cli::paths::PathResolver;
use crate::error::Result;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Information about a discovered plugin
#[derive(Debug, Clone, Serialize)]
pub struct PluginInfo {
    /// Plugin name (without prefix)
    pub name: String,
    /// Path to the executable
    pub path: PathBuf,
    /// Whether it's executable
    pub executable: bool,
}

/// Generic plugin discovery for CLI tools.
///
/// Discovers plugins by searching PATH for executables with a given prefix.
/// For example, kubectl plugins are named "kubectl-*", helm plugins "helm-*", etc.
pub struct PluginDiscovery {
    /// Plugin prefix (e.g., "kubectl-", "helm-")
    prefix: String,
    /// Discovered plugins
    plugins: HashMap<String, PluginInfo>,
}

impl PluginDiscovery {
    /// Create a new plugin discovery with the given prefix.
    ///
    /// # Arguments
    ///
    /// * `prefix` - The prefix to search for (e.g., "kubectl-", "helm-")
    ///
    /// # Examples
    ///
    /// ```
    /// use k8s_gui_lib::cli::plugins::PluginDiscovery;
    ///
    /// let discovery = PluginDiscovery::new("kubectl-");
    /// ```
    pub fn new(prefix: impl Into<String>) -> Self {
        Self {
            prefix: prefix.into(),
            plugins: HashMap::new(),
        }
    }

    /// Discover plugins in PATH.
    ///
    /// Searches all directories in PATH for executables matching the prefix.
    /// Converts underscores to dashes in plugin names (e.g., kubectl-oidc_login → oidc-login).
    ///
    /// Returns a vector of discovered plugins.
    pub fn discover(&mut self) -> Result<Vec<PluginInfo>> {
        // Use shell-resolved PATH to find plugins in homebrew and user paths
        let path_var = crate::shell::get_user_path();
        let path_var = if path_var.is_empty() {
            std::env::var("PATH").unwrap_or_default()
        } else {
            path_var.to_string()
        };

        // Use OS-agnostic separator
        let separator = PathResolver::separator();
        let paths: Vec<&str> = path_var.split(separator).collect();

        let mut discovered = Vec::new();

        for path in paths {
            let dir = Path::new(path);
            if !dir.is_dir() {
                continue;
            }

            if let Ok(entries) = std::fs::read_dir(dir) {
                for entry in entries.flatten() {
                    let file_name = entry.file_name();
                    let name = file_name.to_string_lossy();

                    if name.starts_with(&self.prefix) {
                        // Plugin file may use underscore but the tool expects dash
                        // Example: kubectl-oidc_login file → oidc-login plugin name
                        let plugin_name = name
                            .trim_start_matches(self.prefix.as_str())
                            .replace('_', "-");

                        let path = entry.path();
                        let executable = is_executable(&path);

                        if executable {
                            let plugin = PluginInfo {
                                name: plugin_name.clone(),
                                path: path.clone(),
                                executable,
                            };

                            // Don't override if already found (first in PATH wins)
                            if !self.plugins.contains_key(&plugin_name) {
                                self.plugins.insert(plugin_name.clone(), plugin.clone());
                                discovered.push(plugin);
                            }
                        }
                    }
                }
            }
        }

        tracing::info!(
            "Discovered {} plugins with prefix '{}'",
            discovered.len(),
            self.prefix
        );
        Ok(discovered)
    }

    /// List all discovered plugins
    #[must_use]
    pub fn list(&self) -> Vec<&PluginInfo> {
        self.plugins.values().collect()
    }

    /// Get a plugin by name
    #[must_use]
    pub fn get(&self, name: &str) -> Option<&PluginInfo> {
        self.plugins.get(name)
    }

    /// Check if a plugin exists
    #[must_use]
    pub fn contains(&self, name: &str) -> bool {
        self.plugins.contains_key(name)
    }

    /// Clear all discovered plugins
    pub fn clear(&mut self) {
        self.plugins.clear();
    }
}

/// Check if a file is executable
#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(metadata) = std::fs::metadata(path) {
        let permissions = metadata.permissions();
        // Check if any execute bit is set
        permissions.mode() & 0o111 != 0
    } else {
        false
    }
}

/// Check if a file is executable on Windows
#[cfg(windows)]
fn is_executable(path: &Path) -> bool {
    // On Windows, check if file has .exe, .bat, .cmd extension
    if let Some(ext) = path.extension() {
        let ext = ext.to_string_lossy().to_lowercase();
        matches!(ext.as_str(), "exe" | "bat" | "cmd")
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_plugin_discovery_new() {
        let discovery = PluginDiscovery::new("kubectl-");
        assert_eq!(discovery.prefix, "kubectl-");
        assert!(discovery.plugins.is_empty());
    }

    #[test]
    fn test_plugin_info_serialization() {
        let info = PluginInfo {
            name: "test-plugin".to_string(),
            path: PathBuf::from("/usr/bin/test-plugin"),
            executable: true,
        };

        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains("test-plugin"));
        assert!(json.contains("executable"));
    }

    #[test]
    fn test_discovery_list_empty() {
        let discovery = PluginDiscovery::new("test-");
        assert!(discovery.list().is_empty());
    }

    #[test]
    fn test_discovery_get_nonexistent() {
        let discovery = PluginDiscovery::new("test-");
        assert!(discovery.get("nonexistent").is_none());
    }

    #[test]
    fn test_discovery_contains() {
        let mut discovery = PluginDiscovery::new("test-");
        assert!(!discovery.contains("test"));

        discovery.plugins.insert(
            "test".to_string(),
            PluginInfo {
                name: "test".to_string(),
                path: PathBuf::from("/test"),
                executable: true,
            },
        );

        assert!(discovery.contains("test"));
    }

    #[test]
    fn test_discovery_clear() {
        let mut discovery = PluginDiscovery::new("test-");
        discovery.plugins.insert(
            "test".to_string(),
            PluginInfo {
                name: "test".to_string(),
                path: PathBuf::from("/test"),
                executable: true,
            },
        );

        assert_eq!(discovery.list().len(), 1);
        discovery.clear();
        assert!(discovery.list().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn test_is_executable_on_unix() {
        // Test with a known executable
        let path = Path::new("/bin/sh");
        if path.exists() {
            assert!(is_executable(path), "/bin/sh should be executable");
        }

        // Test with a non-executable file
        let path = Path::new("/etc/hosts");
        if path.exists() {
            // /etc/hosts is typically not executable
            // But this might vary, so we just check it doesn't panic
            let _ = is_executable(path);
        }
    }

    #[cfg(windows)]
    #[test]
    fn test_is_executable_on_windows() {
        // Test with .exe extension
        assert!(is_executable(Path::new("test.exe")));
        assert!(is_executable(Path::new("test.bat")));
        assert!(is_executable(Path::new("test.cmd")));

        // Test without executable extension
        assert!(!is_executable(Path::new("test.txt")));
        assert!(!is_executable(Path::new("test")));
    }

    #[test]
    fn test_underscore_to_dash_conversion() {
        // This tests the concept, actual discovery would need PATH setup
        let prefix = "kubectl-";
        let filename = "kubectl-oidc_login";

        let plugin_name = filename.trim_start_matches(prefix).replace('_', "-");

        assert_eq!(plugin_name, "oidc-login");
    }
}
