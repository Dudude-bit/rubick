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
                unread.push(UnreadNamespace::of(name.clone(), &Error::KubeApi(err)));
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

/// Get node metrics from Metrics API
pub async fn get_node_metrics(state: &AppState) -> Result<NodeMetricsResponse> {
    let (status, data) = fetch_metrics(state, None, "NodeMetrics", parse_node_metric).await?;
    Ok(NodeMetricsResponse { status, data })
}

#[cfg(test)]
mod tests {
    use super::*;

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
