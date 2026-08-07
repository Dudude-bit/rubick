//! Tauri commands module
//!
//! This module exposes Rust functionality to the frontend via Tauri commands.

pub mod filters;
pub mod helpers;

pub mod auth;
pub mod cluster;
pub mod config_resources;
pub mod crds;
pub mod debug;
pub mod deployments;
pub mod events;
pub mod helm;
pub mod kubectl;
pub mod logging;
pub mod logs;
pub mod manifest;
pub mod metrics;
pub mod namespace;
pub mod network;
pub mod nodes;
pub mod overview;
pub mod pods;
pub mod port_forward;
pub mod registry;
pub mod resources;
pub mod search;
pub mod services;
pub mod settings;
pub mod stats;
pub mod storage;
pub mod terminal;
pub mod watch;
pub mod workloads;

// Re-export all commands for easy registration.
// These re-exports provide a convenient public API for command registration in main.rs.
pub use auth::*;
pub use cluster::*;
pub use config_resources::*;
pub use crds::*;
pub use debug::*;
pub use deployments::*;
pub use events::*;
pub use helm::*;
pub use kubectl::*;
pub use logging::*;
pub use logs::*;
pub use manifest::*;
pub use metrics::*;
pub use namespace::*;
pub use network::*;
pub use nodes::*;
pub use pods::*;
pub use port_forward::*;
pub use registry::*;
pub use resources::*;
pub use search::*;
pub use services::*;
pub use settings::*;
pub use stats::*;
pub use storage::*;
pub use terminal::*;
pub use workloads::*;

/// Debug command to check PATH and discovered plugins
#[tauri::command]
pub async fn debug_kubectl_plugins() -> std::result::Result<serde_json::Value, String> {
    use crate::plugins::KubectlPluginManager;

    let shell_path = crate::shell::get_user_path();
    let process_path = std::env::var("PATH").unwrap_or_default();

    let mut manager = KubectlPluginManager::new();
    let plugins = manager.discover().unwrap_or_default();

    let plugin_names: Vec<String> = plugins.iter().map(|p| p.name.clone()).collect();

    Ok(serde_json::json!({
        "shellPath": shell_path,
        "processPath": process_path,
        "shellPathEntryCount": shell_path.split(':').filter(|s| !s.is_empty()).count(),
        "processPathEntryCount": process_path.split(':').filter(|s| !s.is_empty()).count(),
        "discoveredPlugins": plugin_names,
        "hasOidcLogin": plugin_names.iter().any(|name| name.contains("oidc")),
    }))
}
