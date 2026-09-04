//! Tauri commands module
//!
//! This module exposes Rust functionality to the frontend via Tauri commands.

// A `#[tauri::command]` receives its arguments already deserialised from the
// IPC message, so the macro requires them owned. Taking a borrow here is not
// something a caller could satisfy — the caller is the frontend.
#![allow(clippy::needless_pass_by_value)]
// A command declared `async` is spawned onto the async runtime; a synchronous
// one runs on the main thread and blocks the window while it works. Several
// commands here take the keyword for that reason alone and never await —
// `subscribe_namespaced!` says so in as many words.
#![allow(clippy::unused_async)]

pub mod filters;
pub mod helpers;

pub mod access;
pub mod auth;
pub mod binaries;
pub mod certificates;
pub mod cluster;
pub mod config_resources;
pub mod connections;
pub mod crds;
pub mod debug;
pub mod deployments;
pub mod diagnostics;
pub mod events;
pub mod gateway;
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
pub mod replicasets;
pub mod search;
pub mod services;
pub mod settings;
pub mod storage;
pub mod terminal;
pub mod watch;
pub mod workloads;

// Re-export all commands for easy registration.
// These re-exports provide a convenient public API for command registration in main.rs.
pub use auth::*;
pub use binaries::*;
pub use certificates::*;
pub use cluster::*;
pub use config_resources::*;
pub use connections::*;
pub use crds::*;
pub use debug::*;
pub use deployments::*;
pub use events::*;
pub use gateway::*;
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
pub use replicasets::*;
pub use search::*;
pub use services::*;
pub use settings::*;
pub use storage::*;
pub use terminal::*;
pub use workloads::*;
