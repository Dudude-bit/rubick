//! Common utilities for Rubick projects
//!
//! This crate provides shared functionality used across multiple
//! Rubick projects, including:
//!
//! - **Tracing**: Unified logging and tracing initialization
//! - **Validation**: Input validation (pagination)
//! - **Error handling**: Common error trait for consistent error handling
//! - **DTOs**: Shared data transfer objects for API consistency
//! - **DateTime**: Date and time formatting utilities

pub mod datetime;
pub mod dto;
pub mod error;
pub mod tracing;
pub mod validation;

// Re-export tracing utilities
pub use tracing::init_tracing;

// Re-export validation utilities
pub use validation::{validate_pagination, ValidationResult};

// Re-export error utilities
pub use error::ErrorExt;

// Re-export DTOs
pub use dto::MessageResponse;

// Re-export datetime utilities
pub use datetime::{format_age, format_duration, format_rfc3339, parse_rfc3339};
