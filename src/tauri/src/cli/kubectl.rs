//! kubectl CLI tool implementation.

use crate::cli::paths::PathResolver;
use crate::cli::tool::CliTool;
use crate::config::AppConfig;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

/// kubectl CLI tool implementation
pub struct KubectlTool {
    config: Arc<AppConfig>,
}

impl KubectlTool {
    /// Create a new kubectl tool instance
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

impl CliTool for KubectlTool {
    fn name(&self) -> &'static str {
        "kubectl"
    }

    fn binary_name(&self) -> &'static str {
        "kubectl"
    }

    fn search_paths(&self) -> Vec<PathBuf> {
        PathResolver::search_paths("kubectl")
    }

    fn custom_path(&self) -> Option<String> {
        self.config.cli_paths.kubectl_path.clone()
    }

    fn version_args(&self) -> Vec<&'static str> {
        vec!["version", "--client", "-o=yaml"]
    }

    fn parse_version(&self, output: &str) -> Option<String> {
        // Parse gitVersion from YAML output
        for line in output.lines() {
            if line.trim().starts_with("gitVersion:") {
                return Some(
                    line.trim()
                        .trim_start_matches("gitVersion:")
                        .trim()
                        .to_string(),
                );
            }
        }
        Some("unknown".to_string())
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
    fn test_kubectl_tool_properties() {
        let tool = KubectlTool::with_default_config();
        assert_eq!(tool.name(), "kubectl");
        assert_eq!(tool.binary_name(), "kubectl");
        assert!(!tool.search_paths().is_empty());
        assert_eq!(tool.version_args(), vec!["version", "--client", "-o=yaml"]);
    }

    #[test]
    fn test_kubectl_parse_version() {
        let tool = KubectlTool::with_default_config();

        // Test with valid YAML output
        let output = r#"
clientVersion:
  buildDate: "2024-01-01T00:00:00Z"
  compiler: gc
  gitCommit: abc123
  gitTreeState: clean
  gitVersion: v1.28.0
  goVersion: go1.21.0
  major: "1"
  minor: "28"
  platform: darwin/arm64
"#;
        let version = tool.parse_version(output);
        assert_eq!(version, Some("v1.28.0".to_string()));

        // Test with missing version
        let output = "no version here";
        let version = tool.parse_version(output);
        assert_eq!(version, Some("unknown".to_string()));
    }

    #[test]
    fn test_kubectl_timeouts() {
        let tool = KubectlTool::with_default_config();
        assert_eq!(tool.version_check_timeout(), Duration::from_secs(5));
        assert_eq!(tool.default_timeout(), Duration::from_secs(30));
    }
}
