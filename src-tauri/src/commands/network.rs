//! Network-related Tauri commands
//!
//! Commands for managing Ingresses and Endpoints.

use crate::error::Result;
use crate::resources::{EndpointsInfo, IngressInfo};
use crate::state::AppState;
use k8s_openapi::api::core::v1::Endpoints;
use k8s_openapi::api::networking::v1::Ingress;
use tauri::State;

use crate::commands::filters::ResourceFilters;
use crate::commands::helpers::{get_resource_info, list_resource_infos};

/// List Ingresses
#[tauri::command]
pub async fn list_ingresses(
    filters: Option<ResourceFilters>,
    state: State<'_, AppState>,
) -> Result<Vec<IngressInfo>> {
    list_resource_infos::<Ingress, IngressInfo>(filters, state).await
}

/// List Endpoints
#[tauri::command]
pub async fn list_endpoints(
    filters: Option<ResourceFilters>,
    state: State<'_, AppState>,
) -> Result<Vec<EndpointsInfo>> {
    list_resource_infos::<Endpoints, EndpointsInfo>(filters, state).await
}

/// Get a single Ingress by name
#[tauri::command]
pub async fn get_ingress(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<IngressInfo> {
    crate::validation::validate_dns_subdomain(&name)?;
    get_resource_info::<Ingress, IngressInfo>(name, namespace, state).await
}

/// Which controller will pick an Ingress up — including "none will".
///
/// An Ingress object is a request, not a fact: something has to claim it.
/// An `ingressClassName` no running controller claims looks perfectly
/// configured — correct YAML, no events, no error — and is simply never
/// served. `IngressClass` is a built-in kind, so this is core.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngressClassBinding {
    /// `spec.ingressClassName`, or `None` where the Ingress named none and
    /// is relying on the cluster's default.
    pub requested: Option<String>,
    /// The IngressClass that answers for it.
    pub resolved: Option<String>,
    /// `spec.controller` on that class — the implementation, in its own
    /// words, which is the part that says whether it is Traefik or nginx.
    pub controller: Option<String>,
    /// Whether `resolved` was found through the default-class annotation
    /// rather than by name.
    pub via_default: bool,
    /// Every class this cluster has. Named so an unmatched request can say
    /// what it could have asked for instead — and carrying each class's own
    /// controller, so a caller asking "which classes does *this* controller
    /// claim" gets its answer from this list rather than from one further
    /// call per class, each of which would list the same collection again.
    pub available: Vec<IngressClassSummary>,
}

/// One IngressClass, and the controller that answers for it.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngressClassSummary {
    pub name: String,
    /// `spec.controller`. Optional because the field is, though a class
    /// without one is claimed by nothing.
    pub controller: Option<String>,
    /// Carries the default-class annotation, so an Ingress that names no
    /// class lands here.
    pub is_default: bool,
}

const DEFAULT_CLASS_ANNOTATION: &str = "ingressclass.kubernetes.io/is-default-class";

#[tauri::command]
pub async fn resolve_ingress_class(
    class_name: Option<String>,
    state: State<'_, AppState>,
) -> Result<IngressClassBinding> {
    use kube::ResourceExt;

    let classes = crate::commands::helpers::list_cluster_resources::<
        k8s_openapi::api::networking::v1::IngressClass,
    >(state, None, None, None)
    .await?;

    let is_default = |c: &k8s_openapi::api::networking::v1::IngressClass| {
        c.annotations()
            .get(DEFAULT_CLASS_ANNOTATION)
            .map(String::as_str)
            == Some("true")
    };

    let available: Vec<IngressClassSummary> = classes
        .items
        .iter()
        .map(|c| IngressClassSummary {
            name: c.name_any(),
            controller: c.spec.as_ref().and_then(|s| s.controller.clone()),
            is_default: is_default(c),
        })
        .collect();

    let (matched, via_default) = match &class_name {
        Some(wanted) => (
            classes.items.iter().find(|c| c.name_any() == *wanted),
            false,
        ),
        None => (classes.items.iter().find(|c| is_default(c)), true),
    };

    Ok(IngressClassBinding {
        requested: class_name,
        resolved: matched.map(ResourceExt::name_any),
        controller: matched.and_then(|c| c.spec.as_ref()?.controller.clone()),
        via_default: via_default && matched.is_some(),
        available,
    })
}

/// Delete an Ingress
#[tauri::command]
pub async fn delete_ingress(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<()> {
    crate::validation::validate_dns_subdomain(&name)?;
    crate::commands::helpers::delete_resource::<Ingress>(name, namespace, state, None).await
}

/// Get a single Endpoints resource by name
#[tauri::command]
pub async fn get_endpoints(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<EndpointsInfo> {
    crate::validation::validate_dns_label(&name)?;
    get_resource_info::<Endpoints, EndpointsInfo>(name, namespace, state).await
}

/// Delete an Endpoints resource
#[tauri::command]
pub async fn delete_endpoints(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<()> {
    crate::validation::validate_dns_label(&name)?;
    crate::commands::helpers::delete_resource::<Endpoints>(name, namespace, state, None).await
}
