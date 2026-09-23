//! Error handling for Rubick application
//!
//! An `Error` reaches the frontend as `{ code, message }`: a code from
//! `shared/error-codes.json` and its `Display` string — see the custom
//! `Serialize` impl below, and the wire-format note in `src/lib/credentials.ts`.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Error message constants
pub mod messages {
    /// No cluster connected
    pub const NO_CLUSTER: &str = "No cluster connected";
}

/// Application-wide result type
pub type Result<T> = std::result::Result<T, Error>;

/// Main error type for the Rubick application
#[derive(Error, Debug)]
pub enum Error {
    /// Kubernetes API errors
    #[error("Kubernetes API error: {}", .0.display_clean())]
    // `#[source]` is explicit because the `#[from]` that used to imply it is
    // gone: the conversion now branches on the status code, and the search
    // fan-out walks this chain to find the sentence a reader can act on.
    // `display_clean` rather than the plain `Display`: kube 4 appends the whole
    // `Status` struct's `Debug` to an API error, and that dump reaches the
    // reader — see `KubeErrorExt` below.
    KubeApi(#[source] kube::Error),

    /// The cluster no longer accepts the credentials this session holds.
    ///
    /// Its own variant rather than a `KubeApi` string, and deliberately not
    /// `PermissionDenied`: a 403 answers *one* request and the rest of the
    /// session still works, while a 401 means the token the client was built
    /// with is accepted for nothing. Not a rare state — a GKE token lasts
    /// about an hour, `prepare_kubeconfig_for_context` strips the `exec` block
    /// that could renew it. `auth::renew` runs the plugin again before the
    /// deadline where there is one; this is what a session it could not save
    /// ends as.
    ///
    /// This sentence *is* the wire format: the frontend matches on the
    /// `CREDENTIALS_EXPIRED` prefix, so changing it changes an API.
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
    /// Its own variant rather than a `LogStream` string because the caller
    /// acts on it differently: the container has never restarted, so there is
    /// no earlier log and nothing to retry. The apiserver phrases it as a 400
    /// ending in "not found", which every generic rule here reads as "the pod
    /// is gone".
    #[error("No previous run: {container} has not restarted, so there is no earlier log")]
    NoPreviousRun { container: String },

    /// The list an object would have been found in could not be read, so
    /// whether it exists is unknown.
    ///
    /// Deliberately not `NotFound`, which asserts the cluster does not have
    /// it. A token refused `services` used to be told the Service it was
    /// looking at did not exist, which sends a person to rebuild something
    /// that is running.
    #[error("Could not read the {kind} list, so whether {name} is there is unknown: {said}")]
    ListUnread {
        kind: String,
        name: String,
        said: String,
    },
    /// The run happened and the node dropped its log: not `NoPreviousRun`,
    /// and the kubelet says it with a 200, so only the body tells.
    #[error("The node no longer has the log of {container}: {said}")]
    LogNotKept { container: String, said: String },

    /// Timeout errors
    #[error("Operation timed out: {0}")]
    Timeout(String),

    /// The cluster did not answer a request within the read deadline.
    ///
    /// Its own variant, and not `Timeout`, because the frontend acts on it:
    /// a list that ran out of time on a large cluster is offered a narrower
    /// scope before it is offered a retry. The `READ_DEADLINE:` prefix is the
    /// wire format the frontend matches, the way `CREDENTIALS_EXPIRED:` is,
    /// beside the `READ_DEADLINE` code.
    #[error("READ_DEADLINE: the cluster did not answer within {after_secs} s")]
    ReadDeadline { after_secs: u64 },

    /// The current context has no live client: disconnected, or between two
    /// connections. It used to read "Client not found", and every matcher on
    /// "not found" drew the object on screen as deleted.
    #[error("Not connected to {0}")]
    NotConnected(String),

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

    /// The credential plugin wants a person, and this attempt had none. Its
    /// own variant rather than a sentence to match on: `auth::renew` tells a
    /// coming sign-in from a failed read by it.
    #[error("Needs a sign-in: {0}")]
    NeedsPerson(String),
}

/// Plugin-specific errors
#[derive(Error, Debug, Clone, Serialize, Deserialize)]
pub enum PluginError {
    #[error("Plugin not found: {0}")]
    NotFound(String),

    #[error("Plugin execution failed: {0}")]
    ExecutionFailed(String),
}

/// `{ code, message }`: the variant as a code the frontend switches on,
/// and the `Display` string unchanged — the `CREDENTIALS_EXPIRED:` and
/// `READ_DEADLINE:` prefixes in it are still a wire format.
impl Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut wire = serializer.serialize_struct("Error", 2)?;
        wire.serialize_field("code", self.code())?;
        wire.serialize_field("message", &self.to_string())?;
        wire.end()
    }
}

impl Error {
    /// What the frontend switches on instead of reading the sentence. One of
    /// `shared/error-codes.json`.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Error::KubeApi(kube::Error::Api(response))
                if response.code == 403 || response.reason == "Forbidden" =>
            {
                "PERMISSION_DENIED"
            }
            Error::KubeApi(kube::Error::Api(response))
                if response.code == 404 || response.reason == "NotFound" =>
            {
                "NOT_FOUND"
            }
            Error::KubeApi(_) => "KUBE_API_ERROR",
            Error::CredentialsExpired(_) => "CREDENTIALS_EXPIRED",
            Error::Config(_) => "CONFIG_ERROR",
            Error::Auth(_) => "AUTH_ERROR",
            Error::Connection(_) => "NETWORK_ERROR",
            Error::NotFound { .. } => "NOT_FOUND",
            Error::PermissionDenied(_) => "PERMISSION_DENIED",
            Error::InvalidInput(_) => "VALIDATION_ERROR",
            Error::Serialization(_) | Error::Io(_) | Error::Internal(_) => "INTERNAL_ERROR",
            Error::Plugin(_) => "PLUGIN_ERROR",
            Error::Terminal(_) => "TERMINAL_ERROR",
            Error::LogStream(_) => "LOG_STREAM_ERROR",
            Error::NoPreviousRun { .. } => "NO_PREVIOUS_RUN",
            Error::ListUnread { .. } => "LIST_UNREAD",
            Error::LogNotKept { .. } => "LOG_NOT_KEPT",
            Error::Timeout(_) => "TIMEOUT_ERROR",
            Error::ReadDeadline { .. } => "READ_DEADLINE",
            Error::NotConnected(_) => "NOT_CONNECTED",
        }
    }

    /// Create a not found error
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
        if let kube::Error::Service(inner) = &err {
            if ran_out_of_time(inner.as_ref()) {
                return Error::ReadDeadline {
                    after_secs: crate::client::READ_DEADLINE.as_secs(),
                };
            }
        }
        Error::KubeApi(err)
    }
}

/// Whether the timeout layer fired, wherever in the stack its error sits.
///
/// The layer's `Elapsed` is boxed on the way out, and tower's buffer wraps
/// it once more before kube sees it, so it is looked for down the `source`
/// chain rather than at the top.
fn ran_out_of_time(err: &(dyn std::error::Error + 'static)) -> bool {
    let mut cursor = Some(err);
    while let Some(current) = cursor {
        if current.is::<tower::timeout::error::Elapsed>() {
            return true;
        }
        cursor = current.source();
    }
    false
}

/// The one sentence in a kube error a reader can act on.
///
/// kube 4 made `Error::Api` carry a boxed `Status`, and its `Display` now ends
/// with that struct's `Debug` — `pods is forbidden: … Forbidden (Status {
/// status: Some(Failure), metadata: Some(ListMeta { … }), details: … })`. The
/// tail is a wall of `None`s no reader wants, and it crosses the IPC boundary
/// onto the screen. Rebuild the message from the status; leave every other
/// kube error exactly as it displays.
trait KubeErrorExt {
    fn display_clean(&self) -> String;
}

impl KubeErrorExt for kube::Error {
    fn display_clean(&self) -> String {
        match self {
            kube::Error::Api(status) if !status.reason.is_empty() => {
                format!("ApiError: {}: {}", status.message, status.reason)
            }
            kube::Error::Api(status) => format!("ApiError: {}", status.message),
            other => other.to_string(),
        }
    }
}

/// A watcher's failure in the same words, `Status` dump left off.
pub(crate) fn watch_failure(error: &kube::runtime::watcher::Error) -> String {
    use kube::runtime::watcher::Error as Watch;
    match error {
        Watch::InitialListFailed(e) => format!(
            "failed to perform initial object list: {}",
            e.display_clean()
        ),
        Watch::WatchStartFailed(e) => {
            format!("failed to start watching object: {}", e.display_clean())
        }
        Watch::WatchFailed(e) => format!("watch stream failed: {}", e.display_clean()),
        Watch::WatchError(status) => {
            format!(
                "error returned by apiserver during watch: {}",
                status.message
            )
        }
        other @ Watch::NoResourceVersion => other.to_string(),
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
    /// A 403 arrives as `KubeApi` and stays there on purpose — its own variant
    /// would say the session is over when only one request was answered. So
    /// the question is asked of the response, and of `reason` as well as
    /// `code` for the same reason the 401 path above does: some distributions
    /// send `Forbidden` with the code unset, and code alone would then read a
    /// refusal as a hard failure. A caller matching `PermissionDenied` would
    /// match nothing a cluster sends — that variant is for refusals the app
    /// itself raises.
    #[must_use]
    pub fn is_refusal(&self) -> bool {
        match self {
            Error::PermissionDenied(_) => true,
            Error::KubeApi(kube::Error::Api(response)) => {
                response.code == 403 || response.reason == "Forbidden"
            }
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Would break the frontend twice over: a `message` that is no longer the
    /// Display string loses the wire-format prefixes, and a missing `code`
    /// sends it back to reading "not found" out of the sentence.
    #[test]
    fn an_error_crosses_as_its_code_and_its_sentence() {
        let err = Error::not_found("Pod", "nginx", "default");
        let wire = serde_json::to_value(&err).unwrap();
        assert_eq!(wire["code"], "NOT_FOUND");
        assert_eq!(wire["message"], err.to_string());
    }

    /// A refused list is not a missing object, and a previous run that never
    /// happened is not a deleted pod: both used to read as "not found" to
    /// every substring match on the frontend.
    #[test]
    fn codes_tell_apart_what_the_sentences_blur() {
        assert_eq!(
            Error::from(api_error(403, "Forbidden")).code(),
            "PERMISSION_DENIED"
        );
        assert_eq!(Error::from(api_error(404, "NotFound")).code(), "NOT_FOUND");
        assert_eq!(
            Error::from(api_error(500, "InternalError")).code(),
            "KUBE_API_ERROR"
        );
        assert_eq!(
            Error::NoPreviousRun {
                container: "app".into()
            }
            .code(),
            "NO_PREVIOUS_RUN"
        );
        assert_eq!(
            Error::ListUnread {
                kind: "Service".into(),
                name: "web".into(),
                said: "forbidden".into()
            }
            .code(),
            "LIST_UNREAD"
        );
    }

    /// Would let the two sides drift: a code Rust sends that the frontend's
    /// table does not know reads as an unknown error there.
    #[test]
    fn every_code_is_in_the_shared_list() {
        const LIST: &str = include_str!("../../shared/error-codes.json");
        let list: serde_json::Value = serde_json::from_str(LIST).unwrap();
        let known: Vec<&str> = list["codes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|code| code.as_str().unwrap())
            .collect();
        let samples = [
            Error::from(api_error(403, "Forbidden")),
            Error::from(api_error(404, "NotFound")),
            Error::from(api_error(500, "InternalError")),
            Error::from(api_error(401, "Unauthorized")),
            Error::Config(String::new()),
            Error::Auth(AuthError::Kubeconfig(String::new())),
            Error::Connection(String::new()),
            Error::not_found("Pod", "p", "n"),
            Error::PermissionDenied(String::new()),
            Error::InvalidInput(String::new()),
            Error::Serialization(String::new()),
            Error::Io(std::io::Error::other("x")),
            Error::Plugin(PluginError::NotFound(String::new())),
            Error::Terminal(String::new()),
            Error::LogStream(String::new()),
            Error::NoPreviousRun {
                container: String::new(),
            },
            Error::ListUnread {
                kind: String::new(),
                name: String::new(),
                said: String::new(),
            },
            Error::LogNotKept {
                container: String::new(),
                said: String::new(),
            },
            Error::Timeout(String::new()),
            Error::ReadDeadline { after_secs: 1 },
            Error::NotConnected(String::new()),
            Error::Internal(String::new()),
        ];
        // No wildcard arm: a new variant does not compile here until it has a
        // sample, and without one its code was never checked against the list.
        fn variant(error: &Error) -> usize {
            match error {
                Error::KubeApi(_) => 0,
                Error::CredentialsExpired(_) => 1,
                Error::Config(_) => 2,
                Error::Auth(_) => 3,
                Error::Connection(_) => 4,
                Error::NotFound { .. } => 5,
                Error::PermissionDenied(_) => 6,
                Error::InvalidInput(_) => 7,
                Error::Serialization(_) => 8,
                Error::Io(_) => 9,
                Error::Plugin(_) => 10,
                Error::Terminal(_) => 11,
                Error::LogStream(_) => 12,
                Error::NoPreviousRun { .. } => 13,
                Error::ListUnread { .. } => 14,
                Error::LogNotKept { .. } => 15,
                Error::Timeout(_) => 16,
                Error::ReadDeadline { .. } => 17,
                Error::NotConnected(_) => 18,
                Error::Internal(_) => 19,
            }
        }
        let sampled: std::collections::BTreeSet<usize> = samples.iter().map(variant).collect();
        assert_eq!(
            sampled,
            (0..=19).collect(),
            "a variant has no sample, so its code is never checked"
        );

        let mut used = std::collections::BTreeSet::new();
        for sample in &samples {
            assert!(
                known.contains(&sample.code()),
                "{} is not in the list",
                sample.code()
            );
            used.insert(sample.code());
        }
        assert_eq!(
            used.len(),
            known.len(),
            "the list names a code nothing sends"
        );
    }

    fn api_error(code: u16, reason: &str) -> kube::Error {
        kube::Error::Api(Box::new(kube::core::Status {
            status: Some(kube::core::response::StatusSummary::Failure),
            message: "the server has asked for the client to provide credentials".to_string(),
            reason: reason.to_string(),
            code,
            metadata: None,
            details: None,
        }))
    }

    /// kube 4 ends an API error's `Display` with the whole `Status` struct's
    /// `Debug`, and that string is what crosses to the screen. The reader gets
    /// the sentence and the reason; the struct dump — `Status { … }`,
    /// `ListMeta { … }` — is gone.
    #[test]
    fn a_kube_api_error_is_shown_without_the_status_struct_dump() {
        let err: Error = api_error(403, "Forbidden").into();
        let shown = err.to_string();
        assert!(
            shown.contains("the server has asked for the client to provide credentials"),
            "the message a reader acts on is lost: {shown}"
        );
        assert!(shown.contains("Forbidden"), "the reason is lost: {shown}");
        assert!(
            !shown.contains("Status {"),
            "the Status struct dump leaked onto the screen: {shown}"
        );
        assert!(
            !shown.contains("ListMeta"),
            "the metadata dump leaked onto the screen: {shown}"
        );
    }

    /// A refused watch reaches the reader as the toast over the list it falls
    /// back from, and it carried the same `Status` dump there.
    #[test]
    fn a_refused_watch_is_shown_without_the_status_struct_dump() {
        let err = kube::runtime::watcher::Error::InitialListFailed(api_error(403, "Forbidden"));
        let shown = watch_failure(&err);
        assert!(shown.starts_with("failed to perform initial object list: "));
        assert!(shown.contains("Forbidden"), "the reason is lost: {shown}");
        assert!(!shown.contains("Status {"), "the dump leaked: {shown}");
    }

    /// Would send the reader back to a screen that says the cluster is empty.
    /// A 401 is the session being over, not an answer about one request, and
    /// the frontend tells from the prefix of this sentence.
    #[test]
    fn a_401_is_expired_credentials_and_says_so_on_the_wire() {
        let err = Error::from(api_error(401, "Unauthorized"));
        assert!(matches!(err, Error::CredentialsExpired(_)));
        assert!(err.to_string().starts_with("CREDENTIALS_EXPIRED:"));
    }

    /// A read that ran out of time is its own answer, and the frontend can
    /// only tell from the prefix. It is boxed the way tower returns it and
    /// wrapped once more the way tower's buffer would, so the check walks the
    /// chain rather than trusting the top.
    #[test]
    fn a_read_past_its_deadline_says_so_on_the_wire() {
        // What tower's buffer does on the way out: its own error type, with
        // the layer's underneath as `source()`. `io::Error` would not do as a
        // stand-in — its `source()` skips the error it wraps.
        #[derive(Debug)]
        struct Wrapped(tower::BoxError);
        impl std::fmt::Display for Wrapped {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "buffered service failed: {}", self.0)
            }
        }
        impl std::error::Error for Wrapped {
            fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
                Some(self.0.as_ref())
            }
        }
        let elapsed: tower::BoxError = Box::new(tower::timeout::error::Elapsed::new());
        let err = Error::from(kube::Error::Service(elapsed));
        assert!(matches!(err, Error::ReadDeadline { .. }));
        assert!(err.to_string().starts_with("READ_DEADLINE:"));
        // The number too: the frontend prints its own copy of it from the
        // shared file, so a drift between the two would read as the cluster
        // having been given longer than it was.
        assert!(
            err.to_string()
                .contains(&crate::client::READ_DEADLINE.as_secs().to_string()),
            "the sentence has to carry the deadline it applied: {err}"
        );

        let wrapped: tower::BoxError =
            Box::new(Wrapped(Box::new(tower::timeout::error::Elapsed::new())));
        assert!(matches!(
            Error::from(kube::Error::Service(wrapped)),
            Error::ReadDeadline { .. }
        ));
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

    /// A 403 stays a `KubeApi`, so "was this refused" has to ask the code —
    /// matching `PermissionDenied` matches nothing a cluster sends, which is
    /// how a screen came to report a refusal as a hard failure.
    #[test]
    fn a_403_is_a_refusal_however_it_is_filed() {
        assert!(Error::from(api_error(403, "Forbidden")).is_refusal());
        assert!(Error::PermissionDenied("ours".into()).is_refusal());
        assert!(!Error::from(api_error(401, "Unauthorized")).is_refusal());
        assert!(!Error::from(api_error(500, "InternalError")).is_refusal());
        assert!(!Error::Config("nothing to do with rights".into()).is_refusal());
    }

    /// The same trap the 401 path was already guarded against: a distribution
    /// that sends `Forbidden` with the code unset. Asking `code` alone reads
    /// that refusal as a hard failure and throws the reader out over a screen
    /// their token merely cannot see.
    #[test]
    fn a_forbidden_with_no_code_is_still_a_refusal() {
        assert!(Error::from(api_error(0, "Forbidden")).is_refusal());
    }

    #[test]
    fn test_error_to_string_conversion() {
        let err = Error::Config("test error".into());
        let s: String = err.into();
        assert!(s.contains("Configuration error"));
        assert!(s.contains("test error"));
    }
}
