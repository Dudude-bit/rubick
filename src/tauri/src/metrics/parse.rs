//! Translate kube `DynamicObject` responses from `metrics.k8s.io`
//! into the frontend Metrics types, plus the small helpers for
//! status mapping and dynamic-API construction.

use crate::commands::helpers::ResourceContext;
use crate::error::{page_status, server_words, session_over, Result};
use crate::state::AppState;
use crate::utils::quantities::{parse_cpu, parse_memory};
use kube::api::ListParams;
use kube::core::{DynamicObject, GroupVersionKind};
use kube::discovery::ApiResource;
use kube::Api;

use super::types::{
    ContainerUsage, MetricsStatus, MetricsStatusKind, NodeMetrics, NodeMetricsItem, PodMetrics,
    PodMetricsItem,
};

pub(super) fn metrics_status_available() -> MetricsStatus {
    MetricsStatus {
        status: MetricsStatusKind::Available,
        message: None,
    }
}

pub(super) fn metrics_status_from_error(err: &kube::Error) -> MetricsStatus {
    match err {
        kube::Error::Api(api_err) => {
            // `reason` is checked alongside `code` for the same reason
            // `Error::is_refusal` does it: kube 4 leaves `code` at 0 when the
            // Status body omits it, and some distributions send exactly that
            // on a metrics refusal. Code alone would then paint a no-permission
            // state (the third state) as a generic error banner.
            if api_err.code == 404 || api_err.reason == "NotFound" {
                MetricsStatus {
                    status: MetricsStatusKind::NotInstalled,
                    message: Some(server_words(api_err)),
                }
            } else if api_err.code == 403
                || api_err.reason == "Forbidden"
                // Only the metrics API's own: `list_metrics` has asked the
                // API server, and the session stands.
                || session_over(err).is_some()
            {
                MetricsStatus {
                    status: MetricsStatusKind::Forbidden,
                    message: Some(server_words(api_err)),
                }
            } else {
                MetricsStatus {
                    status: MetricsStatusKind::Error,
                    // The banner's title already says this is a metrics error,
                    // in the reader's language. What is left to add is the
                    // server's own code and words.
                    message: Some(
                        page_status(api_err)
                            .unwrap_or_else(|| format!("{}: {}", api_err.code, api_err.message)),
                    ),
                }
            }
        }
        _ => MetricsStatus {
            status: MetricsStatusKind::Error,
            message: Some(err.to_string()),
        },
    }
}

fn metrics_api_resource(kind: &str) -> ApiResource {
    let plural = match kind {
        "PodMetrics" => "pods".to_string(),
        "NodeMetrics" => "nodes".to_string(),
        _ => format!("{}s", kind.to_ascii_lowercase()),
    };
    ApiResource::from_gvk_with_plural(
        &GroupVersionKind::gvk("metrics.k8s.io", "v1beta1", kind),
        &plural,
    )
}

fn metrics_api(ctx: &ResourceContext, kind: &str) -> Api<DynamicObject> {
    let api_resource = metrics_api_resource(kind);
    let is_cluster_scoped = kind == "NodeMetrics";
    ctx.dynamic_api_for_resource(&api_resource, is_cluster_scoped)
}

pub(super) fn parse_pod_metric(item: &DynamicObject) -> Option<PodMetrics> {
    let value = serde_json::to_value(item).ok()?;
    let parsed: PodMetricsItem = serde_json::from_value(value).ok()?;

    let mut total_cpu = 0.0f64;
    let mut total_memory = 0u64;
    let mut has_cpu = false;
    let mut has_memory = false;

    for container in &parsed.containers {
        if let Some(cpu) = &container.usage.cpu {
            has_cpu = true;
            total_cpu += parse_cpu(cpu);
        }
        if let Some(memory) = &container.usage.memory {
            has_memory = true;
            total_memory += parse_memory(memory);
        }
    }

    Some(PodMetrics {
        name: parsed.metadata.name,
        namespace: parsed.metadata.namespace,
        cpu_millicores: if has_cpu { Some(total_cpu) } else { None },
        memory_bytes: if has_memory { Some(total_memory) } else { None },
    })
}

pub(super) fn parse_node_metric(item: &DynamicObject) -> Option<NodeMetrics> {
    let value = serde_json::to_value(item).ok()?;
    let parsed: NodeMetricsItem = serde_json::from_value(value).ok()?;

    let cpu_millicores = parse_usage_cpu(&parsed.usage);
    let memory_bytes = parse_usage_memory(&parsed.usage);

    Some(NodeMetrics {
        name: parsed.metadata.name,
        cpu_millicores,
        memory_bytes,
    })
}

fn parse_usage_cpu(usage: &ContainerUsage) -> Option<f64> {
    usage.cpu.as_ref().map(|cpu| parse_cpu(cpu))
}

fn parse_usage_memory(usage: &ContainerUsage) -> Option<u64> {
    usage.memory.as_ref().map(|memory| parse_memory(memory))
}

/// Generic fetch+parse for the Metrics API. Used by both
/// `get_pod_metrics` and `get_node_metrics` — they differ only in
/// the kind string (`PodMetrics` vs `NodeMetrics`) and the parser
/// function. On API error returns `(metrics_status_from_error, vec![])`
/// so the frontend can render a "Metrics API not installed / forbidden"
/// banner without seeing the call as a hard failure.
pub(super) async fn fetch_metrics<T>(
    state: &AppState,
    namespace: Option<&str>,
    kind: &str,
    parse: impl Fn(&DynamicObject) -> Option<T>,
) -> Result<(MetricsStatus, Vec<T>)> {
    Ok(match list_metrics(state, namespace, kind, parse).await? {
        Ok(metrics) => (metrics_status_available(), metrics),
        Err(err) => (metrics_status_from_error(&err), vec![]),
    })
}

/// The samples, or the API's refusal or fault kept whole. A 401 the API
/// server gives too is neither: it is the session ending, and leaves as the
/// error every other read gives, so nothing files it as an answer about
/// metrics. One the metrics API gives alone is its refusal.
pub(super) async fn list_metrics<T>(
    state: &AppState,
    namespace: Option<&str>,
    kind: &str,
    parse: impl Fn(&DynamicObject) -> Option<T>,
) -> Result<std::result::Result<Vec<T>, kube::Error>> {
    let ctx = ResourceContext::for_list_from_app_state(state, namespace.map(str::to_string))?;
    let api = metrics_api(&ctx, kind);
    match api.list(&ListParams::default()).await {
        Err(err) if session_over(&err).is_some() && !session_stands(&ctx.client).await => {
            Err(err.into())
        }
        answer => Ok(answer.map(|list| list.items.iter().filter_map(parse).collect())),
    }
}

/// Whether the API server itself still takes these credentials: `/version`,
/// the proof a connect asks for. An aggregated API answers 401 by itself
/// when its server rejects the front proxy's certificate, and taken for the
/// session ending that put the whole window on "Credentials expired" at
/// every metrics poll. No answer at all proves nothing, and is not a yes.
async fn session_stands(client: &kube::Client) -> bool {
    match client.apiserver_version().await {
        Ok(_) => true,
        Err(err) => matches!(err, kube::Error::Api(_)) && session_over(&err).is_none(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn api_error(code: u16, reason: &str) -> kube::Error {
        kube::Error::Api(Box::new(kube::core::Status {
            status: Some(kube::core::response::StatusSummary::Failure),
            message: "metrics.k8s.io is forbidden".to_string(),
            reason: reason.to_string(),
            code,
            metadata: None,
            details: None,
        }))
    }

    /// A metrics read through a proxy that answered with its own 502 page put
    /// the page in the banner. Fails if the HTML reaches the status message.
    #[test]
    fn a_proxy_error_page_is_its_status_line_in_the_banner() {
        let page = kube::Error::Api(Box::new(
            kube::core::Status::failure(
                "<html><head><title>502 Bad Gateway</title></head><body></body></html>",
                "Failed to parse error data",
            )
            .with_code(502),
        ));
        let status = metrics_status_from_error(&page);
        assert!(matches!(status.status, MetricsStatusKind::Error));
        assert_eq!(status.message.as_deref(), Some("502 Bad Gateway"));
    }

    /// No answer from the API server proves nothing about the session.
    /// Fails if a `/version` that could not be asked is taken for the
    /// session standing: a lapsed token's 401 on a network that also blinked
    /// is then filed as the metrics API's refusal, and stands five minutes.
    #[tokio::test]
    async fn an_api_server_that_does_not_answer_does_not_vouch_for_the_session() {
        crate::tls::provider();
        let nowhere = kube::Config::new("http://127.0.0.1:1".parse().expect("url"));
        let client = kube::Client::try_from(nowhere).expect("client");
        assert!(!session_stands(&client).await);
    }

    /// A wrong plural or apiVersion lists a path the server does not have,
    /// and the panel then reads as "metrics unavailable" on every cluster.
    #[test]
    fn metrics_kinds_resolve_to_the_paths_the_server_serves() {
        let pods = metrics_api_resource("PodMetrics");
        assert_eq!(
            (pods.api_version.as_str(), pods.plural.as_str()),
            ("metrics.k8s.io/v1beta1", "pods")
        );
        assert_eq!(metrics_api_resource("NodeMetrics").plural, "nodes");
        assert_eq!(metrics_api_resource("Other").plural, "others");
    }

    /// The metrics panel's own third state: "you cannot read metrics" must not
    /// collapse into a generic error banner. kube 4 leaves `code` at 0 when the
    /// Status body omits it, so — like `Error::is_refusal` — the reason has to
    /// be read too, or a refusal on such a distribution reads as `Error`.
    #[test]
    fn a_forbidden_with_no_code_is_still_forbidden() {
        assert!(matches!(
            metrics_status_from_error(&api_error(403, "Forbidden")).status,
            MetricsStatusKind::Forbidden
        ));
        assert!(matches!(
            metrics_status_from_error(&api_error(0, "Forbidden")).status,
            MetricsStatusKind::Forbidden
        ));
        assert!(matches!(
            metrics_status_from_error(&api_error(0, "NotFound")).status,
            MetricsStatusKind::NotInstalled
        ));
        assert!(matches!(
            metrics_status_from_error(&api_error(500, "InternalError")).status,
            MetricsStatusKind::Error
        ));
    }
}
