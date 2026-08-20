//! Rubick - A minimalist Kubernetes GUI client
//!
//! This application provides a modern, Lens-inspired interface for managing
//! Kubernetes clusters with support for multiple authentication methods.

#![warn(clippy::all, clippy::pedantic)]
#![allow(clippy::module_name_repetitions)]
// Every fallible function here returns the one `Error` from `error.rs`, and
// the only caller that ever sees it is Tauri's IPC layer, which hands it to
// `src/lib/commands.ts` to normalise. An `# Errors` section per function would
// restate that 252 times and tell a reader nothing the signature does not.
#![allow(clippy::missing_errors_doc)]

pub mod auth;
pub mod cli;
pub mod client;
pub mod commands;
pub mod config;
pub mod diagnostics;
pub mod error;
pub mod integrations;
pub mod logs;
pub mod metrics;
pub mod resources;
pub mod search;
pub mod shell;
pub mod state;
pub mod terminal;
pub mod utils;
pub mod validation;
pub mod watch;

pub use error::{Error, Result};
pub use state::AppState;
