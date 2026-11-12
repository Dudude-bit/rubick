//! `ConfigMap` and Secret commands.
//!
//! - `data`:        the shared decode/withhold door both kinds read through
//! - `configmap`:   `ConfigMap` CRUD
//! - `secret`:      Secret CRUD

mod configmap;
mod data;
mod secret;

// Glob re-exports — see commands/crds/mod.rs.
pub use configmap::*;
pub use data::*;
pub use secret::*;
