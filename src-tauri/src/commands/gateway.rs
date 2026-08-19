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
    GatewayApiDetection, GatewayClassInfo, GatewayInfo, ListenerSetInfo, RouteInfo,
    GATEWAY_API_GROUP,
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
        other => {
            return Err(Error::InvalidInput(format!(
                "not a Gateway API kind this app reads: {other}"
            )))
        }
    })
}

/// A dynamic API for one Gateway API kind, at the served version detection
/// picked. Errors with the CRD's own absence when the kind is not
/// installed — the sidebar should have kept the caller away, but a stale
/// window may still ask.
async fn gateway_api(
    kind: &str,
    namespace: Option<String>,
    listing: bool,
    state: &State<'_, AppState>,
) -> Result<(Api<DynamicObject>, ApiResource)> {
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
    let api_resource = served.api_resource();

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

/// Every ListenerSet in the cluster, or nothing where the kind is not
/// installed. Absence is ordinary — the kind graduated in Gateway API 1.5
/// and most bundles in the wild predate it — so "cannot list" reads as
/// "none", not as an error a Gateway page fails on.
async fn listener_sets(state: &State<'_, AppState>) -> Vec<ListenerSetInfo> {
    let Ok((api, api_resource)) = gateway_api("ListenerSet", None, true, state).await else {
        return Vec::new();
    };
    let Ok(list) = api.list(&build_list_params(None, None, None)).await else {
        return Vec::new();
    };
    list.items
        .into_iter()
        .map(|obj| ListenerSetInfo::read(&with_types(obj, &api_resource)))
        .collect()
}

#[tauri::command]
pub async fn list_gateways(
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<GatewayInfo>> {
    let (api, api_resource) = gateway_api("Gateway", namespace, true, &state).await?;
    let list = api.list(&build_list_params(None, None, None)).await?;
    let sets = listener_sets(&state).await;
    Ok(list
        .items
        .into_iter()
        .map(|obj| {
            let mut gateway = GatewayInfo::read(&with_types(obj, &api_resource));
            gateway.merge_listener_sets(&sets);
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
    gateway.merge_listener_sets(&listener_sets(&state).await);
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

fn require_route_kind(kind: &str) -> Result<()> {
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
