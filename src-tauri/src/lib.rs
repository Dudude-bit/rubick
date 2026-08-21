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
// What this crate casts is a collection length into the sized integer a DTO
// field declares, a byte count into f64 for the percentage arithmetic a panel
// shows, or an exit code. None of them can reach the value where the
// conversion would round or wrap: a page of log lines does not hold four
// billion entries and a cluster does not report exabytes. `utils::quantities`
// carries its own note about the arithmetic it does.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss,
    clippy::cast_possible_wrap
)]
// The functions over 100 lines are one long match over event or kind variants,
// or one sequential procedure — starting an exec-auth flow, opening a
// port-forward, building a terminal session. Cutting them at an arbitrary line
// count would hand the reader more names to hold, not fewer, and these are the
// paths where a mistake costs the most.
#![allow(clippy::too_many_lines)]

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
