//! Error handling for Rubick application
//!
//! This module provides a comprehensive error type that covers all possible
//! error scenarios in the application, with proper conversion from library errors.
//!
//! The `Error` type implements the `ErrorExt` trait from `k8s_gui_common` for
//! consistent error handling across all Rubick projects.

use k8s_gui_common::ErrorExt;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Error message constants
pub mod messages {
    /// No cluster connected
    pub const NO_CLUSTER: &str = "No cluster connected";
    /// Client not found for context
    pub const NO_CLIENT: &str = "Client not found";
}

/// Application-wide result type
pub type Result<T> = std::result::Result<T, Error>;

/// Main error type for the Rubick application
#[derive(Error, Debug)]
pub enum Error {
    /// Kubernetes API errors
    #[error("Kubernetes API error: {0}")]
    KubeApi(#[from] kube::Error),

    /// Configuration errors
    #[error("Configuration error: {0}")]
    Config(String),

    /// Authentication errors
    #[error("Authentication error: {0}")]
    Auth(AuthError),

    /// Connection errors
    #[error("Connection error: {0}")]
    Connection(String),

    /// Resource not found
    #[error("Resource not found: {kind}/{name} in namespace {namespace}")]
    NotFound {
        kind: String,
        name: String,
        namespace: String,
    },

    /// Permission denied
    #[error("Permission denied: {0}")]
    PermissionDenied(String),

    /// Invalid input
    #[error("Invalid input: {0}")]
    InvalidInput(String),

    /// Serialization/Deserialization errors
    #[error("Serialization error: {0}")]
    Serialization(String),

    /// IO errors
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    /// Plugin errors
    #[error("Plugin error: {0}")]
    Plugin(PluginError),

    /// Terminal/Exec errors
    #[error("Terminal error: {0}")]
    Terminal(String),

    /// Log streaming errors
    #[error("Log streaming error: {0}")]
    LogStream(String),

    /// A previous run was asked for and there is not one.
    ///
    /// Its own variant rather than a `LogStream` string because the
    /// caller has to act on it differently: the container has never
    /// restarted, so there is no earlier log and nothing to retry. The
    /// apiserver phrases it as a 400 ending in "not found", which every
    /// generic rule in this codebase reads as "the pod is gone".
    #[error("No previous run: {container} has not restarted, so there is no earlier log")]
    NoPreviousRun { container: String },

    /// Cache errors
    #[error("Cache error: {0}")]
    Cache(String),

    /// Timeout errors
    #[error("Operation timed out: {0}")]
    Timeout(String),

    /// WebSocket errors
    #[error("WebSocket error: {0}")]
    WebSocket(String),

    /// Internal errors
    #[error("Internal error: {0}")]
    Internal(String),

    /// AWS errors
    #[error("AWS error: {0}")]
    Aws(String),
}

/// Authentication-specific errors
#[derive(Error, Debug, Clone, Serialize, Deserialize)]
pub enum AuthError {
    #[error("Invalid credentials")]
    InvalidCredentials,

    #[error("Token expired")]
    TokenExpired,

    #[error("Token refresh failed: {0}")]
    RefreshFailed(String),

    #[error("OIDC error: {0}")]
    Oidc(String),

    #[error("AWS authentication failed: {0}")]
    AwsAuth(String),

    #[error("GCP authentication failed: {0}")]
    GcpAuth(String),

    #[error("Azure authentication failed: {0}")]
    AzureAuth(String),

    #[error("Kubeconfig error: {0}")]
    Kubeconfig(String),

    #[error("Certificate error: {0}")]
    Certificate(String),

    #[error("Missing credentials")]
    MissingCredentials,
}

/// Plugin-specific errors
#[derive(Error, Debug, Clone, Serialize, Deserialize)]
pub enum PluginError {
    #[error("Plugin not found: {0}")]
    NotFound(String),

    #[error("Plugin load failed: {0}")]
    LoadFailed(String),

    #[error("Plugin execution failed: {0}")]
    ExecutionFailed(String),

    #[error("Plugin timeout")]
    Timeout,

    #[error("Invalid plugin format: {0}")]
    InvalidFormat(String),

    #[error("Plugin permission denied: {0}")]
    PermissionDenied(String),
}

impl Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        // Serialize as a string, not an object, so Tauri can properly convert it
        // This ensures errors are displayed correctly in the frontend
        serializer.serialize_str(&self.to_string())
    }
}

/// Implement ErrorExt trait for unified error handling
impl ErrorExt for Error {
    fn error_code(&self) -> &'static str {
        match self {
            Error::KubeApi(_) => "KUBE_API_ERROR",
            Error::Config(_) => "CONFIG_ERROR",
            Error::Auth(_) => "AUTH_ERROR",
            Error::Connection(_) => "CONNECTION_ERROR",
            Error::NotFound { .. } => "NOT_FOUND",
            Error::PermissionDenied(_) => "PERMISSION_DENIED",
            Error::InvalidInput(_) => "INVALID_INPUT",
            Error::Serialization(_) => "SERIALIZATION_ERROR",
            Error::Io(_) => "IO_ERROR",
            Error::Plugin(_) => "PLUGIN_ERROR",
            Error::Terminal(_) => "TERMINAL_ERROR",
            Error::LogStream(_) => "LOG_STREAM_ERROR",
            Error::NoPreviousRun { .. } => "NO_PREVIOUS_RUN",
            Error::Cache(_) => "CACHE_ERROR",
            Error::Timeout(_) => "TIMEOUT",
            Error::WebSocket(_) => "WEBSOCKET_ERROR",
            Error::Internal(_) => "INTERNAL_ERROR",
            Error::Aws(_) => "AWS_ERROR",
        }
    }

    fn details(&self) -> Option<String> {
        match self {
            Error::KubeApi(e) => Some(format!("{e:?}")),
            Error::NotFound {
                kind,
                name,
                namespace,
            } => Some(format!(
                "Kind: {kind}, Name: {name}, Namespace: {namespace}"
            )),
            Error::Auth(e) => Some(format!("{e:?}")),
            Error::Plugin(e) => Some(format!("{e:?}")),
            _ => None,
        }
    }

    fn is_retryable(&self) -> bool {
        matches!(
            self,
            Error::Connection(_) | Error::Timeout(_) | Error::Auth(AuthError::TokenExpired)
        )
    }
}

impl Error {
    /// Create a not found error
    ///
    /// # Arguments
    ///
    /// * `kind` - Kubernetes resource kind
    /// * `name` - Resource name
    /// * `namespace` - Resource namespace
    ///
    /// # Returns
    ///
    /// A new `Error::NotFound` variant.
    pub fn not_found(
        kind: impl Into<String>,
        name: impl Into<String>,
        namespace: impl Into<String>,
    ) -> Self {
        Error::NotFound {
            kind: kind.into(),
            name: name.into(),
            namespace: namespace.into(),
        }
    }
}

impl From<serde_json::Error> for Error {
    fn from(err: serde_json::Error) -> Self {
        Error::Serialization(err.to_string())
    }
}

impl From<serde_yaml::Error> for Error {
    fn from(err: serde_yaml::Error) -> Self {
        Error::Serialization(err.to_string())
    }
}

impl From<AuthError> for Error {
    fn from(err: AuthError) -> Self {
        Error::Auth(err)
    }
}

impl From<PluginError> for Error {
    fn from(err: PluginError) -> Self {
        Error::Plugin(err)
    }
}

impl From<reqwest::Error> for Error {
    fn from(err: reqwest::Error) -> Self {
        if err.is_timeout() {
            Error::Timeout(err.to_string())
        } else if err.is_connect() {
            Error::Connection(err.to_string())
        } else {
            Error::Internal(err.to_string())
        }
    }
}

impl From<tokio_tungstenite::tungstenite::Error> for Error {
    fn from(err: tokio_tungstenite::tungstenite::Error) -> Self {
        Error::WebSocket(err.to_string())
    }
}

impl From<url::ParseError> for Error {
    fn from(err: url::ParseError) -> Self {
        Error::InvalidInput(format!("Invalid URL: {err}"))
    }
}

impl From<base64::DecodeError> for Error {
    fn from(err: base64::DecodeError) -> Self {
        Error::Serialization(format!("Base64 decode error: {err}"))
    }
}

/// Implement From<Error> for String to work with Tauri commands
impl From<Error> for String {
    fn from(err: Error) -> Self {
        err.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_serialization() {
        let err = Error::not_found("Pod", "nginx", "default");
        let json = serde_json::to_string(&err).unwrap();
        // Error is serialized as its Display string
        assert!(json.contains("Resource not found"));
        assert!(json.contains("Pod"));
        assert!(json.contains("nginx"));
    }

    #[test]
    fn test_error_codes() {
        assert_eq!(Error::Config("test".into()).error_code(), "CONFIG_ERROR");
        assert_eq!(
            Error::Connection("test".into()).error_code(),
            "CONNECTION_ERROR"
        );
    }

    #[test]
    fn test_retryable() {
        assert!(Error::Connection("test".into()).is_retryable());
        assert!(Error::Timeout("test".into()).is_retryable());
        assert!(!Error::Config("test".into()).is_retryable());
    }

    #[test]
    fn test_error_to_string_conversion() {
        let err = Error::Config("test error".into());
        let s: String = err.into();
        assert!(s.contains("Configuration error"));
        assert!(s.contains("test error"));
    }
}
