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

use crate::error::Result;
use crate::state::AppState;

use parse::{fetch_metrics, parse_node_metric, parse_pod_metric};

/// Get pod metrics from Metrics API
pub async fn get_pod_metrics(
    namespace: Option<&str>,
    state: &AppState,
) -> Result<PodMetricsResponse> {
    let (status, data) = fetch_metrics(state, namespace, "PodMetrics", parse_pod_metric).await?;
    Ok(PodMetricsResponse { status, data })
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
            .map(|name| fetch_metrics(state, Some(name), "PodMetrics", parse_pod_metric)),
    )
    .await;
    Ok(combined(answers.into_iter().collect::<Result<Vec<_>>>()?))
}

/// Several namespaces' samples as one. A namespace that did not answer
/// leaves its pods without one, which the table draws as unknown; the
/// status speaks for the scope only when no namespace answered.
fn combined(answers: Vec<(MetricsStatus, Vec<PodMetrics>)>) -> PodMetricsResponse {
    let mut data = Vec::new();
    let mut refused = None;
    let mut answered = false;
    for (status, mut part) in answers {
        if matches!(status.status, MetricsStatusKind::Available) {
            answered = true;
            data.append(&mut part);
        } else {
            refused.get_or_insert(status);
        }
    }
    let status = match refused {
        Some(status) if !answered => status,
        _ => parse::metrics_status_available(),
    };
    PodMetricsResponse { status, data }
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

    fn status(kind: MetricsStatusKind) -> MetricsStatus {
        MetricsStatus {
            status: kind,
            message: Some("said".into()),
        }
    }

    /// One namespace refused beside one that answered: the answer is the
    /// samples that exist, not the refusal. Taking the first status made a
    /// narrow token's pods page read "forbidden" over metrics it could see.
    #[test]
    fn a_namespace_that_answered_is_not_hidden_by_one_that_did_not() {
        let answer = combined(vec![
            (status(MetricsStatusKind::Forbidden), Vec::new()),
            (parse::metrics_status_available(), vec![sample("api")]),
        ]);
        assert!(matches!(answer.status.status, MetricsStatusKind::Available));
        assert_eq!(answer.data.len(), 1);
    }

    /// With no namespace answering, the refusal is the answer, never an
    /// empty "available".
    #[test]
    fn no_namespace_answering_is_the_first_refusal() {
        let answer = combined(vec![
            (status(MetricsStatusKind::Forbidden), Vec::new()),
            (status(MetricsStatusKind::NotInstalled), Vec::new()),
        ]);
        assert!(matches!(answer.status.status, MetricsStatusKind::Forbidden));
        assert!(answer.data.is_empty());
    }
}
