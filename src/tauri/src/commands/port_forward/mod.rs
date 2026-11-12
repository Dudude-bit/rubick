//! Pod port-forward commands.
//!
//! - `types`:   shared DTOs + helpers
//! - `session`: live port-forward session lifecycle (bind / accept /
//!   copy bytes via `kube::Api::portforward`)
//! - `follow`:  which pod a forward points at, and moving it when that pod goes
//! - `config`:  saved-config CRUD over `AppConfig.port_forward`

mod config;
mod follow;
mod session;
mod types;

// Glob re-exports — see commands/crds/mod.rs.
pub use config::*;
pub use session::*;
pub use types::*;
