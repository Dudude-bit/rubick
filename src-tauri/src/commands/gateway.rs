//! Gateway API Tauri commands.
//!
//! Every read goes through a dynamic API pinned to the version detection
//! chose (see [`GatewayApiDetection`]): `v1` where served, `v1beta1` on
//! early-GKE-era bundles, `v1alpha2` for the route trio before Gateway API
//! 1.5/1.6. The conversion layer in `resources::gateway` is one tolerant
//! baseline over all of them, so the commands' whole version job is picking
//! the apiVersion to ask the server for.

use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
use kube::api::{Api, DeleteParams, DynamicObject, TypeMeta};
use kube::discovery::ApiResource;
use tauri::State;

use crate::commands::helpers::{build_list_params, ResourceContext};
use crate::error::{Error, Result};
use crate::resources::{
    BackendTlsPolicyInfo, GatewayApiDetection, GatewayClassInfo, GatewayInfo, ListenerSetInfo,
    RouteInfo, GATEWAY_API_GROUP,
};
use crate::state::AppState;

/// The five kinds `list_gateway_routes` answers for.
const ROUTE_KINDS: [&str; 5] = ["HTTPRoute", "GRPCRoute", "TLSRoute", "TCPRoute", "UDPRoute"];

fn plural_of(kind: &str) -> Result<&'static str> {
    Ok(match kind {
        "GatewayClass" => "gatewayclasses",
        "Gateway" => "gateways",
        "HTTPRoute" => "httproutes",
        "GRPCRoute" => "grpcroutes",
        "TLSRoute" => "tlsroutes",
        "TCPRoute" => "tcproutes",
        "UDPRoute" => "udproutes",
        "ListenerSet" => "listenersets",
        "BackendTLSPolicy" => "backendtlspolicies",
        other => {
            return Err(Error::InvalidInput(format!(
                "not a Gateway API kind this app reads: {other}"
            )))
        }
    })
}

/// The dynamic-API coordinates for one Gateway API kind, at the served
/// version detection picks. Errors with the CRD's own absence when the
/// kind is not installed — the sidebar should have kept the caller away,
/// but a stale window may still ask.
pub(crate) async fn served_api_resource(
    kind: &str,
    state: &State<'_, AppState>,
) -> Result<ApiResource> {
    let plural = plural_of(kind)?;
    let crd: CustomResourceDefinition = crate::commands::helpers::get_cluster_resource(
        format!("{plural}.{GATEWAY_API_GROUP}"),
        state.clone(),
    )
    .await?;

    let detection = GatewayApiDetection::from_crds(std::slice::from_ref(&crd));
    let served = detection
        .kinds
        .first()
        .ok_or_else(|| Error::InvalidInput(format!("{kind} is installed but serves no version")))?;
    Ok(served.api_resource())
}

/// A dynamic API for one Gateway API kind, at the served version.
async fn gateway_api(
    kind: &str,
    namespace: Option<String>,
    listing: bool,
    state: &State<'_, AppState>,
) -> Result<(Api<DynamicObject>, ApiResource)> {
    let api_resource = served_api_resource(kind, state).await?;

    let cluster_scoped = kind == "GatewayClass";
    let ctx = if cluster_scoped {
        ResourceContext::for_list(state, None)?
    } else if listing {
        ResourceContext::for_list(state, namespace)?
    } else {
        ResourceContext::for_command(state, namespace)?
    };

    Ok((
        ctx.dynamic_api_for_resource(&api_resource, cluster_scoped),
        api_resource,
    ))
}

/// List responses strip apiVersion/kind off every item; the readers report
/// them, so they are put back from the resource the request was made for.
pub(crate) fn with_types(mut obj: DynamicObject, api_resource: &ApiResource) -> DynamicObject {
    if obj.types.is_none() {
        obj.types = Some(TypeMeta {
            api_version: api_resource.api_version.clone(),
            kind: api_resource.kind.clone(),
        });
    }
    obj
}

/// What one CRD scan says about Gateway API in this cluster.
///
/// The frontend keeps this beside the vendor scan, one query per cluster;
/// every gateway surface reads the cached answer.
#[tauri::command]
pub async fn detect_gateway_api(state: State<'_, AppState>) -> Result<GatewayApiDetection> {
    let crds = crate::commands::helpers::list_cluster_resources::<CustomResourceDefinition>(
        state, None, None, None,
    )
    .await?;
    Ok(GatewayApiDetection::from_crds(&crds.items))
}

#[tauri::command]
pub async fn list_gateway_classes(state: State<'_, AppState>) -> Result<Vec<GatewayClassInfo>> {
    let (api, api_resource) = gateway_api("GatewayClass", None, true, &state).await?;
    let list = api.list(&build_list_params(None, None, None)).await?;
    Ok(list
        .items
        .into_iter()
        .map(|obj| GatewayClassInfo::read(&with_types(obj, &api_resource)))
        .collect())
}

/// Every `BackendTLSPolicy` in scope. Policies name their targets and the
/// targets never name them back, so surfaces do the reverse lookup over
/// this list — the same shape gwctl's effective-policy view reads.
#[tauri::command]
pub async fn list_backend_tls_policies(
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<BackendTlsPolicyInfo>> {
    let (api, api_resource) = gateway_api("BackendTLSPolicy", namespace, true, &state).await?;
    let list = api.list(&build_list_params(None, None, None)).await?;
    Ok(list
        .items
        .into_iter()
        .map(|obj| BackendTlsPolicyInfo::read(&with_types(obj, &api_resource)))
        .collect())
}

#[tauri::command]
pub async fn get_gateway_class(
    name: String,
    state: State<'_, AppState>,
) -> Result<GatewayClassInfo> {
    crate::validation::validate_dns_subdomain(&name)?;
    let (api, api_resource) = gateway_api("GatewayClass", None, false, &state).await?;
    let obj = api.get(&name).await?;
    Ok(GatewayClassInfo::read(&with_types(obj, &api_resource)))
}

#[tauri::command]
pub async fn delete_gateway_class(name: String, state: State<'_, AppState>) -> Result<()> {
    crate::validation::validate_dns_subdomain(&name)?;
    let (api, _) = gateway_api("GatewayClass", None, false, &state).await?;
    api.delete(&name, &DeleteParams::default()).await?;
    Ok(())
}

/// Every `ListenerSet` in the cluster, or nothing where the kind is not
/// installed. Absence is ordinary — the kind graduated in Gateway API 1.5
/// and most bundles in the wild predate it — so "cannot list" reads as
/// "none", not as an error a Gateway page fails on.
async fn listener_sets(state: &State<'_, AppState>) -> Option<Vec<ListenerSetInfo>> {
    // `None` where the kind is absent *or* the list was refused, `Some` for a
    // real answer including an empty one. The two used to be the same value,
    // which cost nothing while the only consumer was the listener fold — a
    // few rows missing from a table. It stopped being free the moment a route
    // could resolve its parent through this list: an unread list then reads
    // as "no set by that name", and the route's Gateway as missing.
    let (api, api_resource) = gateway_api("ListenerSet", None, true, state).await.ok()?;
    let list = api.list(&build_list_params(None, None, None)).await.ok()?;
    Some(
        list.items
            .into_iter()
            .map(|obj| ListenerSetInfo::read(&with_types(obj, &api_resource)))
            .collect(),
    )
}

#[tauri::command]
pub async fn list_gateways(
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<GatewayInfo>> {
    let (api, api_resource) = gateway_api("Gateway", namespace, true, &state).await?;
    // The ListenerSet probe answers "none" on its own errors, so the two
    // reads race instead of queuing — one round trip of latency, not two.
    let params = build_list_params(None, None, None);
    let (list, sets) = tokio::join!(api.list(&params), listener_sets(&state));
    let list = list?;
    Ok(list
        .items
        .into_iter()
        .map(|obj| {
            let mut gateway = GatewayInfo::read(&with_types(obj, &api_resource));
            gateway.merge_listener_sets(sets.as_deref());
            gateway
        })
        .collect())
}

#[tauri::command]
pub async fn get_gateway(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<GatewayInfo> {
    crate::validation::validate_dns_subdomain(&name)?;
    let (api, api_resource) = gateway_api("Gateway", namespace, false, &state).await?;
    let obj = api.get(&name).await?;
    let mut gateway = GatewayInfo::read(&with_types(obj, &api_resource));
    gateway.merge_listener_sets(listener_sets(&state).await.as_deref());
    Ok(gateway)
}

#[tauri::command]
pub async fn delete_gateway(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<()> {
    crate::validation::validate_dns_subdomain(&name)?;
    let (api, _) = gateway_api("Gateway", namespace, false, &state).await?;
    api.delete(&name, &DeleteParams::default()).await?;
    Ok(())
}

pub(crate) fn require_route_kind(kind: &str) -> Result<()> {
    if ROUTE_KINDS.contains(&kind) {
        Ok(())
    } else {
        Err(Error::InvalidInput(format!(
            "not a Gateway API route kind: {kind}"
        )))
    }
}

#[tauri::command]
pub async fn list_gateway_routes(
    kind: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<RouteInfo>> {
    require_route_kind(&kind)?;
    let (api, api_resource) = gateway_api(&kind, namespace, true, &state).await?;
    let list = api.list(&build_list_params(None, None, None)).await?;
    Ok(list
        .items
        .into_iter()
        .map(|obj| RouteInfo::read(&with_types(obj, &api_resource)))
        .collect())
}

#[tauri::command]
pub async fn get_gateway_route(
    kind: String,
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<RouteInfo> {
    require_route_kind(&kind)?;
    crate::validation::validate_dns_subdomain(&name)?;
    let (api, api_resource) = gateway_api(&kind, namespace, false, &state).await?;
    let obj = api.get(&name).await?;
    Ok(RouteInfo::read(&with_types(obj, &api_resource)))
}

#[tauri::command]
pub async fn delete_gateway_route(
    kind: String,
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<()> {
    require_route_kind(&kind)?;
    crate::validation::validate_dns_subdomain(&name)?;
    let (api, _) = gateway_api(&kind, namespace, false, &state).await?;
    api.delete(&name, &DeleteParams::default()).await?;
    Ok(())
}

/// What this machine sees when it tries the host — DNS and TCP, honestly
/// scoped: a VPN or split DNS can disagree with the cluster's own view,
/// and the caller says so on screen.
///
/// Two commands rather than one, so the panel can draw each step as it
/// actually runs — a spinner over a monolith would be theatre.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveProbe {
    /// Every address the hostname resolves to from here.
    pub resolved: Vec<String>,
    pub error: Option<String>,
    /// Whether any resolved address is the gateway's own — `None` where the
    /// gateway has published no address to compare against.
    pub matches_gateway: Option<bool>,
}

/// Resolve a route's hostname from this machine and compare against the
/// Gateway's published address.
///
/// Explicitly on demand — never automatic — because it sends packets on
/// the reader's network, and because "checked from your laptop" is only an
/// honest answer when the reader asked for it.
#[tauri::command]
pub async fn probe_resolve_host(
    host: String,
    gateway_address: Option<String>,
    port: u16,
) -> Result<ResolveProbe> {
    validate_probe_target(&host)?;

    let (resolved, error) = match tokio::net::lookup_host((host.as_str(), port)).await {
        Ok(addrs) => {
            // First-seen order, all duplicates gone — `dedup()` alone only
            // drops neighbours and a round-robin answer is not sorted.
            let mut seen = std::collections::HashSet::new();
            let ips: Vec<String> = addrs
                .map(|a| a.ip().to_string())
                .filter(|ip| seen.insert(ip.clone()))
                .collect();
            (ips, None)
        }
        Err(err) => (Vec::new(), Some(err.to_string())),
    };

    // A Gateway publishes `status.addresses[].value`, which is an IP on some
    // clusters and a DNS name on most cloud ones — every AWS load balancer
    // hands out a hostname. Comparing the resolved IPs against that string
    // made the answer "no" on every healthy cluster in the second case, and
    // the trace paints that red. Where the published address is a name, ask
    // what it resolves to and compare the two sets; where that lookup fails,
    // say nothing rather than "no".
    let matches_gateway = match gateway_address.as_deref() {
        None => None,
        Some(address) if address.parse::<std::net::IpAddr>().is_ok() => {
            Some(resolved.iter().any(|ip| ip == address))
        }
        Some(address) => match validate_probe_target(address) {
            Err(_) => None,
            Ok(()) => match tokio::net::lookup_host((address, port)).await {
                Err(_) => None,
                Ok(addrs) => {
                    let theirs: std::collections::HashSet<String> =
                        addrs.map(|a| a.ip().to_string()).collect();
                    Some(resolved.iter().any(|ip| theirs.contains(ip)))
                }
            },
        },
    };

    Ok(ResolveProbe {
        resolved,
        error,
        matches_gateway,
    })
}

/// One timed TCP connection from this machine.
/// Why a TCP probe did not connect, where this app recognises the failure.
///
/// The name rather than the sentence: a string composed here has no path
/// into the catalogue, and the trace panel renders this field beside a dozen
/// siblings that all speak the reader's language.
#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TcpProbeReason {
    /// The address answers and nothing listens on the port.
    Refused,
    /// The packets go unanswered — a firewall, or the wrong address.
    TimedOut,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TcpProbe {
    pub ms: Option<u64>,
    /// The operating system's own words, quoted rather than composed — kept
    /// for the failures below that this app has no name for.
    pub error: Option<String>,
    pub reason: Option<TcpProbeReason>,
}

/// A probe target is a hostname OR an address literal — a Gateway's
/// published address is often an IP, and IPv6 colons are no less valid
/// for being un-DNS-like.
fn validate_probe_target(target: &str) -> Result<()> {
    if target.parse::<std::net::IpAddr>().is_ok() {
        return Ok(());
    }
    crate::validation::validate_dns_subdomain(target)
}

#[tauri::command]
pub async fn probe_tcp_connect(address: String, port: u16) -> Result<TcpProbe> {
    use std::time::{Duration, Instant};

    validate_probe_target(&address)?;

    let started = Instant::now();
    let (ms, error, reason) = match tokio::time::timeout(
        Duration::from_secs(3),
        tokio::net::TcpStream::connect((address.as_str(), port)),
    )
    .await
    {
        Ok(Ok(_)) => (
            Some(u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)),
            None,
            None,
        ),
        // A refusal and a timeout are different diagnoses, and both are ones
        // this app has a name for — so it hands over the name and lets the
        // panel say it in the reader's language. Anything else is the
        // operating system's own words, quoted.
        Ok(Err(err)) if err.kind() == std::io::ErrorKind::ConnectionRefused => {
            (None, None, Some(TcpProbeReason::Refused))
        }
        Ok(Err(err)) => (None, Some(err.to_string()), None),
        Err(_) => (None, None, Some(TcpProbeReason::TimedOut)),
    };

    Ok(TcpProbe { ms, error, reason })
}
