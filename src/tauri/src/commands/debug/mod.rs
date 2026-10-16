//! Debug commands for kubectl debug functionality.
//!
//! Three debug modes:
//! - **Ephemeral Container**: Add a debug container to an existing pod
//! - **Copy Pod**: Create a copy of a pod with a debug container
//! - **Node Debug**: Create a privileged pod for node-level debugging
//!
//! Re-exports the shared types and Tauri command handlers; the
//! implementations live in `create` (the three creation commands),
//! `manage` (lifecycle commands), and `status` (pure pod-status
//! inspection helpers).

mod create;
mod manage;
mod status;
mod types;

// Glob re-exports — see commands/crds/mod.rs for why `pub use sub::*`
// is required to bring along the `__cmd__X` siblings that
// `#[tauri::command]` generates.
pub use create::*;
pub use manage::*;
pub use types::*;
