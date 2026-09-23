//! Gateway API Tauri commands.
//!
//! Every read goes through a dynamic API pinned to the version detection
//! chose (see [`GatewayApiDetection`]): `v1` where served, `v1beta1` on
//! early-GKE-era bundles, `v1alpha2` for the route trio before Gateway API
//! 1.5/1.6. The conversion layer in `resources::gateway` is one tolerant
//! baseline over all of them, so the commands' whole version job is picking
//! the apiVersion to ask the server for.

use std::future::Future;

use kube::api::{Api, DeleteParams, DynamicObject, TypeMeta};
use kube::discovery::ApiResource;
use tauri::State;

use crate::commands::helpers::{across, build_list_params, ResourceContext, Scoped};
use crate::error::{Error, Result};
use crate::resources::{
    BackendTlsPolicyInfo, GatewayApiDetection, GatewayClassInfo, GatewayInfo, ListenerSetInfo,
    RouteInfo, GATEWAY_API_GROUP,
};
use crate::state::AppState;

/// The five kinds `list_gateway_routes` answers for.
const ROUTE_KINDS: [&str; 5] = ["HTTPRoute", "GRPCRoute", "TLSRoute", "TCPRoute", "UDPRoute"];

pub(crate) fn plural_of(kind: &str) -> Result<&'static str> {
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

pub(crate) fn is_cluster_scoped(kind: &str) -> bool {
    kind == "GatewayClass"
}

/// The dynamic-API coordinates for one Gateway API kind, at the served
/// version detection picks. Errors with the CRD's own absence when the
/// kind is not installed — the sidebar should have kept the caller away,
/// but a stale window may still ask.
pub(crate) async fn served_api_resource(kind: &str, state: &AppState) -> Result<ApiResource> {
    let plural = plural_of(kind)?;
    let mine: Vec<_> = state
        .served_kind(GATEWAY_API_GROUP, plural)
        .await?
        .into_iter()
        .collect();
    let detection = GatewayApiDetection::read([], &mine);
    let served = detection.kinds.first().ok_or_else(|| Error::NotFound {
        kind: "CustomResourceDefinition".to_string(),
        name: format!("{plural}.{GATEWAY_API_GROUP}"),
        namespace: String::new(),
    })?;
    Ok(served.api_resource())
}

/// An answer from where discovery put the kind, and a 404 taken as discovery
/// having moved on: the next call looks again rather than trusting a version
/// the cluster may have stopped serving.
pub(crate) fn answered<T>(state: &AppState, answer: kube::Result<T>) -> Result<T> {
    if matches!(&answer, Err(kube::Error::Api(status)) if status.code == 404) {
        state.forget_served(GATEWAY_API_GROUP);
    }
    answer.map_err(Error::from)
}

/// One request on a Gateway API kind, at the served version, and what it
/// was asked at. Every get and delete here goes through this, and every
/// list but `read_in`'s, which takes the same rule from `answered` — so none
/// of them takes a 404 at its word. A get that did was a detail page saying
/// "not found" until discovery aged out.
async fn on_served<T, Fut>(
    state: &AppState,
    kind: &str,
    namespace: Option<String>,
    listing: bool,
    request: impl FnOnce(Api<DynamicObject>) -> Fut,
) -> Result<(T, ApiResource)>
where
    Fut: Future<Output = kube::Result<T>>,
{
    let api_resource = served_api_resource(kind, state).await?;

    let cluster_scoped = is_cluster_scoped(kind);
    let ctx = if cluster_scoped {
        ResourceContext::for_list(state, None)?
    } else if listing {
        ResourceContext::for_list(state, namespace)?
    } else {
        ResourceContext::for_command(state, namespace)?
    };

    let answer = request(ctx.dynamic_api_for_resource(&api_resource, cluster_scoped)).await;
    Ok((answered(state, answer)?, api_resource))
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
    let context = state
        .get_current_context()
        .ok_or_else(|| Error::Internal(crate::error::messages::NO_CLUSTER.to_string()))?;
    let client = state.current_client()?;
    crate::resources::discover_gateway_api(&client, state.client_manager.served(), &context).await
}

#[tauri::command]
pub async fn list_gateway_classes(state: State<'_, AppState>) -> Result<Vec<GatewayClassInfo>> {
    let (list, api_resource) = on_served(&state, "GatewayClass", None, true, |api| async move {
        api.list(&build_list_params(None, None, None)).await
    })
    .await?;
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
    let (list, api_resource) = on_served(
        &state,
        "BackendTLSPolicy",
        namespace,
        true,
        |api| async move { api.list(&build_list_params(None, None, None)).await },
    )
    .await?;
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
    let (obj, api_resource) = on_served(&state, "GatewayClass", None, false, |api| async move {
        api.get(&name).await
    })
    .await?;
    Ok(GatewayClassInfo::read(&with_types(obj, &api_resource)))
}

#[tauri::command]
pub async fn delete_gateway_class(name: String, state: State<'_, AppState>) -> Result<()> {
    crate::validation::validate_dns_subdomain(&name)?;
    on_served(&state, "GatewayClass", None, false, |api| async move {
        api.delete(&name, &DeleteParams::default()).await
    })
    .await?;
    Ok(())
}

/// Every `ListenerSet` in the cluster, or nothing where the kind is not
/// installed. Absence is ordinary — the kind graduated in Gateway API 1.5
/// and most bundles in the wild predate it — so "cannot list" reads as
/// "none", not as an error a Gateway page fails on.
async fn listener_sets(state: &AppState) -> Option<Vec<ListenerSetInfo>> {
    // `None` where the kind is absent *or* the list was refused, `Some` for a
    // real answer including an empty one. The two used to be the same value,
    // which cost nothing while the only consumer was the listener fold — a
    // few rows missing from a table. It stopped being free the moment a route
    // could resolve its parent through this list: an unread list then reads
    // as "no set by that name", and the route's Gateway as missing.
    let (list, api_resource) = on_served(state, "ListenerSet", None, true, |api| async move {
        api.list(&build_list_params(None, None, None)).await
    })
    .await
    .ok()?;
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
    // The ListenerSet probe answers "none" on its own errors, so the two
    // reads race instead of queuing — one round trip of latency, not two.
    let (gateways, sets) = tokio::join!(
        on_served(&state, "Gateway", namespace, true, |api| async move {
            api.list(&build_list_params(None, None, None)).await
        }),
        listener_sets(&state)
    );
    let (list, api_resource) = gateways?;
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

/// The Gateways page's read: one LIST per namespace of the scope, and the
/// `ListenerSets` once for all of them.
#[tauri::command]
pub async fn list_gateways_in(
    scope: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<Scoped<GatewayInfo>> {
    let api_resource = served_api_resource("Gateway", &state).await?;
    let client = (*state.current_client()?).clone();
    let (gateways, sets) = tokio::join!(
        across(scope, |reach| {
            read_in(&state, &client, &api_resource, reach, GatewayInfo::read)
        }),
        listener_sets(&state),
    );
    let mut gateways = gateways?;
    for gateway in &mut gateways.rows {
        gateway.merge_listener_sets(sets.as_deref());
    }
    Ok(gateways)
}

/// One namespaced Gateway API kind in one reach, each object read by `read`.
async fn read_in<T>(
    state: &AppState,
    client: &kube::Client,
    api_resource: &ApiResource,
    reach: Option<String>,
    read: fn(&DynamicObject) -> T,
) -> Result<Vec<T>> {
    let api: Api<DynamicObject> = match reach.as_deref() {
        Some(namespace) => Api::namespaced_with(client.clone(), namespace, api_resource),
        None => Api::all_with(client.clone(), api_resource),
    };
    let list = answered(state, api.list(&build_list_params(None, None, None)).await)?;
    Ok(list
        .items
        .into_iter()
        .map(|obj| read(&with_types(obj, api_resource)))
        .collect())
}

#[tauri::command]
pub async fn get_gateway(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<GatewayInfo> {
    crate::validation::validate_dns_subdomain(&name)?;
    let (obj, api_resource) = on_served(&state, "Gateway", namespace, false, |api| async move {
        api.get(&name).await
    })
    .await?;
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
    on_served(&state, "Gateway", namespace, false, |api| async move {
        api.delete(&name, &DeleteParams::default()).await
    })
    .await?;
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
    let (list, api_resource) = on_served(&state, &kind, namespace, true, |api| async move {
        api.list(&build_list_params(None, None, None)).await
    })
    .await?;
    Ok(list
        .items
        .into_iter()
        .map(|obj| RouteInfo::read(&with_types(obj, &api_resource)))
        .collect())
}

/// One route kind across the scope, one LIST per namespace.
#[tauri::command]
pub async fn list_gateway_routes_in(
    kind: String,
    scope: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<Scoped<RouteInfo>> {
    require_route_kind(&kind)?;
    let api_resource = served_api_resource(&kind, &state).await?;
    let client = (*state.current_client()?).clone();
    across(scope, |reach| {
        read_in(&state, &client, &api_resource, reach, RouteInfo::read)
    })
    .await
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
    let (obj, api_resource) = on_served(&state, &kind, namespace, false, |api| async move {
        api.get(&name).await
    })
    .await?;
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
    on_served(&state, &kind, namespace, false, |api| async move {
        api.delete(&name, &DeleteParams::default()).await
    })
    .await?;
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

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use crate::client::served::test_server::{connected, failure, groups, resources};
    use crate::client::served::ServedIndex;
    use crate::resources::RouteInfo;

    const V1: &str = "/apis/gateway.networking.k8s.io/v1";

    /// Would leave every Gateway saying its sets are unknown for a minute
    /// after a bundle upgrade adds `ListenerSet`: Gateway kinds were resolved
    /// from the whole group's answer, which cannot miss, so the rule that a
    /// miss asks again reached search and CRD pages and never these.
    #[tokio::test]
    async fn a_listener_set_added_to_a_group_already_read_is_found_on_the_next_miss() {
        let served = ServedIndex::aged(Duration::from_mins(1), Duration::from_millis(100));
        let (state, _) = connected(served, |path, nth| match path {
            "/apis" => (200, groups("v1", &["v1"])),
            V1 if nth == 1 => (200, resources("v1", &[("gateways", "Gateway", true)])),
            V1 => (
                200,
                resources(
                    "v1",
                    &[
                        ("gateways", "Gateway", true),
                        ("listenersets", "ListenerSet", true),
                    ],
                ),
            ),
            "/apis/gateway.networking.k8s.io/v1/listenersets" => (
                200,
                serde_json::json!({
                    "kind": "ListenerSetList",
                    "apiVersion": "gateway.networking.k8s.io/v1",
                    "metadata": {},
                    "items": [],
                })
                .to_string(),
            ),
            _ => failure(404, "NotFound"),
        })
        .await;

        assert!(super::listener_sets(&state).await.is_none());
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(
            super::listener_sets(&state).await.map(|sets| sets.len()),
            Some(0)
        );
    }

    /// Would keep a Gateway or route page on "not found" until discovery aged
    /// out, when the version it was read at stopped being served: a 404 from
    /// a get, a delete or a namespace's list sends discovery back.
    #[tokio::test]
    async fn a_404_on_a_gateway_kind_has_discovery_read_again() {
        let (state, hits) = connected(ServedIndex::default(), |path, _| match path {
            "/apis" => (200, groups("v1", &["v1"])),
            V1 => (200, resources("v1", &[("httproutes", "HTTPRoute", true)])),
            _ => failure(404, "NotFound"),
        })
        .await;
        let asked = || hits.lock().unwrap().get("/apis").copied();
        let get = || {
            super::on_served(
                &state,
                "HTTPRoute",
                Some("default".to_string()),
                false,
                |api| async move { api.get("gone").await },
            )
        };

        assert!(get().await.is_err());
        assert_eq!(asked(), Some(1));
        assert!(get().await.is_err());
        assert_eq!(asked(), Some(2), "a get's 404 sent discovery back");

        let api_resource = super::served_api_resource("HTTPRoute", &state)
            .await
            .expect("served");
        assert_eq!(asked(), Some(3));
        let client = (*state.current_client().expect("client")).clone();
        let listed = super::read_in(
            &state,
            &client,
            &api_resource,
            Some("default".to_string()),
            RouteInfo::read,
        )
        .await;
        assert!(listed.is_err());
        assert!(get().await.is_err());
        assert_eq!(asked(), Some(4), "a namespace's 404 sent it back too");
    }
}
