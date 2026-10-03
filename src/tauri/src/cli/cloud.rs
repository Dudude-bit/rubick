//! Cloud provider CLI tool implementations (gcloud, az).

use crate::cli::paths::PathResolver;
use crate::cli::tool::CliTool;
use std::path::PathBuf;
use std::time::Duration;

/// Google Cloud CLI (gcloud) tool implementation
pub struct GcloudTool;

impl GcloudTool {
    /// Create a new gcloud tool instance
    #[must_use]
    pub fn new() -> Self {
        Self
    }
}

impl Default for GcloudTool {
    fn default() -> Self {
        Self::new()
    }
}

impl CliTool for GcloudTool {
    fn name(&self) -> &'static str {
        "gcloud"
    }

    fn binary_name(&self) -> &'static str {
        "gcloud"
    }

    fn search_paths(&self) -> Vec<PathBuf> {
        let mut paths = PathResolver::search_paths("gcloud");

        // Add Google Cloud SDK specific paths
        if let Some(home) = dirs::home_dir() {
            paths.insert(0, home.join("google-cloud-sdk/bin/gcloud"));
        }

        paths
    }

    fn custom_path(&self) -> Option<String> {
        None // Could be added to config later
    }

    fn version_args(&self) -> Vec<&'static str> {
        vec!["version", "--format=value(version)"]
    }

    fn parse_version(&self, output: &str) -> Option<String> {
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

/// GKE gcloud auth plugin tool implementation
pub struct GkeAuthPluginTool;

impl GkeAuthPluginTool {
    /// Create a new gke-gcloud-auth-plugin tool instance
    #[must_use]
    pub fn new() -> Self {
        Self
    }
}

impl Default for GkeAuthPluginTool {
    fn default() -> Self {
        Self::new()
    }
}

impl CliTool for GkeAuthPluginTool {
    fn name(&self) -> &'static str {
        "gke-gcloud-auth-plugin"
    }

    fn binary_name(&self) -> &'static str {
        "gke-gcloud-auth-plugin"
    }

    fn search_paths(&self) -> Vec<PathBuf> {
        let mut paths = PathResolver::search_paths("gke-gcloud-auth-plugin");

        // Add Google Cloud SDK specific paths
        if let Some(home) = dirs::home_dir() {
            paths.insert(0, home.join("google-cloud-sdk/bin/gke-gcloud-auth-plugin"));
        }

        paths
    }

    fn custom_path(&self) -> Option<String> {
        None
    }

    fn version_args(&self) -> Vec<&'static str> {
        vec!["--version"]
    }

    fn parse_version(&self, output: &str) -> Option<String> {
        // gke-gcloud-auth-plugin outputs version on first line
        output.lines().next().map(|s| s.trim().to_string())
    }

    fn version_check_timeout(&self) -> Duration {
        Duration::from_secs(5)
    }

    fn default_timeout(&self) -> Duration {
        Duration::from_secs(30)
    }
}

/// Azure CLI (az) tool implementation
pub struct AzTool;

impl AzTool {
    /// Create a new az tool instance
    #[must_use]
    pub fn new() -> Self {
        Self
    }
}

impl Default for AzTool {
    fn default() -> Self {
        Self::new()
    }
}

impl CliTool for AzTool {
    fn name(&self) -> &'static str {
        "az"
    }

    fn binary_name(&self) -> &'static str {
        "az"
    }

    fn search_paths(&self) -> Vec<PathBuf> {
        PathResolver::search_paths("az")
    }

    fn custom_path(&self) -> Option<String> {
        None // Could be added to config later
    }

    fn version_args(&self) -> Vec<&'static str> {
        vec!["version", "--output", "json"]
    }

    fn parse_version(&self, output: &str) -> Option<String> {
        // az version outputs JSON, extract version field
        // Example: {"azure-cli": "2.54.0", ...}
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(output) {
            json.get("azure-cli")
                .and_then(|v| v.as_str())
                .map(std::string::ToString::to_string)
        } else {
            None
        }
    }

    fn version_check_timeout(&self) -> Duration {
        Duration::from_secs(5)
    }

    fn default_timeout(&self) -> Duration {
        Duration::from_secs(30)
    }
}

/// Azure kubelogin tool implementation
pub struct KubeloginTool;

impl KubeloginTool {
    /// Create a new kubelogin tool instance
    #[must_use]
    pub fn new() -> Self {
        Self
    }
}

impl Default for KubeloginTool {
    fn default() -> Self {
        Self::new()
    }
}

impl CliTool for KubeloginTool {
    fn name(&self) -> &'static str {
        "kubelogin"
    }

    fn binary_name(&self) -> &'static str {
        "kubelogin"
    }

    fn search_paths(&self) -> Vec<PathBuf> {
        PathResolver::search_paths("kubelogin")
    }

    fn custom_path(&self) -> Option<String> {
        None
    }

    fn version_args(&self) -> Vec<&'static str> {
        vec!["--version"]
    }

    fn parse_version(&self, output: &str) -> Option<String> {
        // kubelogin outputs version on first line
        output.lines().next().map(|s| s.trim().to_string())
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
    fn test_gcloud_tool_properties() {
        let tool = GcloudTool::new();
        assert_eq!(tool.name(), "gcloud");
        assert_eq!(tool.binary_name(), "gcloud");
        assert!(!tool.search_paths().is_empty());
        assert_eq!(
            tool.version_args(),
            vec!["version", "--format=value(version)"]
        );
    }

    #[test]
    fn test_gcloud_parse_version() {
        let tool = GcloudTool::new();

        let output = "451.0.0\n";
        let version = tool.parse_version(output);
        assert_eq!(version, Some("451.0.0".to_string()));

        let output = "";
        let version = tool.parse_version(output);
        assert_eq!(version, None);
    }

    #[test]
    fn test_gke_auth_plugin_tool_properties() {
        let tool = GkeAuthPluginTool::new();
        assert_eq!(tool.name(), "gke-gcloud-auth-plugin");
        assert_eq!(tool.binary_name(), "gke-gcloud-auth-plugin");
        assert!(!tool.search_paths().is_empty());
    }

    #[test]
    fn test_az_tool_properties() {
        let tool = AzTool::new();
        assert_eq!(tool.name(), "az");
        assert_eq!(tool.binary_name(), "az");
        assert!(!tool.search_paths().is_empty());
        assert_eq!(tool.version_args(), vec!["version", "--output", "json"]);
    }

    #[test]
    fn test_az_parse_version() {
        let tool = AzTool::new();

        let output = r#"{"azure-cli": "2.54.0", "azure-cli-core": "2.54.0"}"#;
        let version = tool.parse_version(output);
        assert_eq!(version, Some("2.54.0".to_string()));

        let output = "invalid json";
        let version = tool.parse_version(output);
        assert_eq!(version, None);
    }

    #[test]
    fn test_kubelogin_tool_properties() {
        let tool = KubeloginTool::new();
        assert_eq!(tool.name(), "kubelogin");
        assert_eq!(tool.binary_name(), "kubelogin");
        assert!(!tool.search_paths().is_empty());
    }

    #[test]
    fn test_cloud_tool_timeouts() {
        let gcloud = GcloudTool::new();
        assert_eq!(gcloud.version_check_timeout(), Duration::from_secs(5));
        assert_eq!(gcloud.default_timeout(), Duration::from_secs(30));

        let az = AzTool::new();
        assert_eq!(az.version_check_timeout(), Duration::from_secs(5));
        assert_eq!(az.default_timeout(), Duration::from_secs(30));
    }
}
