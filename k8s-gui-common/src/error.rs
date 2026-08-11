//! Error handling utilities
//!
//! This module provides common error handling traits and utilities
//! used across all Rubick projects. It defines a unified interface
//! for error types, ensuring consistent error handling patterns.

/// Extension trait for error types
///
/// This trait provides a unified interface for error handling across
/// all Rubick projects. Implement this trait on your error types
/// to enable consistent error code retrieval, detail extraction,
/// and retry logic.
///
/// # Examples
///
/// ```ignore
/// use k8s_gui_common::error::ErrorExt;
///
/// impl ErrorExt for MyError {
///     fn error_code(&self) -> &'static str {
///         match self {
///             MyError::NotFound(_) => "NOT_FOUND",
///             MyError::Internal(_) => "INTERNAL_ERROR",
///         }
///     }
///
///     fn details(&self) -> Option<String> {
///         Some(format!("{:?}", self))
///     }
///
///     fn is_retryable(&self) -> bool {
///         matches!(self, MyError::Internal(_))
///     }
/// }
/// ```
pub trait ErrorExt: std::error::Error {
    /// Get error code for frontend handling
    ///
    /// Returns a static string representing the error code.
    /// This code can be used by the frontend to determine
    /// how to handle the error (e.g., show specific UI elements).
    fn error_code(&self) -> &'static str;

    /// Get additional details for debugging
    ///
    /// Returns `Some(String)` with detailed error information if available,
    /// or `None` if no additional details are available.
    fn details(&self) -> Option<String>;

    /// Check if error is retryable
    ///
    /// Returns `true` if the operation that caused this error can be safely retried,
    /// `false` otherwise. This is useful for implementing retry logic.
    fn is_retryable(&self) -> bool;
}

#[cfg(test)]
mod tests {
    use super::*;
    use thiserror::Error;

    #[derive(Error, Debug)]
    enum TestError {
        #[error("Test error: {0}")]
        Test(String),
        #[error("Retryable error")]
        Retryable,
    }

    impl ErrorExt for TestError {
        fn error_code(&self) -> &'static str {
            match self {
                TestError::Test(_) => "TEST_ERROR",
                TestError::Retryable => "RETRYABLE_ERROR",
            }
        }

        fn details(&self) -> Option<String> {
            match self {
                TestError::Test(msg) => Some(msg.clone()),
                TestError::Retryable => None,
            }
        }

        fn is_retryable(&self) -> bool {
            matches!(self, TestError::Retryable)
        }
    }

    #[test]
    fn test_error_ext_trait() {
        let error = TestError::Test("test message".to_string());
        assert_eq!(error.error_code(), "TEST_ERROR");
        assert_eq!(error.details(), Some("test message".to_string()));
        assert!(!error.is_retryable());

        let retryable = TestError::Retryable;
        assert_eq!(retryable.error_code(), "RETRYABLE_ERROR");
        assert!(retryable.is_retryable());
    }
}


