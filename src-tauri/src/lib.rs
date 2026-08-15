//! Rubick - A minimalist Kubernetes GUI client
//!
//! This application provides a modern, Lens-inspired interface for managing
//! Kubernetes clusters with support for multiple authentication methods
//! and an extensible plugin system.

#![warn(clippy::all, clippy::pedantic)]
#![allow(clippy::module_name_repetitions)]

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
pub mod plugins;
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
