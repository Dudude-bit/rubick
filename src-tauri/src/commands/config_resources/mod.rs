//! `ConfigMap` and Secret commands plus the cross-resource
//! "find references" scanner.
//!
//! - `data`:        the shared decode/withhold door both kinds read through
//! - `configmap`:   ConfigMap CRUD
//! - `secret`:      Secret CRUD (with redacted YAML)
//! - `references`:  scan workloads + ingresses for refs to a
//!                  given ConfigMap or Secret

mod configmap;
mod data;
mod references;
mod secret;

// Glob re-exports — see commands/crds/mod.rs.
pub use configmap::*;
pub use data::*;
pub use references::*;
pub use secret::*;
