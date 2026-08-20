//! Helm CLI tool implementation.

use crate::cli::paths::PathResolver;
use crate::cli::tool::CliTool;
use crate::config::AppConfig;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

/// Helm CLI tool implementation
pub struct HelmTool {
    config: Arc<AppConfig>,
}

impl HelmTool {
    /// Create a new Helm tool instance
    #[must_use]
    pub fn new(config: Arc<AppConfig>) -> Self {
        Self { config }
    }

    /// Create with default config
    #[must_use]
    pub fn with_default_config() -> Self {
        let config = AppConfig::load().unwrap_or_default();
        Self {
            config: Arc::new(config),
        }
    }
}

impl CliTool for HelmTool {
    fn name(&self) -> &'static str {
        "helm"
    }

    fn binary_name(&self) -> &'static str {
        "helm"
    }

    fn search_paths(&self) -> Vec<PathBuf> {
        PathResolver::search_paths("helm")
    }

    fn custom_path(&self) -> Option<String> {
        self.config.cli_paths.helm_path.clone()
    }

    fn version_args(&self) -> Vec<&'static str> {
        vec!["version", "--short"]
    }

    fn parse_version(&self, output: &str) -> Option<String> {
        // Helm version --short returns a simple version string
        // Example: "v3.13.0+g825e86f"
        let version = output.trim();
        if version.is_empty() {
            None
        } else {
            Some(version.to_string())
        }
    }

    fn version_check_timeout(&self) -> Duration {
        Duration::from_secs(5)
    }

    fn default_timeout(&self) -> Duration {
        Duration::from_secs(30)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_helm_tool_properties() {
        let tool = HelmTool::with_default_config();
        assert_eq!(tool.name(), "helm");
        assert_eq!(tool.binary_name(), "helm");
        assert!(!tool.search_paths().is_empty());
        assert_eq!(tool.version_args(), vec!["version", "--short"]);
    }

    #[test]
    fn test_helm_parse_version() {
        let tool = HelmTool::with_default_config();

        // Test with valid version output
        let output = "v3.13.0+g825e86f\n";
        let version = tool.parse_version(output);
        assert_eq!(version, Some("v3.13.0+g825e86f".to_string()));

        // Test with whitespace
        let output = "  v3.12.0  \n";
        let version = tool.parse_version(output);
        assert_eq!(version, Some("v3.12.0".to_string()));

        // Test with empty output
        let output = "";
        let version = tool.parse_version(output);
        assert_eq!(version, None);

        // Test with just whitespace
        let output = "   \n  ";
        let version = tool.parse_version(output);
        assert_eq!(version, None);
    }

    #[test]
    fn test_helm_timeouts() {
        let tool = HelmTool::with_default_config();
        assert_eq!(tool.version_check_timeout(), Duration::from_secs(5));
        assert_eq!(tool.default_timeout(), Duration::from_secs(30));
    }
}
