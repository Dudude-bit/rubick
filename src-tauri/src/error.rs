//! Error handling for Rubick application
//!
//! This module provides a comprehensive error type that covers all possible
//! error scenarios in the application, with proper conversion from library errors.
//!
//! An `Error` reaches the frontend as its `Display` string and nothing else —
//! see the custom `Serialize` impl below, and the wire-format note in
//! `src/lib/credentials.ts`.

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
    // `#[source]` is explicit because the `#[from]` that used to imply it is
    // gone: the conversion now branches on the status code, and the search
    // fan-out walks this chain to find the sentence a reader can act on.
    KubeApi(#[source] kube::Error),

    /// The cluster no longer accepts the credentials this session holds.
    ///
    /// Its own variant rather than a `KubeApi` string, and deliberately not
    /// `PermissionDenied`: a 403 is an answer about *one* request and the rest
    /// of the session still works, while a 401 means the token the client was
    /// built with is not accepted for anything. That is not a rare state — a
    /// GKE token lasts about an hour, `prepare_kubeconfig_for_context` strips
    /// the `exec` block that could renew it, and nothing renews it afterwards.
    ///
    /// Errors cross to the frontend as their `Display` string and nothing
    /// else, so this sentence *is* the wire format: `CREDENTIALS_EXPIRED` is
    /// matched on there. Changing the prefix changes an API.
    #[error("CREDENTIALS_EXPIRED: the cluster rejected this session's credentials — {0}")]
    CredentialsExpired(String),

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

    /// Timeout errors
    #[error("Operation timed out: {0}")]
    Timeout(String),

    /// WebSocket errors
    #[error("WebSocket error: {0}")]
    WebSocket(String),

    /// Internal errors
    #[error("Internal error: {0}")]
    Internal(String),
}

/// Authentication-specific errors
#[derive(Error, Debug, Clone, Serialize, Deserialize)]
pub enum AuthError {
    #[error("Token refresh failed: {0}")]
    RefreshFailed(String),

    #[error("OIDC error: {0}")]
    Oidc(String),

    #[error("GCP authentication failed: {0}")]
    GcpAuth(String),

    #[error("Azure authentication failed: {0}")]
    AzureAuth(String),

    #[error("Kubeconfig error: {0}")]
    Kubeconfig(String),
}

/// Plugin-specific errors
#[derive(Error, Debug, Clone, Serialize, Deserialize)]
pub enum PluginError {
    #[error("Plugin not found: {0}")]
    NotFound(String),

    #[error("Plugin execution failed: {0}")]
    ExecutionFailed(String),
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

/// A 401 is the one API error that is about the session rather than the
/// request, so it is the one that does not become `KubeApi`.
///
/// Everything else keeps the shape it always had. `reason` is checked as well
/// as the code because a token the apiserver cannot verify at all comes back
/// as `Unauthorized` with the code unset on some distributions.
impl From<kube::Error> for Error {
    fn from(err: kube::Error) -> Self {
        if let kube::Error::Api(response) = &err {
            if response.code == 401 || response.reason == "Unauthorized" {
                return Error::CredentialsExpired(response.message.clone());
            }
        }
        Error::KubeApi(err)
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

impl Error {
    /// Whether the cluster refused this request, rather than failing at it.
    ///
    /// A 403 arrives as `KubeApi` and stays there on purpose — folding it into
    /// its own variant would say the session is over when only one request was
    /// answered. So the question has to be asked of the response code, and a
    /// caller that matched `PermissionDenied` instead would match nothing at
    /// all: that variant exists for refusals the app itself raises.
    #[must_use]
    pub fn is_refusal(&self) -> bool {
        match self {
            Error::PermissionDenied(_) => true,
            Error::KubeApi(kube::Error::Api(response)) => response.code == 403,
            _ => false,
        }
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

    fn api_error(code: u16, reason: &str) -> kube::Error {
        kube::Error::Api(kube::core::ErrorResponse {
            status: "Failure".to_string(),
            message: "the server has asked for the client to provide credentials".to_string(),
            reason: reason.to_string(),
            code,
        })
    }

    /// Would send the reader back to a screen that says the cluster is empty.
    /// A 401 is the session being over, not an answer about one request, and
    /// the frontend can only tell from this sentence — errors cross the IPC
    /// boundary as their `Display` string and nothing else.
    #[test]
    fn a_401_is_expired_credentials_and_says_so_on_the_wire() {
        let err = Error::from(api_error(401, "Unauthorized"));
        assert!(matches!(err, Error::CredentialsExpired(_)));
        assert!(err.to_string().starts_with("CREDENTIALS_EXPIRED:"));
    }

    /// A 403 answers *this* request and leaves the session working. Folding it
    /// in here would throw the reader out of a cluster they are still using
    /// every time they opened one thing their token cannot read.
    #[test]
    fn a_403_is_not_expired_credentials() {
        assert!(matches!(
            Error::from(api_error(403, "Forbidden")),
            Error::KubeApi(_)
        ));
    }

    /// The other half of the rule above. A 403 stays a `KubeApi`, so anything
    /// that wants to know "was this refused" has to ask the code — matching
    /// `PermissionDenied` would match nothing a cluster ever sends, which is
    /// how a screen came to report a refusal as a hard failure.
    #[test]
    fn a_403_is_a_refusal_however_it_is_filed() {
        assert!(Error::from(api_error(403, "Forbidden")).is_refusal());
        assert!(Error::PermissionDenied("ours".into()).is_refusal());
        assert!(!Error::from(api_error(401, "Unauthorized")).is_refusal());
        assert!(!Error::from(api_error(500, "InternalError")).is_refusal());
        assert!(!Error::Config("nothing to do with rights".into()).is_refusal());
    }

    #[test]
    fn test_error_to_string_conversion() {
        let err = Error::Config("test error".into());
        let s: String = err.into();
        assert!(s.contains("Configuration error"));
        assert!(s.contains("test error"));
    }
}
