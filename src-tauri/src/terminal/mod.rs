//! Terminal module for exec/shell access
//!
//! Provides interactive terminal sessions inside Kubernetes containers.

pub mod adapter;
pub mod adapters;
pub mod manager;
pub mod session;

pub use adapter::TerminalAdapter;
pub use adapters::{AuthExecAdapter, PodExecAdapter};
pub use manager::TerminalManager;
