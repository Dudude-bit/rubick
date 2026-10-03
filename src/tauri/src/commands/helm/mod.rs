//! Helm commands.
//!
//! Two distinct stacks:
//! - `secret` reads Helm-3 release secrets directly from the
//!   Kubernetes API (list / detail / history) — no helm binary
//!   required.
//! - `cli` shells out to the helm binary for everything that
//!   mutates state (install / upgrade / rollback / uninstall /
//!   repos / search) plus the search and `check_helm_availability`
//!   probe.
//!
//! `manager` owns the global `Lazy<Mutex<CliToolManager<HelmTool>>>`
//! singleton so `commands::settings` can call `reload_helm_manager`
//! when CLI paths change.

mod cli;
mod manager;
mod secret;
mod types;

// Glob re-exports — see commands/crds/mod.rs.
pub use cli::*;
pub use manager::*;
pub use secret::*;
pub use types::*;
