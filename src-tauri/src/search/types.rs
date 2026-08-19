//! Wire types for cross-cluster resource search.
//!
//! Everything here crosses the IPC boundary, so the shapes are the
//! frontend's contract: a hit always says which cluster it came from,
//! and a cluster always says what state it is in — never a bare empty
//! list that the reader has to interpret.

use kube::discovery::ApiResource;
use serde::{Deserialize, Serialize};

/// One matching resource. `context` is repeated on every hit (rather
/// than only on the enclosing batch) because the frontend flattens
/// hits from every cluster into one ranked list and would otherwise
/// lose the provenance.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub context: String,
    pub kind: String,
    pub name: String,
    pub namespace: Option<String>,
}

/// Where a single cluster stands in a search.
///
/// The frontend renders one row per context and switches on this; the
/// terminal states (`done` / `failed` / `skipped`) are deliberately
/// three separate things. "Found nothing", "could not be reached" and
/// "not connected, so not searched" read identically as an empty list
/// and mean completely different things.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchContextStatus {
    /// Establishing a client before it can be queried. Only ever the
    /// initial state when the caller explicitly asked to connect.
    Connecting,
    /// Querying a live client.
    Searching,
    /// Finished. `matched` is final; `message` may carry a partial
    /// note (e.g. secrets were forbidden but everything else worked).
    Done,
    /// Could not be searched. `reason` + `message` say why.
    Failed,
    /// Deliberately not searched — not connected, or not a context we
    /// know about. Carries `reason` + `message` too.
    Skipped,
}

/// Why a cluster could not be searched, in a form the UI can act on
/// (offer "connect", offer "retry", or just explain).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SearchFailureKind {
    /// No live client for this context and the caller did not ask to
    /// create one. The actionable UI is "search it anyway" / "connect".
    NotConnected,
    /// The name is not in the kubeconfig at all — a typo, or a context
    /// that was removed.
    UnknownContext,
    /// The API server did not answer: refused, DNS, no route.
    Unreachable,
    /// Connect or query exceeded its budget. Distinct from
    /// `Unreachable` because a retry is more likely to help.
    Timeout,
    /// 401/403. The cluster is fine, the credentials are not enough.
    Forbidden,
    /// Anything else; `message` is the only useful thing.
    Other,
}

/// Classify an error and phrase it for a person.
///
/// Both halves need the whole source chain, not the top-level
/// `Display`. A refused TCP connect surfaces from kube as
/// `ServiceError: client error (Connect)` — which tells the reader
/// nothing and classifies as `Other`. Two links down the chain sits
/// `Connection refused (os error 111)`, which is the sentence worth
/// putting on screen and the one that identifies an unreachable
/// cluster.
///
/// An API rejection is the exception and has to be pulled out before
/// the chain walk. `kube::Error::Api` renders as `ApiError: {0} ({0:?})`
/// — the readable half and a `Debug` dump of the same struct in one
/// string — and because the readable half is a substring of it, the
/// chain dedup drops the good link and leaves the dump. The server
/// already wrote the sentence for a person in `ErrorResponse.message`
/// (it is what `kubectl` prints), so use that and the HTTP code rather
/// than pattern-matching prose.
#[must_use]
pub fn describe_failure(error: &crate::error::Error) -> (SearchFailureKind, String) {
    use crate::error::Error;

    if let Error::KubeApi(kube::Error::Api(response)) = error {
        if !response.message.is_empty() {
            let kind = match response.code {
                401 | 403 => SearchFailureKind::Forbidden,
                408 | 504 => SearchFailureKind::Timeout,
                _ => SearchFailureKind::classify_text(&response.message),
            };
            return (kind, response.message.clone());
        }
    }

    let chain = error_chain(error);
    let message = chain
        .last()
        .cloned()
        .unwrap_or_else(|| crate::state::readable_cause(error));

    // These two variants carry their meaning in the type, not the
    // prose: "Permission denied: …" contains none of the words the
    // text classifier looks for.
    let kind = match error {
        Error::Timeout(_) => SearchFailureKind::Timeout,
        Error::PermissionDenied(_) => SearchFailureKind::Forbidden,
        // A 401 no longer arrives as `KubeApi` — it has its own variant now.
        // The fan-out has no state for "this cluster's session is over", and
        // refused is the nearest true thing it can say about one row.
        Error::CredentialsExpired(_) => SearchFailureKind::Forbidden,
        _ => SearchFailureKind::classify_text(&chain.join(" | ")),
    };
    (kind, message)
}

/// Top-level message plus every distinct `source()` beneath it.
fn error_chain(error: &crate::error::Error) -> Vec<String> {
    let mut chain = vec![crate::state::readable_cause(error)];
    let mut source = std::error::Error::source(error);
    while let Some(current) = source {
        let text = current.to_string();
        if !text.is_empty() && !chain.iter().any(|seen| seen.contains(&text)) {
            chain.push(text);
        }
        source = current.source();
    }
    chain
}

impl SearchFailureKind {
    /// Bucket an error by the words in it.
    ///
    /// Everything unrecognised lands in `Other` rather than
    /// `Unreachable`: claiming a cluster is down when the real problem
    /// was a malformed exec plugin sends the reader to the wrong place.
    fn classify_text(raw: &str) -> Self {
        let text = raw.to_lowercase();
        if text.contains("forbidden")
            || text.contains("unauthorized")
            || text.contains(" 401")
            || text.contains(" 403")
        {
            return Self::Forbidden;
        }
        if text.contains("timed out") || text.contains("timeout") {
            return Self::Timeout;
        }
        if text.contains("connection refused")
            || text.contains("connection reset")
            || text.contains("dns error")
            || text.contains("no route to host")
            || text.contains("failed to lookup address")
            || text.contains("tcp connect error")
            || text.contains("network is unreachable")
        {
            return Self::Unreachable;
        }
        Self::Other
    }
}

/// One cluster's slot in a search, as handed back by
/// `start_resource_search` before any event arrives. Lets the palette
/// paint the full set of rows immediately — live, connecting, skipped
/// — instead of growing them as events trickle in.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchTarget {
    pub context: String,
    pub status: SearchContextStatus,
    pub reason: Option<SearchFailureKind>,
    pub message: Option<String>,
}

impl SearchTarget {
    #[must_use]
    pub fn searching(context: String) -> Self {
        Self {
            context,
            status: SearchContextStatus::Searching,
            reason: None,
            message: None,
        }
    }

    #[must_use]
    pub fn connecting(context: String) -> Self {
        Self {
            context,
            status: SearchContextStatus::Connecting,
            reason: None,
            message: None,
        }
    }

    #[must_use]
    pub fn skipped(context: String, reason: SearchFailureKind, message: impl Into<String>) -> Self {
        Self {
            context,
            status: SearchContextStatus::Skipped,
            reason: Some(reason),
            message: Some(message.into()),
        }
    }

    /// True when this target will actually be queried — the manager
    /// only spawns work for these.
    #[must_use]
    pub fn is_active(&self) -> bool {
        matches!(
            self.status,
            SearchContextStatus::Searching | SearchContextStatus::Connecting
        )
    }
}

/// What the frontend asks for.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    /// Substring matched case-insensitively against name and namespace.
    pub query: String,
    /// Context names to search. Empty means "the current context" —
    /// the cheap default the palette uses on every keystroke.
    #[serde(default)]
    pub contexts: Vec<String>,
    /// Search every context in the kubeconfig. Overrides `contexts`.
    #[serde(default)]
    pub all_contexts: bool,
    /// Namespace scope applied to every searched context. None = all
    /// namespaces.
    #[serde(default)]
    pub namespace: Option<String>,
    /// Kind labels to search; None = the default set.
    #[serde(default)]
    pub kinds: Option<Vec<String>>,
    /// Allow connecting contexts that have no live client yet. False
    /// on keystroke-driven searches: connecting can run an exec
    /// credential plugin, and typing must never trigger an auth prompt.
    #[serde(default)]
    pub connect: bool,
    /// Hits to collect per cluster before the search stops early and
    /// reports `truncated`.
    #[serde(default)]
    pub limit_per_context: Option<u32>,
}

/// What `start_resource_search` hands back.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHandle {
    /// Id to filter events on and to cancel with.
    pub search_id: String,
    /// Every requested context with its initial state, including the
    /// ones that will never be queried.
    pub targets: Vec<SearchTarget>,
}

/// A kind the search knows how to list, with the scope needed to build
/// its `Api`. Typed `ApiResource`s are used instead of a `Discovery`
/// run: discovery costs a full API-surface round-trip per cluster, and
/// this search runs on a debounce timer across several clusters.
pub struct SearchableKind {
    pub label: &'static str,
    pub cluster_scoped: bool,
    api_resource: fn() -> ApiResource,
}

impl SearchableKind {
    #[must_use]
    pub fn api_resource(&self) -> ApiResource {
        (self.api_resource)()
    }
}

macro_rules! searchable {
    ($label:literal, $ty:ty, $cluster_scoped:expr) => {
        SearchableKind {
            label: $label,
            cluster_scoped: $cluster_scoped,
            api_resource: || ApiResource::erase::<$ty>(&()),
        }
    };
}

/// A Gateway API kind, asked for at `v1` — the version every kind serves
/// on any current bundle. A cluster serving only the older versions
/// answers this list with a 404, and the search already reports that per
/// kind instead of inventing "no matches"; a per-cluster served-version
/// lookup here would buy those clusters a hit list at the price of a
/// detection call on every keystroke's fan-out.
macro_rules! searchable_gateway {
    ($label:literal, $plural:literal, $cluster_scoped:expr) => {
        SearchableKind {
            label: $label,
            cluster_scoped: $cluster_scoped,
            api_resource: || ApiResource {
                group: "gateway.networking.k8s.io".to_string(),
                version: "v1".to_string(),
                api_version: "gateway.networking.k8s.io/v1".to_string(),
                kind: $label.to_string(),
                plural: $plural.to_string(),
            },
        }
    };
}

/// Everything the search can look at. The `DEFAULT_KINDS` subset is
/// what an unqualified query hits.
pub static SEARCHABLE_KINDS: &[SearchableKind] = &[
    searchable!("Pod", k8s_openapi::api::core::v1::Pod, false),
    searchable!("Deployment", k8s_openapi::api::apps::v1::Deployment, false),
    searchable!(
        "StatefulSet",
        k8s_openapi::api::apps::v1::StatefulSet,
        false
    ),
    searchable!("DaemonSet", k8s_openapi::api::apps::v1::DaemonSet, false),
    searchable!("Job", k8s_openapi::api::batch::v1::Job, false),
    searchable!("CronJob", k8s_openapi::api::batch::v1::CronJob, false),
    searchable!("Service", k8s_openapi::api::core::v1::Service, false),
    searchable!("Ingress", k8s_openapi::api::networking::v1::Ingress, false),
    searchable_gateway!("Gateway", "gateways", false),
    searchable_gateway!("GatewayClass", "gatewayclasses", true),
    searchable_gateway!("HTTPRoute", "httproutes", false),
    searchable_gateway!("GRPCRoute", "grpcroutes", false),
    searchable_gateway!("TLSRoute", "tlsroutes", false),
    searchable_gateway!("TCPRoute", "tcproutes", false),
    searchable_gateway!("UDPRoute", "udproutes", false),
    searchable_gateway!("ListenerSet", "listenersets", false),
    searchable!("ConfigMap", k8s_openapi::api::core::v1::ConfigMap, false),
    searchable!("Secret", k8s_openapi::api::core::v1::Secret, false),
    searchable!(
        "PersistentVolumeClaim",
        k8s_openapi::api::core::v1::PersistentVolumeClaim,
        false
    ),
    searchable!("Node", k8s_openapi::api::core::v1::Node, true),
    searchable!("Namespace", k8s_openapi::api::core::v1::Namespace, true),
];

/// Kinds searched when the caller does not name any. Mirrors what the
/// command palette searched before this existed.
pub const DEFAULT_KINDS: &[&str] = &[
    "Pod",
    "Deployment",
    "Service",
    "ConfigMap",
    "Secret",
    "Ingress",
    "Node",
];
