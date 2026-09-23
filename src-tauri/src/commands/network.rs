//! Network-related Tauri commands
//!
//! Commands for managing Ingresses and Endpoints.

use std::collections::HashMap;

use crate::error::Result;
use crate::resources::{
    published, selected_count, EndpointsInfo, Existence, IngressInfo, NetworkPolicyInfo, ObjectRef,
    ServiceInfo, ServicePublished,
};
use crate::state::AppState;
use k8s_openapi::api::core::v1::{Endpoints, Pod, Service};
use k8s_openapi::api::discovery::v1::EndpointSlice;
use k8s_openapi::api::networking::v1::{Ingress, NetworkPolicy};
use kube::api::ListParams;
use kube::ResourceExt;
use serde::Serialize;
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

/// Every `NetworkPolicy` in scope, with how many pods each one actually picks.
///
/// The count is the whole reason this is not `list_resource_infos`. A policy
/// whose `podSelector` matches nothing is accepted, listed, and protects
/// nothing, and no other screen in this app can say so: the selector is in
/// one object and the labels are in another. One pod list for the scope
/// answers it for every policy at once, the same arithmetic
/// `list_service_endpoints` does above.
///
/// **A refused pod list leaves the count `None`, never zero.** Zero is the
/// finding this page exists for; a reader without `list pods` must not be
/// handed it.
#[tauri::command]
pub async fn list_network_policies(
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<NetworkPolicyInfo>> {
    let ctx = ResourceContext::for_list(&state, namespace)?;
    let params = ListParams::default();
    let policies_api = ctx.namespaced_or_cluster_api::<NetworkPolicy>();
    let pods_api = ctx.namespaced_or_cluster_api::<Pod>();
    // Metadata only: the question is which labels a pod carries, and the
    // bodies are the whole weight of a pod list on a cluster with ten
    // thousand of them — pulled on every poll of this page.
    let (policies, pods) =
        tokio::join!(policies_api.list(&params), pods_api.list_metadata(&params));
    let policies = policies?.items;
    let pods = pods.ok().map(|list| list.items);

    Ok(crate::resources::joined_to_pods(&policies, pods.as_deref()))
}

/// One `NetworkPolicy`, with the same pod count the list carries.
///
/// The count is read here too rather than carried over from the list: the
/// detail page is reachable by a pasted link, and a page that could only
/// count when the list had been opened first would show a blank where the
/// list showed a number.
#[tauri::command]
pub async fn get_network_policy(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<NetworkPolicyInfo> {
    crate::validation::validate_dns_subdomain(&name)?;
    let ctx = ResourceContext::for_command(&state, namespace)?;
    let policy = ctx.namespaced_api::<NetworkPolicy>().get(&name).await?;
    let mut info = NetworkPolicyInfo::from(&policy);

    let selector = policy.spec.as_ref().and_then(|s| s.pod_selector.as_ref());
    // A refused pod list leaves the count `None`, never zero. Zero is the
    // finding this page exists for; a reader without `list pods` must not be
    // handed it.
    if let Ok(pods) = ctx
        .namespaced_api::<Pod>()
        .list_metadata(&ListParams::default())
        .await
    {
        info.selected = selected_count(selector, &pods.items);
    }
    Ok(info)
}

/// Delete a `NetworkPolicy`
#[tauri::command]
pub async fn delete_network_policy(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<()> {
    crate::commands::helpers::delete_resource::<NetworkPolicy>(name, namespace, state, None).await
}

/// List Endpoints
#[tauri::command]
pub async fn list_endpoints(
    filters: Option<ResourceFilters>,
    state: State<'_, AppState>,
) -> Result<Vec<EndpointsInfo>> {
    list_resource_infos::<Endpoints, EndpointsInfo>(filters, state).await
}

/// What every Service in scope publishes, read off its own `EndpointSlices`.
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
    Ok(published_in(&ctx).await?.1)
}

/// Every Service in scope and what each publishes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceBacking {
    pub services: Vec<ServiceInfo>,
    pub published: Vec<ServicePublished>,
}

/// The Services and their answers from one list of each — what every routing
/// page reads to say what is behind a route, without listing Services twice.
#[tauri::command]
pub async fn list_service_backing(
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<ServiceBacking> {
    let ctx = ResourceContext::for_list(&state, namespace)?;
    let (services, published) = published_in(&ctx).await?;
    Ok(ServiceBacking {
        services: services.iter().map(ServiceInfo::from).collect(),
        published,
    })
}

async fn published_in(ctx: &ResourceContext) -> Result<(Vec<Service>, Vec<ServicePublished>)> {
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
        let published = services
            .iter()
            .map(|svc| {
                published::from_legacy(
                    svc,
                    service_ref(svc),
                    legacy.iter().find(|ep| {
                        ep.name_any() == svc.name_any() && ep.namespace() == svc.namespace()
                    }),
                )
                .with_stop(svc, None)
                .summary()
            })
            .collect();
        return Ok((services, published));
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

    let published = services
        .iter()
        .map(|svc| {
            let key = (svc.namespace().unwrap_or_default(), svc.name_any());
            published::from_slices(
                svc,
                service_ref(svc),
                by_service.get(&key).map_or(&[][..], Vec::as_slice),
                &[],
            )
            .with_stop(svc, None)
            .summary()
        })
        .collect();
    Ok((services, published))
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
    /// The `IngressClass` that answers for it.
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

/// One `IngressClass`, and the controller that answers for it.
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
    /// `spec.parameters`: the controller-specific object the class names.
    pub parameters: Option<IngressClassParameters>,
}

/// An `IngressClass`'s `spec.parameters`, as written.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngressClassParameters {
    pub api_group: Option<String>,
    pub kind: String,
    pub name: String,
    pub scope: Option<String>,
    pub namespace: Option<String>,
}

const DEFAULT_CLASS_ANNOTATION: &str = "ingressclass.kubernetes.io/is-default-class";

fn is_default(c: &k8s_openapi::api::networking::v1::IngressClass) -> bool {
    c.annotations()
        .get(DEFAULT_CLASS_ANNOTATION)
        .map(String::as_str)
        == Some("true")
}

fn summary_of(c: &k8s_openapi::api::networking::v1::IngressClass) -> IngressClassSummary {
    IngressClassSummary {
        name: c.name_any(),
        controller: c.spec.as_ref().and_then(|s| s.controller.clone()),
        is_default: is_default(c),
        parameters: c
            .spec
            .as_ref()
            .and_then(|s| s.parameters.as_ref())
            .map(|p| IngressClassParameters {
                api_group: p.api_group.clone(),
                kind: p.kind.clone(),
                name: p.name.clone(),
                scope: p.scope.clone(),
                namespace: p.namespace.clone(),
            }),
    }
}

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

    let available: Vec<IngressClassSummary> = classes.items.iter().map(summary_of).collect();

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
    crate::commands::helpers::delete_resource::<Ingress>(name, namespace, state, None).await
}

/// Get a single Endpoints resource by name
#[tauri::command]
pub async fn get_endpoints(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<EndpointsInfo> {
    get_resource_info::<Endpoints, EndpointsInfo>(name, namespace, state).await
}

/// Delete an Endpoints resource
#[tauri::command]
pub async fn delete_endpoints(
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<()> {
    crate::commands::helpers::delete_resource::<Endpoints>(name, namespace, state, None).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The ALB page joins a class to its `IngressClassParams` through this
    /// reference, and the summary is now the only way it arrives: dropped
    /// here, every class reads as configured by nothing.
    #[test]
    fn a_class_summary_carries_the_parameters_it_names() {
        let class: k8s_openapi::api::networking::v1::IngressClass =
            serde_json::from_value(serde_json::json!({
                "metadata": { "name": "alb" },
                "spec": {
                    "controller": "ingress.k8s.aws/alb",
                    "parameters": {
                        "apiGroup": "elbv2.k8s.aws",
                        "kind": "IngressClassParams",
                        "name": "internet-facing"
                    }
                }
            }))
            .expect("an IngressClass");
        let summary = summary_of(&class);
        let parameters = summary.parameters.expect("the reference");
        assert_eq!(parameters.kind, "IngressClassParams");
        assert_eq!(parameters.name, "internet-facing");
        assert_eq!(parameters.api_group.as_deref(), Some("elbv2.k8s.aws"));
    }
}
