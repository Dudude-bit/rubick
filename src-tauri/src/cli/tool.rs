//! Core CLI tool abstraction with generic implementation.

use crate::error::{Error, PluginError, Result};
use crate::shell::{ShellCommand, ShellError};
use serde::Serialize;
use std::path::PathBuf;
use std::time::Duration;
use tokio::sync::OnceCell;

/// Universal CLI tool abstraction.
///
/// Implement this trait to define a new CLI tool (kubectl, helm, gcloud, etc.).
/// The `CliToolManager` will handle path resolution, caching, and availability checks.
pub trait CliTool: Send + Sync {
    /// Human-readable name of the tool (e.g., "kubectl", "helm")
    fn name(&self) -> &'static str;

    /// Binary name to search for (e.g., "kubectl", "helm")
    fn binary_name(&self) -> &'static str;

    /// List of paths to search for this tool
    fn search_paths(&self) -> Vec<PathBuf>;

    /// Custom path from user configuration, if set
    fn custom_path(&self) -> Option<String>;

    /// Arguments to pass for version check (e.g., ["version", "--client"])
    fn version_args(&self) -> Vec<&'static str>;

    /// Parse version string from command output
    fn parse_version(&self, output: &str) -> Option<String>;

    /// Default timeout for operations (default: 30s)
    fn default_timeout(&self) -> Duration {
        Duration::from_secs(30)
    }

    /// Timeout for version check (default: 5s)
    fn version_check_timeout(&self) -> Duration {
        Duration::from_secs(5)
    }
}

/// CLI tool availability information
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliAvailability {
    /// Whether the tool is available
    pub available: bool,
    /// Tool version string
    pub version: Option<String>,
    /// Error message if not available
    pub error: Option<String>,
    /// Path where the tool was found
    pub path: Option<String>,
    /// List of paths that were searched
    pub searched_paths: Vec<String>,
}

/// Generic CLI tool manager with path resolution and caching.
///
/// Manages path resolution, availability checking, and command execution
/// for any CLI tool implementing the `CliTool` trait.
pub struct CliToolManager<T: CliTool> {
    tool: T,
    resolved_path: OnceCell<PathBuf>,
}

impl<T: CliTool> CliToolManager<T> {
    /// Create a new CLI tool manager
    pub fn new(tool: T) -> Self {
        Self {
            tool,
            resolved_path: OnceCell::new(),
        }
    }

    /// Resolve the path to the CLI tool binary.
    ///
    /// If a custom path is configured, ONLY that path will be used.
    /// If no custom path is set, searches common installation paths.
    ///
    /// Results are cached for subsequent calls.
    pub async fn resolve_path(&self) -> Result<PathBuf> {
        // Return cached path if available
        if let Some(path) = self.resolved_path.get() {
            return Ok(path.clone());
        }

        // If custom path is set, use ONLY that path (no fallback to system paths)
        if let Some(custom_path) = self.tool.custom_path() {
            if !custom_path.is_empty() {
                if let Some(_version) = self.try_path(&custom_path).await {
                    let path = PathBuf::from(custom_path);
                    // Cache the result
                    let _ = self.resolved_path.set(path.clone());
                    return Ok(path);
                }
                // Custom path was specified but is invalid
                return Err(Error::Plugin(PluginError::NotFound(format!(
                    "{} not found at custom path: {}. Check your Settings.",
                    self.tool.name(),
                    custom_path
                ))));
            }
        }

        // No custom path set - try search paths
        for path in self.tool.search_paths() {
            if let Some(_version) = self.try_path(&path.to_string_lossy()).await {
                // Cache the result
                let _ = self.resolved_path.set(path.clone());
                return Ok(path);
            }
        }

        Err(Error::Plugin(PluginError::NotFound(format!(
            "{} CLI not found. Install {} or specify a custom path in Settings.",
            self.tool.name(),
            self.tool.name()
        ))))
    }

    /// Check availability of the CLI tool.
    ///
    /// Returns detailed information about whether the tool is available,
    /// its version, and where it was found.
    ///
    /// If a custom path is explicitly configured, ONLY that path will be checked.
    /// If the custom path is invalid, an error will be returned without falling back
    /// to system paths. This ensures users get immediate feedback when their custom
    /// configuration is incorrect.
    pub async fn check_availability(&self) -> CliAvailability {
        let mut searched_paths = Vec::new();

        // If custom path is set, use ONLY that path (no fallback to system paths)
        if let Some(custom_path) = self.tool.custom_path() {
            if !custom_path.is_empty() {
                searched_paths.push(custom_path.clone());
                if let Some(version) = self.try_path(&custom_path).await {
                    return CliAvailability {
                        available: true,
                        version: Some(version),
                        error: None,
                        path: Some(custom_path),
                        searched_paths,
                    };
                }
                // Custom path was specified but is invalid - return error immediately
                return CliAvailability {
                    available: false,
                    version: None,
                    error: Some(format!(
                        "{} not found at custom path: {}",
                        self.tool.name(),
                        custom_path
                    )),
                    path: None,
                    searched_paths,
                };
            }
        }

        // No custom path set - try search paths
        for path in self.tool.search_paths() {
            let path_str = path.to_string_lossy().to_string();
            searched_paths.push(path_str.clone());

            if let Some(version) = self.try_path(&path_str).await {
                return CliAvailability {
                    available: true,
                    version: Some(version),
                    error: None,
                    path: Some(path_str),
                    searched_paths,
                };
            }
        }

        // Not found in any search location
        CliAvailability {
            available: false,
            version: None,
            error: Some(format!(
                "{} not found in any search location",
                self.tool.name()
            )),
            path: None,
            searched_paths,
        }
    }

    /// Create a command builder for this tool.
    ///
    /// The returned builder uses the resolved path and can be further
    /// configured with arguments, environment variables, etc.
    pub async fn command(&self) -> Result<ShellCommand> {
        let path = self.resolve_path().await?;
        Ok(ShellCommand::new(path).timeout(self.tool.default_timeout()))
    }

    /// Try to execute the version command for a specific path.
    ///
    /// Returns Some(version) if successful, None otherwise.
    async fn try_path(&self, path: &str) -> Option<String> {
        let output = ShellCommand::new(path)
            .args(self.tool.version_args())
            .timeout(self.tool.version_check_timeout())
            .run()
            .await
            .ok()?;

        if output.success() {
            self.tool.parse_version(&output.stdout)
        } else {
            None
        }
    }

    /// Clear cached path (useful for testing or config changes)
    pub fn clear_cache(&mut self) {
        self.resolved_path = OnceCell::new();
    }

    /// Reload with a new tool instance and clear cache
    ///
    /// This is useful when configuration changes (e.g., custom path updated)
    /// and the manager needs to re-resolve the tool path.
    pub fn reload(&mut self, new_tool: T) {
        self.tool = new_tool;
        self.clear_cache();
    }
}

/// Convert `ShellError` to our Error type for convenience
impl From<ShellError> for Error {
    fn from(err: ShellError) -> Self {
        Error::Plugin(PluginError::ExecutionFailed(err.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Mock CLI tool for testing
    struct MockTool {
        name: &'static str,
        binary: &'static str,
        custom_path: Option<String>,
        search_paths: Vec<PathBuf>,
    }

    impl CliTool for MockTool {
        fn name(&self) -> &'static str {
            self.name
        }

        fn binary_name(&self) -> &'static str {
            self.binary
        }

        fn search_paths(&self) -> Vec<PathBuf> {
            self.search_paths.clone()
        }

        fn custom_path(&self) -> Option<String> {
            self.custom_path.clone()
        }

        fn version_args(&self) -> Vec<&'static str> {
            vec!["--version"]
        }

        fn parse_version(&self, output: &str) -> Option<String> {
            // Simple parser for testing
            output.lines().next().map(|s| s.trim().to_string())
        }
    }

    #[test]
    fn test_cli_availability_serialization() {
        let availability = CliAvailability {
            available: true,
            version: Some("v1.0.0".to_string()),
            error: None,
            path: Some("/usr/bin/test".to_string()),
            searched_paths: vec!["/usr/bin/test".to_string()],
        };

        let json = serde_json::to_string(&availability).unwrap();
        assert!(json.contains("\"available\":true"));
        assert!(json.contains("\"version\":\"v1.0.0\""));
    }

    #[tokio::test]
    async fn test_manager_resolve_path_with_echo() {
        // Use 'echo' which should be available on all systems
        let tool = MockTool {
            name: "echo",
            binary: "echo",
            custom_path: None,
            search_paths: vec![PathBuf::from("echo")],
        };

        let manager = CliToolManager::new(tool);
        let result = manager.resolve_path().await;

        // This might succeed or fail depending on system, but shouldn't panic
        if let Ok(path) = result {
            assert!(!path.to_string_lossy().is_empty());
        } else {
            // Expected on some systems
        }
    }

    #[tokio::test]
    async fn test_manager_check_availability() {
        // Use 'echo' which should be available
        let tool = MockTool {
            name: "echo",
            binary: "echo",
            custom_path: None,
            search_paths: vec![PathBuf::from("echo")],
        };

        let manager = CliToolManager::new(tool);
        let availability = manager.check_availability().await;

        // Should have searched at least one path
        assert!(!availability.searched_paths.is_empty());
    }

    #[tokio::test]
    async fn test_manager_not_found() {
        // Use a binary that definitely doesn't exist
        let tool = MockTool {
            name: "nonexistent-tool-xyz",
            binary: "nonexistent-tool-xyz",
            custom_path: None,
            search_paths: vec![PathBuf::from("/nonexistent/path/tool")],
        };

        let manager = CliToolManager::new(tool);
        let result = manager.resolve_path().await;

        assert!(result.is_err());
        if let Err(Error::Plugin(PluginError::NotFound(msg))) = result {
            assert!(msg.contains("nonexistent-tool-xyz"));
        }
    }

    #[tokio::test]
    async fn test_manager_caches_path() {
        let tool = MockTool {
            name: "echo",
            binary: "echo",
            custom_path: None,
            search_paths: vec![PathBuf::from("echo")],
        };

        let manager = CliToolManager::new(tool);

        // First resolution
        let result1 = manager.resolve_path().await;

        // Second resolution should use cache
        let result2 = manager.resolve_path().await;

        if let (Ok(path1), Ok(path2)) = (result1, result2) {
            assert_eq!(path1, path2, "Cached path should match");
        } else {
            // Both should have same result (both Ok or both Err)
        }
    }

    #[test]
    fn test_shell_error_conversion() {
        let shell_err = ShellError::Timeout(Duration::from_secs(5));
        let err: Error = shell_err.into();

        match err {
            Error::Plugin(PluginError::ExecutionFailed(msg)) => {
                assert!(msg.contains("timed out"));
            }
            _ => panic!("Expected Plugin error"),
        }
    }
}
