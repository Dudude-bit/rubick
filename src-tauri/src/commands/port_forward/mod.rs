//! Pod port-forward commands.
//!
//! - `types`:   shared DTOs + helpers
//! - `session`: live port-forward session lifecycle (bind / accept /
//!   copy bytes via `kube::Api::portforward`) + the
//!   `PortForwardCleanup` Drop guard
//! - `config`:  saved-config CRUD over `AppConfig.port_forward`

mod config;
mod session;
mod types;

// Glob re-exports — see commands/crds/mod.rs.
pub use config::*;
pub use session::*;
pub use types::*;
