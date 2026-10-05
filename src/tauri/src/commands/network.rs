//! Network-related Tauri commands
//!
//! Commands for managing Ingresses and Endpoints.

use std::collections::{BTreeMap, HashMap};

use crate::error::Result;
use crate::resources::{
    published, selected_count, ChainStop, EndpointsInfo, Existence, IngressInfo, NetworkPolicyInfo,
    ObjectRef, ServiceInfo, ServicePublished,
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
use crate::commands::helpers::{
    across, api_in, get_resource_info, list_in_scope, list_resource_infos, ResourceContext, Scoped,
};

/// List Ingresses
#[tauri::command]
pub async fn list_ingresses(
    filters: Option<ResourceFilters>,
    state: State<'_, AppState>,
) -> Result<Vec<IngressInfo>> {
    list_resource_infos::<Ingress, IngressInfo>(filters, state).await
}

list_in_scope!(list_ingresses_in, Ingress, IngressInfo);

/// Every `NetworkPolicy` in scope, with how many pods each one actually picks.
///
/// The count is the whole reason this is not `list_in_scope!`. A policy
/// whose `podSelector` matches nothing is accepted, listed, and protects
/// nothing, and no other screen in this app can say so: the selector is in
/// one object and the labels are in another. One pod list per namespace read
/// answers it for every policy there at once, the same arithmetic
/// `list_service_endpoints` does above.
///
/// **A refused pod list leaves the count `None`, never zero.** Zero is the
/// finding this page exists for; a reader without `list pods` must not be
/// handed it.
#[tauri::command]
pub async fn list_network_policies_in(
    scope: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<Scoped<NetworkPolicyInfo>> {
    let client = (*state.current_client()?).clone();
    across(scope, |reach| policies_in(client.clone(), reach)).await
}

async fn policies_in(
    client: kube::Client,
    reach: Option<String>,
) -> Result<Vec<NetworkPolicyInfo>> {
    let params = ListParams::default();
    let policies_api = api_in::<NetworkPolicy>(&client, reach.as_deref());
    let pods_api = api_in::<Pod>(&client, reach.as_deref());
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

list_in_scope!(list_endpoints_in, Endpoints, EndpointsInfo);

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

/// One namespace's Services as their health verdict reads them.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceHealthInputs {
    pub namespace: String,
    pub groups: Vec<ServiceHealthGroup>,
}

/// What `serviceHealthOf` reads of a Service and of what it publishes, and
/// nothing else, once for every Service in the namespace that reads the same.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceHealthGroup {
    pub names: Vec<String>,
    pub type_: String,
    pub selectorless: bool,
    pub ready: i32,
    pub draining: i32,
    pub not_ready: i32,
    pub unrouted: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop: Option<ChainStop>,
}

impl ServiceHealthGroup {
    /// A stop names its Service, so a Service with one stands alone.
    fn reads_like(&self, other: &Self) -> bool {
        self.stop.is_none()
            && other.stop.is_none()
            && self.type_ == other.type_
            && self.selectorless == other.selectorless
            && (self.ready, self.draining, self.not_ready, self.unrouted)
                == (other.ready, other.draining, other.not_ready, other.unrouted)
    }
}

/// The Services of a scope as their health verdict reads them, for the count
/// the shell keeps on every screen. `list_service_backing` carries each
/// Service whole, about 1.3 KiB apiece, past the IPC target at two hundred.
#[tauri::command]
pub async fn list_service_health_inputs(
    scope: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<Scoped<ServiceHealthInputs>> {
    let client = (*state.current_client()?).clone();
    across(scope, |reach| health_inputs_in(client.clone(), reach)).await
}

async fn health_inputs_in(
    client: kube::Client,
    reach: Option<String>,
) -> Result<Vec<ServiceHealthInputs>> {
    let ctx = ResourceContext {
        client,
        namespace: reach,
    };
    let (services, published) = published_in(&ctx).await?;
    Ok(health_inputs_of(&services, published))
}

fn health_inputs_of(
    services: &[Service],
    published: Vec<ServicePublished>,
) -> Vec<ServiceHealthInputs> {
    let mut by_namespace: BTreeMap<String, Vec<ServiceHealthGroup>> = BTreeMap::new();
    for (service, published) in services.iter().zip(published) {
        let spec = service.spec.as_ref();
        let read = ServiceHealthGroup {
            names: vec![service.name_any()],
            type_: spec
                .and_then(|s| s.type_.clone())
                .unwrap_or_else(|| "ClusterIP".to_string()),
            selectorless: spec
                .and_then(|s| s.selector.as_ref())
                .is_none_or(BTreeMap::is_empty),
            ready: published.ready,
            draining: published.draining,
            not_ready: published.not_ready,
            unrouted: published.unrouted,
            stop: published.stop,
        };
        let groups = by_namespace
            .entry(service.namespace().unwrap_or_default())
            .or_default();
        match groups.iter_mut().find(|group| group.reads_like(&read)) {
            Some(group) => group.names.extend(read.names),
            None => groups.push(read),
        }
    }
    by_namespace
        .into_iter()
        .map(|(namespace, groups)| ServiceHealthInputs { namespace, groups })
        .collect()
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

    let published = published_from_slices(&services, &slices.items);
    Ok((services, published))
}

fn published_from_slices(services: &[Service], slices: &[EndpointSlice]) -> Vec<ServicePublished> {
    let mut by_service: HashMap<(String, String), Vec<&EndpointSlice>> = HashMap::new();
    for slice in slices {
        let Some(name) = slice.labels().get(published::SERVICE_NAME_LABEL) else {
            continue;
        };
        by_service
            .entry((slice.namespace().unwrap_or_default(), name.clone()))
            .or_default()
            .push(slice);
    }

    services
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
        .collect()
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
    use crate::state::perf::{wire_len, IPC_LIMIT_BYTES, IPC_TARGET_BYTES};
    use k8s_openapi::api::core::v1::{ObjectReference, ServicePort, ServiceSpec};
    use k8s_openapi::api::discovery::v1::{Endpoint, EndpointConditions, EndpointPort};
    use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
    use kube::core::ObjectMeta;

    const APPS: [&str; 8] = [
        "checkout-api",
        "payments-gateway",
        "inventory-worker",
        "orders-db-proxy",
        "notifications",
        "search-indexer",
        "storefront-web",
        "auth-session-cache",
    ];

    fn map(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    /// Helm-shaped Services in fifty namespaces with one to four addresses,
    /// none of them ready where `down` says so.
    fn synthetic(n: usize, down: impl Fn(usize) -> bool) -> (Vec<Service>, Vec<EndpointSlice>) {
        (0..n)
            .map(|i| {
                let app = APPS[i % APPS.len()];
                let name = format!("{app}-{i:04}");
                let namespace = format!("team-{:02}", i % 50);
                let service = Service {
                    metadata: ObjectMeta {
                        name: Some(name.clone()),
                        namespace: Some(namespace.clone()),
                        uid: Some(format!("7d0f3c2a-{i:04}-4b1e-9a6f-2c8d5e7b1a90")),
                        labels: Some(map(&[
                            ("app.kubernetes.io/name", app),
                            ("app.kubernetes.io/instance", &name),
                            ("app.kubernetes.io/managed-by", "Helm"),
                            ("helm.sh/chart", "service-1.4.2"),
                        ])),
                        annotations: Some(map(&[
                            ("meta.helm.sh/release-name", &name),
                            ("meta.helm.sh/release-namespace", &namespace),
                        ])),
                        ..Default::default()
                    },
                    spec: Some(ServiceSpec {
                        type_: Some("ClusterIP".to_string()),
                        cluster_ip: Some(format!("10.96.{}.{}", i / 250, i % 250)),
                        selector: Some(map(&[
                            ("app.kubernetes.io/name", app),
                            ("app.kubernetes.io/instance", &name),
                        ])),
                        ports: Some(vec![ServicePort {
                            name: Some("http".to_string()),
                            port: 80,
                            target_port: Some(IntOrString::String("http".to_string())),
                            protocol: Some("TCP".to_string()),
                            ..Default::default()
                        }]),
                        ..Default::default()
                    }),
                    ..Default::default()
                };
                let up = !down(i);
                let endpoints = (0..=i % 4)
                    .map(|e| Endpoint {
                        addresses: vec![format!("10.244.{}.{}", i / 120, (i * 2 + e) % 250)],
                        conditions: Some(EndpointConditions {
                            ready: Some(up),
                            serving: Some(up),
                            terminating: Some(false),
                        }),
                        node_name: Some(format!("worker-{}", e + 1)),
                        target_ref: Some(ObjectReference {
                            kind: Some("Pod".to_string()),
                            name: Some(format!("{name}-6d8f9c7b5-{e}x2kq")),
                            namespace: Some(namespace.clone()),
                            ..Default::default()
                        }),
                        ..Default::default()
                    })
                    .collect();
                let slice = EndpointSlice {
                    metadata: ObjectMeta {
                        name: Some(format!("{name}-h7x2p")),
                        namespace: Some(namespace),
                        labels: Some(map(&[(published::SERVICE_NAME_LABEL, &name)])),
                        ..Default::default()
                    },
                    address_type: "IPv4".to_string(),
                    endpoints,
                    ports: Some(vec![EndpointPort {
                        name: Some("http".to_string()),
                        port: Some(8080),
                        protocol: Some("TCP".to_string()),
                        ..Default::default()
                    }]),
                };
                (service, slice)
            })
            .unzip()
    }

    /// The shell asks this on every screen. Fails when 2000 Services no
    /// longer fit half the IPC target, the other half being room for names
    /// longer than these twenty characters; the whole `ServiceInfo` passed
    /// the full target at about two hundred.
    #[test]
    fn two_thousand_services_fit_half_the_ipc_target() {
        let (services, slices) = synthetic(2000, |i| i % 50 == 7);
        let published = published_from_slices(&services, &slices);
        let whole = wire_len(&ServiceBacking {
            services: services.iter().map(ServiceInfo::from).collect(),
            published: published.clone(),
        });
        let compact = wire_len(&Scoped::whole(health_inputs_of(&services, published)));
        eprintln!(
            "2000 Services: {} B per Service whole, {} B compact, {compact} B in one message",
            whole / 2000,
            compact / 2000
        );
        assert!(
            compact <= IPC_TARGET_BYTES / 2,
            "{compact} bytes for 2000 Services"
        );
    }

    /// A Service with a stop stands alone, so a scope where nothing is ready
    /// is the most this answer weighs. Fails if that outgrows one message.
    #[test]
    fn two_thousand_services_with_nothing_ready_stay_under_the_ipc_limit() {
        let (services, slices) = synthetic(2000, |_| true);
        let published = published_from_slices(&services, &slices);
        let compact = wire_len(&Scoped::whole(health_inputs_of(&services, published)));
        eprintln!("2000 Services, none ready: {compact} B in one message");
        assert!(compact < IPC_LIMIT_BYTES, "{compact} bytes");
    }

    /// The compact answer is the full one cut down and grouped, not a second
    /// reading of the cluster. Fails if a count or the stop is read afresh,
    /// if a Service is dropped or doubled, if two Services that read
    /// differently share a group, or if one with no selector or no type is
    /// described differently.
    #[test]
    fn the_compact_answer_is_the_full_one_cut_down() {
        let (mut services, slices) = synthetic(200, |i| i % 50 == 7);
        services[1].spec.as_mut().expect("a spec").selector = None;
        services[2].spec.as_mut().expect("a spec").type_ = None;
        let published = published_from_slices(&services, &slices);
        let inputs = health_inputs_of(&services, published.clone());

        assert_eq!(inputs.len(), 50);
        let named: usize = inputs
            .iter()
            .flat_map(|ns| &ns.groups)
            .map(|group| group.names.len())
            .sum();
        assert_eq!(named, services.len());
        let group = |service: &Service| {
            let name = service.name_any();
            inputs
                .iter()
                .find(|ns| Some(&ns.namespace) == service.namespace().as_ref())
                .and_then(|ns| ns.groups.iter().find(|group| group.names.contains(&name)))
                .cloned()
                .expect("a group for every Service")
        };
        for (service, full) in services.iter().zip(&published) {
            let group = group(service);
            assert_eq!(
                (group.ready, group.draining, group.not_ready, group.unrouted),
                (full.ready, full.draining, full.not_ready, full.unrouted)
            );
            assert_eq!(
                serde_json::to_value(&group.stop).expect("json"),
                serde_json::to_value(&full.stop).expect("json")
            );
        }
        assert!(group(&services[7]).stop.is_some());
        assert_eq!(group(&services[7]).names.len(), 1);
        assert!(group(&services[1]).selectorless);
        assert!(!group(&services[0]).selectorless);
        assert_eq!(group(&services[2]).type_, "ClusterIP");
        assert!(group(&services[0]).names.len() > 1);
    }

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
