//! Plugin system for Rubick
//!
//! Supports two types of plugins:
//! - kubectl-compatible commands (executables with kubectl-* prefix)
//! - Context menu extensions for resources

mod kubectl;
mod manager;
mod traits;

pub use kubectl::*;
pub use manager::PluginManager;
pub use traits::*;

use serde::{Deserialize, Serialize};

/// Plugin metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginInfo {
    /// Plugin name
    pub name: String,
    /// Plugin type
    pub plugin_type: PluginType,
    /// Plugin version
    pub version: String,
    /// Description
    pub description: String,
    /// Author
    pub author: Option<String>,
    /// Plugin path (for kubectl plugins)
    pub path: Option<String>,
    /// Whether the plugin is enabled
    pub enabled: bool,
    /// Supported resource kinds (for context menu plugins)
    pub supported_resources: Vec<String>,
}

/// Plugin type
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginType {
    /// kubectl-compatible command plugin
    KubectlCommand,
    /// Context menu extension
    ContextMenu,
    /// Custom resource renderer
    ResourceRenderer,
}

/// Plugin execution result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginResult {
    /// Exit code (for command plugins)
    pub exit_code: Option<i32>,
    /// Standard output
    pub stdout: String,
    /// Standard error
    pub stderr: String,
    /// Structured output (optional)
    pub data: Option<serde_json::Value>,
}

impl PluginResult {
    /// Create a successful result
    #[must_use]
    pub fn success(stdout: String) -> Self {
        Self {
            exit_code: Some(0),
            stdout,
            stderr: String::new(),
            data: None,
        }
    }

    /// Create an error result
    #[must_use]
    pub fn error(stderr: String) -> Self {
        Self {
            exit_code: Some(1),
            stdout: String::new(),
            stderr,
            data: None,
        }
    }

    /// Add structured data
    #[must_use]
    pub fn with_data(mut self, data: serde_json::Value) -> Self {
        self.data = Some(data);
        self
    }

    /// Check if successful
    #[must_use]
    pub fn is_success(&self) -> bool {
        self.exit_code == Some(0)
    }
}
