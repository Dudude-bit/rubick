//! Network-related Tauri commands
//!
//! Commands for managing Ingresses and Endpoints.

use std::collections::HashMap;

use crate::error::Result;
use crate::resources::{
    published, EndpointsInfo, Existence, IngressInfo, ObjectRef, ServicePublished,
};
use crate::state::AppState;
use k8s_openapi::api::core::v1::{Endpoints, Service};
use k8s_openapi::api::discovery::v1::EndpointSlice;
use k8s_openapi::api::networking::v1::Ingress;
use kube::api::ListParams;
use kube::ResourceExt;
use tauri::State;

use crate::commands::filters::ResourceFilters;
use crate::commands::helpers::{get_resource_info, list_resource_infos, ResourceContext};

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

/// What every Service in scope publishes, read off its own EndpointSlices.
///
/// One list of slices per scope, grouped by the `kubernetes.io/service-name`
/// label the controllers write — the answer for two hundred Services is two
/// lists and a pass over memory, not two hundred requests. Counts and the
/// source only: the endpoint rows are the Service page's business, and every
/// other caller here wants to know whether an address takes traffic.
#[tauri::command]
pub async fn list_service_endpoints(
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<ServicePublished>> {
    let ctx = ResourceContext::for_list(&state, namespace)?;
    let params = ListParams::default();
    let services_api = ctx.namespaced_or_cluster_api::<Service>();
    let slices_api = ctx.namespaced_or_cluster_api::<EndpointSlice>();
    let (services, slices) = tokio::join!(services_api.list(&params), slices_api.list(&params));
    let services = services?.items;

    // A cluster below 1.21 serves no `discovery.k8s.io/v1` at all, so the
    // legacy object answers and the reader is told which one did.
    let Ok(slices) = slices else {
        let legacy = ctx
            .namespaced_or_cluster_api::<Endpoints>()
            .list(&params)
            .await?
            .items;
        return Ok(services
            .iter()
            .map(|svc| {
                published::from_legacy(
                    svc,
                    service_ref(svc),
                    legacy.iter().find(|ep| {
                        ep.name_any() == svc.name_any() && ep.namespace() == svc.namespace()
                    }),
                )
                .summary()
            })
            .collect());
    };

    let mut by_service: HashMap<(String, String), Vec<&EndpointSlice>> = HashMap::new();
    for slice in &slices.items {
        let Some(name) = slice.labels().get(published::SERVICE_NAME_LABEL) else {
            continue;
        };
        by_service
            .entry((slice.namespace().unwrap_or_default(), name.clone()))
            .or_default()
            .push(slice);
    }

    Ok(services
        .iter()
        .map(|svc| {
            let key = (svc.namespace().unwrap_or_default(), svc.name_any());
            published::from_slices(
                svc,
                service_ref(svc),
                by_service.get(&key).map_or(&[][..], Vec::as_slice),
                &[],
            )
            .summary()
        })
        .collect())
}

fn service_ref(svc: &Service) -> ObjectRef {
    ObjectRef::new(
        "Service",
        &svc.name_any(),
        svc.namespace(),
        Existence::Present,
    )
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
