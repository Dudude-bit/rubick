//! Translate kube `DynamicObject` responses from `metrics.k8s.io`
//! into the frontend Metrics types, plus the small helpers for
//! status mapping and dynamic-API construction.

use crate::commands::helpers::ResourceContext;
use crate::error::Result;
use crate::state::AppState;
use crate::utils::quantities::{parse_cpu, parse_memory};
use kube::api::ListParams;
use kube::core::DynamicObject;
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
        kube::Error::Api(api_err) => match api_err.code {
            404 => MetricsStatus {
                status: MetricsStatusKind::NotInstalled,
                message: Some(api_err.message.clone()),
            },
            401 | 403 => MetricsStatus {
                status: MetricsStatusKind::Forbidden,
                message: Some(api_err.message.clone()),
            },
            _ => MetricsStatus {
                status: MetricsStatusKind::Error,
                message: Some(format!(
                    "Metrics API error {}: {}",
                    api_err.code, api_err.message
                )),
            },
        },
        _ => MetricsStatus {
            status: MetricsStatusKind::Error,
            message: Some(err.to_string()),
        },
    }
}

fn metrics_api_resource(kind: &str) -> ApiResource {
    let plural = match kind {
        "PodMetrics" => "pods",
        "NodeMetrics" => "nodes",
        _ => {
            let mut lower = kind.to_ascii_lowercase();
            lower.push('s');
            return ApiResource {
                group: "metrics.k8s.io".to_string(),
                version: "v1beta1".to_string(),
                api_version: "metrics.k8s.io/v1beta1".to_string(),
                kind: kind.to_string(),
                plural: lower,
            };
        }
    };

    ApiResource {
        group: "metrics.k8s.io".to_string(),
        version: "v1beta1".to_string(),
        api_version: "metrics.k8s.io/v1beta1".to_string(),
        kind: kind.to_string(),
        plural: plural.to_string(),
    }
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
    let ctx = ResourceContext::for_list_from_app_state(state, namespace.map(str::to_string))?;
    let api = metrics_api(&ctx, kind);

    let list = match api.list(&ListParams::default()).await {
        Ok(list) => list,
        Err(err) => return Ok((metrics_status_from_error(&err), vec![])),
    };

    let metrics = list.items.iter().filter_map(parse).collect();
    Ok((metrics_status_available(), metrics))
}
