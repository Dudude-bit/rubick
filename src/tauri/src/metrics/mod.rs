//! Kubernetes Metrics API integration.
//!
//! Provides functionality to fetch resource usage metrics (CPU, Memory)
//! from the Kubernetes Metrics API (`/apis/metrics.k8s.io/v1beta1/`).
//!
//! - `types`: frontend Metrics types + internal serde shapes
//! - `parse`: kube `DynamicObject` → frontend types, status mapping,
//!   shared `fetch_metrics` generic helper

mod parse;
mod types;

pub use types::{
    MetricsStatus, MetricsStatusKind, NodeMetrics, NodeMetricsResponse, PodMetrics,
    PodMetricsResponse,
};

use std::collections::HashMap;
use std::time::{Duration, Instant};

use parking_lot::Mutex;

use crate::commands::helpers::UnreadNamespace;
use crate::error::{Error, Result};
use crate::state::AppState;

use parse::{
    fetch_metrics, list_metrics, metrics_status_available, metrics_status_from_error,
    parse_node_metric, parse_pod_metric,
};

/// Get pod metrics from Metrics API
pub async fn get_pod_metrics(
    namespace: Option<&str>,
    state: &AppState,
) -> Result<PodMetricsResponse> {
    let (status, data) = fetch_metrics(state, namespace, "PodMetrics", parse_pod_metric).await?;
    Ok(PodMetricsResponse {
        status,
        data,
        unread: Vec::new(),
    })
}

/// Pod metrics across a scope, read in each namespace of it.
///
/// A cluster-wide read needs rights a namespace-scoped token lacks, and it
/// was what several selected namespaces asked for, so such a reader lost
/// every sample the same selection one namespace at a time would have shown.
pub async fn get_pod_metrics_in(
    scope: Option<&[String]>,
    state: &AppState,
) -> Result<PodMetricsResponse> {
    let Some(names) = scope else {
        return get_pod_metrics(None, state).await;
    };
    let answers = futures::future::join_all(
        names
            .iter()
            .map(|name| list_metrics(state, Some(name), "PodMetrics", parse_pod_metric)),
    )
    .await;
    Ok(combined(
        names,
        answers.into_iter().collect::<Result<Vec<_>>>()?,
    ))
}

/// Several namespaces' samples as one. The status speaks for the scope only
/// when no namespace answered; otherwise the ones that did not are named in
/// `unread`, so their pods' missing samples are not taken for "not scraped
/// yet".
fn combined(
    names: &[String],
    answers: Vec<std::result::Result<Vec<PodMetrics>, kube::Error>>,
) -> PodMetricsResponse {
    let mut data = Vec::new();
    let mut unread = Vec::new();
    let mut refused = None;
    for (name, answer) in names.iter().zip(answers) {
        match answer {
            Ok(mut part) => data.append(&mut part),
            Err(err) => {
                refused.get_or_insert_with(|| metrics_status_from_error(&err));
                unread.push(UnreadNamespace::of(name.clone(), &Error::from(err)));
            }
        }
    }
    match refused {
        Some(status) if unread.len() == names.len() => PodMetricsResponse {
            status,
            data,
            unread: Vec::new(),
        },
        _ => PodMetricsResponse {
            status: metrics_status_available(),
            data,
            unread,
        },
    }
}

/// Get node metrics from Metrics API, remembering an unserved answer for
/// [`overview_node_metrics`].
pub async fn get_node_metrics(state: &AppState) -> Result<NodeMetricsResponse> {
    let (status, data) = fetch_metrics(state, None, "NodeMetrics", parse_node_metric).await?;
    if let Some(context) = state.get_current_context() {
        state
            .metrics_unserved
            .record(&context, &status, Instant::now());
    }
    Ok(NodeMetricsResponse { status, data })
}

/// How long "not installed" or "refused" stands before it is asked again,
/// as `src/contracts/unserved-retry.json` states it for both halves.
pub const UNSERVED_RETRY: Duration = Duration::from_secs(300);

/// Each context's last unserved node-metrics answer and when it came.
#[derive(Default)]
pub struct Unserved(Mutex<HashMap<String, (Instant, MetricsStatus)>>);

impl Unserved {
    /// The remembered answer, while it still stands.
    #[must_use]
    pub fn standing(&self, context: &str, now: Instant) -> Option<MetricsStatus> {
        let remembered = self.0.lock();
        let (at, status) = remembered.get(context)?;
        (now.saturating_duration_since(*at) < UNSERVED_RETRY).then(|| status.clone())
    }

    /// Only an admin changes these two answers; anything else is asked again.
    pub fn record(&self, context: &str, status: &MetricsStatus, now: Instant) {
        let mut remembered = self.0.lock();
        match status.status {
            MetricsStatusKind::NotInstalled | MetricsStatusKind::Forbidden => {
                remembered.insert(context.to_string(), (now, status.clone()));
            }
            MetricsStatusKind::Available | MetricsStatusKind::Error => {
                remembered.remove(context);
            }
        }
    }
}

/// Node metrics for the overview, which refreshes every ten seconds: an
/// unserved answer is reused until it has stood its time, rather than asking
/// a cluster with no metrics-server twice a refresh for the same 404.
pub async fn overview_node_metrics(state: &AppState) -> Result<NodeMetricsResponse> {
    let standing = state
        .get_current_context()
        .and_then(|context| state.metrics_unserved.standing(&context, Instant::now()));
    match standing {
        Some(status) => Ok(NodeMetricsResponse {
            status,
            data: Vec::new(),
        }),
        None => get_node_metrics(state).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(status: MetricsStatusKind) -> MetricsStatus {
        MetricsStatus {
            status,
            message: None,
        }
    }

    /// The frontend slows its metrics reads to the same file's number; a
    /// constant edited on one side only is the drift this catches.
    #[test]
    fn the_unserved_retry_matches_the_shared_file() {
        const FILE: &str = include_str!("../../../contracts/unserved-retry.json");
        let file: serde_json::Value = serde_json::from_str(FILE).expect("json");
        assert_eq!(
            file["unservedRetrySeconds"],
            UNSERVED_RETRY.as_secs(),
            "src/contracts/unserved-retry.json"
        );
    }

    /// Lena's log: two 404s a refresh from a cluster with no metrics-server.
    /// "Not installed" and "refused" stand for the retry time, per context,
    /// and an answer that could change by itself is never held. Fails if the
    /// overview would ask again inside the window, or never ask again.
    #[test]
    fn an_unserved_answer_stands_for_the_retry_time_and_no_longer() {
        let unserved = Unserved::default();
        let at = Instant::now();
        unserved.record("lab", &status(MetricsStatusKind::NotInstalled), at);
        unserved.record("prod", &status(MetricsStatusKind::Error), at);

        let held = unserved.standing("lab", at + Duration::from_secs(299));
        assert!(matches!(
            held.map(|s| s.status),
            Some(MetricsStatusKind::NotInstalled)
        ));
        assert!(unserved.standing("lab", at + UNSERVED_RETRY).is_none());
        assert!(unserved.standing("prod", at).is_none());

        unserved.record("lab", &status(MetricsStatusKind::Forbidden), at);
        unserved.record("lab", &status(MetricsStatusKind::Available), at);
        assert!(unserved.standing("lab", at).is_none());
    }

    fn sample(name: &str) -> PodMetrics {
        PodMetrics {
            name: name.into(),
            namespace: "ns".into(),
            cpu_millicores: Some(1.0),
            memory_bytes: Some(1),
        }
    }

    fn failure(code: u16, reason: &str) -> kube::Error {
        kube::Error::Api(Box::new(kube::core::Status {
            status: Some(kube::core::response::StatusSummary::Failure),
            message: "pods.metrics.k8s.io is forbidden".to_string(),
            reason: reason.to_string(),
            code,
            metadata: None,
            details: None,
        }))
    }

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|n| (*n).to_string()).collect()
    }

    /// One namespace refused beside one that answered: the answer is the
    /// samples that exist, not the refusal — and the refused one is named,
    /// or its pods' blank samples read as "not scraped yet" with no banner.
    #[test]
    fn a_namespace_refused_beside_one_that_answered_is_named_as_unread() {
        let answer = combined(
            &names(&["prod", "staging"]),
            vec![Ok(vec![sample("api")]), Err(failure(403, "Forbidden"))],
        );
        assert!(matches!(answer.status.status, MetricsStatusKind::Available));
        assert_eq!(answer.data.len(), 1);
        assert_eq!(answer.unread.len(), 1);
        assert_eq!(answer.unread[0].namespace, "staging");
        assert_eq!(answer.unread[0].code, "PERMISSION_DENIED");
    }

    /// Would break if a namespace's unread samples skipped the mapping every
    /// other unread namespace goes through: a read that ran out of time was
    /// a generic API fault here, beside the pods notice naming the deadline
    /// for the same namespace, and an expired session was not one.
    #[test]
    fn an_unread_namespace_says_why_as_every_other_read_does() {
        let deadline = kube::Error::Service(Box::new(tower::timeout::error::Elapsed::new()));
        let answer = combined(
            &names(&["prod", "staging", "billing"]),
            vec![
                Ok(vec![sample("api")]),
                Err(deadline),
                Err(failure(401, "Unauthorized")),
            ],
        );
        let codes: Vec<&str> = answer.unread.iter().map(|u| u.code.as_str()).collect();
        assert_eq!(codes, ["READ_DEADLINE", "CREDENTIALS_EXPIRED"]);
    }

    /// With no namespace answering, the refusal is the answer, never an
    /// empty "available".
    #[test]
    fn no_namespace_answering_is_the_first_refusal() {
        let answer = combined(
            &names(&["prod", "staging"]),
            vec![
                Err(failure(403, "Forbidden")),
                Err(failure(404, "NotFound")),
            ],
        );
        assert!(matches!(answer.status.status, MetricsStatusKind::Forbidden));
        assert!(answer.data.is_empty());
        assert!(answer.unread.is_empty(), "the status already says it");
    }
}
