//! Tracing initialization utilities
//!
//! Provides a unified way to initialize tracing across all Rubick projects.

use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

/// Initialize tracing subscriber with default configuration
///
/// This function sets up the tracing subscriber with:
/// - Environment variable filter (RUST_LOG) or default "info" level
/// - Standard formatting layer
///
/// # Panics
///
/// This function will panic if tracing is already initialized.
pub fn init_tracing() {
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with(tracing_subscriber::fmt::layer())
        .init();
}
