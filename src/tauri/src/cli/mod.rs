//! Unified CLI tool infrastructure.
//!
//! This module provides a generic abstraction for managing CLI tools
//! (kubectl, helm, gcloud, az, etc.) with consistent path resolution,
//! availability checking, and plugin discovery.
//!
//! # Architecture
//!
//! - **`CliTool` trait**: Define a new CLI tool by implementing this trait
//! - **`CliToolManager<T>`**: Generic manager for any CLI tool
//! - **`PathResolver`**: Platform-agnostic path utilities
//! - **`PluginDiscovery`**: Generic plugin discovery for CLI tools
//!
//! # Examples
//!
//! ## Implementing a new CLI tool
//!
//! ```text
//! use std::path::PathBuf;
//! use std::time::Duration;
//! use k8s_gui_lib::cli::{CliTool, CliToolManager, paths::PathResolver};
//!
//! struct MyTool;
//!
//! impl CliTool for MyTool {
//!     fn name(&self) -> &'static str { "mytool" }
//!     fn binary_name(&self) -> &'static str { "mytool" }
//!     fn search_paths(&self) -> Vec<PathBuf> {
//!         PathResolver::search_paths("mytool")
//!     }
//!     fn custom_path(&self) -> Option<String> { None }
//!     fn version_args(&self) -> Vec<&'static str> { vec!["--version"] }
//!     fn parse_version(&self, output: &str) -> Option<String> {
//!         output.lines().next().map(|s| s.to_string())
//!     }
//! }
//!
//! // Create a manager
//! let manager = CliToolManager::new(MyTool);
//! ```
//!
//! ## Discovering plugins
//!
//! ```text
//! use k8s_gui_lib::cli::plugins::PluginDiscovery;
//!
//! let mut discovery = PluginDiscovery::new("kubectl-");
//! if let Ok(plugins) = discovery.discover() {
//!     for plugin in plugins {
//!         println!("Found plugin: {} at {:?}", plugin.name, plugin.path);
//!     }
//! }
//! ```

pub mod cloud;
pub mod helm;
pub mod kubectl;
pub mod paths;
pub mod plugins;
pub mod tool;

// Re-export main types
pub use paths::PathResolver;
pub use plugins::{PluginDiscovery, PluginInfo};
pub use tool::{CliAvailability, CliTool, CliToolManager};
