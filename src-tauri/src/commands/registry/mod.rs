//! Container/image registry commands — credentials + image search.
//!
//! - `types`:  frontend DTOs + Docker `config.json` decoding shapes
//! - `auth`:   credential storage on `AppConfig` + `import_docker_config`
//! - `search`: per-provider image search dispatcher

mod auth;
mod search;
mod types;

// Glob re-exports — see commands/crds/mod.rs.
pub use auth::*;
pub use search::*;
pub use types::*;
