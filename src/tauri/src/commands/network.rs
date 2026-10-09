//! Network-related Tauri commands
//!
//! Commands for managing Ingresses and Endpoints.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use crate::error::Result;
use crate::resources::{
    published, selected_count, ChainStop, EndpointsInfo, Existence, IngressDefaultBackend,
    IngressInfo, IngressRule, IngressTlsConfig, NetworkPolicyInfo, NotServing, ObjectRef, Selector,
    ServiceInfo, ServicePublished,
};
use crate::state::AppState;
use k8s_openapi::api::apps::v1::{Deployment, StatefulSet};
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

/// What `ingressHealthOf` reads of an Ingress: its row without the labels,
/// the annotations and the TLS host summary, which are most of its weight.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IngressHealthInput {
    pub name: String,
    pub namespace: String,
    pub class_name: Option<String>,
    pub rules: Vec<IngressRule>,
    pub default_backend: Option<IngressDefaultBackend>,
    pub load_balancer_ips: Vec<String>,
    pub tls_configs: Vec<IngressTlsConfig>,
}

impl From<&Ingress> for IngressHealthInput {
    fn from(ingress: &Ingress) -> Self {
        let info = IngressInfo::from(ingress);
        Self {
            name: info.name,
            namespace: info.namespace,
            class_name: info.class_name,
            rules: info.rules,
            default_backend: info.default_backend,
            load_balancer_ips: info.load_balancer_ips,
            tls_configs: info.tls_configs,
        }
    }
}

list_in_scope!(list_ingress_health_inputs, Ingress, IngressHealthInput);

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

/// The slices say that no address of a Service is ready, or that it has
/// none, never why; the pods it selects do, and its page reads them. Asked
/// only for those Services, so a scope of healthy ones costs no more than
/// before. One whose selector then matches no pod is asked, once per
/// namespace, whether the workloads behind it are scaled to zero, and one
/// with none ready whether they are only waiting on their pods. A list that
/// fails leaves the answer it would have sharpened as it was.
async fn with_unready_cause(
    client: &kube::Client,
    services: &[Service],
    published: Vec<ServicePublished>,
) -> Vec<ServicePublished> {
    let asks = services
        .iter()
        .zip(published)
        .map(|(svc, published)| async move {
            let unexplained = matches!(
                published.stop,
                Some(
                    ChainStop::NoneReady {
                        why: NotServing::InSlices,
                        ..
                    } | ChainStop::PublishesNothingYet { .. }
                )
            );
            let selector = svc
                .spec
                .as_ref()
                .and_then(|s| s.selector.clone())
                .unwrap_or_default();
            let query = Selector::Equality(&selector).query_text();
            let (true, Some(query)) = (unexplained, query) else {
                return (published, None);
            };
            let pods: kube::Api<Pod> =
                kube::Api::namespaced(client.clone(), &svc.namespace().unwrap_or_default());
            match pods.list(&ListParams::default().labels(&query)).await {
                Ok(list) => {
                    let selected: Vec<&Pod> = list.items.iter().collect();
                    let published = published.with_stop(svc, Some(&selected));
                    (published, Some(list.items))
                }
                Err(_) => (published, None),
            }
        });
    let asked = futures::future::join_all(asks).await;
    let published = explain_waits(client, services, asked).await;
    explain_empty_selectors(client, services, published).await
}

/// Whether the workloads behind a Service with none ready are only waiting
/// on their pods, by [`published::waiting_on`]: one read of each kind per
/// namespace that has such a Service. `pods` is what the selector picked,
/// `None` where they were not read.
async fn explain_waits(
    client: &kube::Client,
    services: &[Service],
    asked: Vec<(ServicePublished, Option<Vec<Pod>>)>,
) -> Vec<ServicePublished> {
    let waiting: BTreeSet<String> = services
        .iter()
        .zip(&asked)
        .filter(|(_, (published, _))| matches!(published.stop, Some(ChainStop::NoneReady { .. })))
        .map(|(svc, _)| svc.namespace().unwrap_or_default())
        .collect();
    if waiting.is_empty() {
        return asked.into_iter().map(|(published, _)| published).collect();
    }
    let reads = waiting.into_iter().map(|ns| async move {
        let params = ListParams::default();
        let deployments: kube::Api<Deployment> = kube::Api::namespaced(client.clone(), &ns);
        let sets: kube::Api<StatefulSet> = kube::Api::namespaced(client.clone(), &ns);
        let (deployments, sets) = tokio::join!(deployments.list(&params), sets.list(&params));
        (ns, (items(deployments), items(sets)))
    });
    let read: HashMap<String, (Vec<Deployment>, Vec<StatefulSet>)> =
        futures::future::join_all(reads).await.into_iter().collect();
    let now = chrono::Utc::now();
    services
        .iter()
        .zip(asked)
        .map(
            |(svc, (published, pods))| match read.get(&svc.namespace().unwrap_or_default()) {
                Some((deployments, sets)) => {
                    let selected: Option<Vec<&Pod>> =
                        pods.as_ref().map(|pods| pods.iter().collect());
                    published.with_workloads(
                        svc,
                        &published::makers(deployments, sets),
                        selected.as_deref(),
                        now,
                    )
                }
                None => published,
            },
        )
        .collect()
}

type Behind = (Vec<Deployment>, Vec<StatefulSet>, Vec<Pod>);

fn items<K: Clone>(list: kube::Result<kube::core::ObjectList<K>>) -> Vec<K> {
    list.map(|list| list.items).unwrap_or_default()
}

/// What the pods cannot say about a Service whose selector matches none of
/// them: whether the workloads behind it are scaled to zero, and which pods
/// carry the most of it. One read of each kind per namespace that has one.
async fn explain_empty_selectors(
    client: &kube::Client,
    services: &[Service],
    published: Vec<ServicePublished>,
) -> Vec<ServicePublished> {
    let empty: BTreeSet<String> = services
        .iter()
        .zip(&published)
        .filter(|(_, published)| matches!(published.stop, Some(ChainStop::SelectsNothing { .. })))
        .map(|(svc, _)| svc.namespace().unwrap_or_default())
        .collect();
    if empty.is_empty() {
        return published;
    }
    let reads = empty.into_iter().map(|ns| async move {
        let params = ListParams::default();
        let deployments: kube::Api<Deployment> = kube::Api::namespaced(client.clone(), &ns);
        let sets: kube::Api<StatefulSet> = kube::Api::namespaced(client.clone(), &ns);
        let pods: kube::Api<Pod> = kube::Api::namespaced(client.clone(), &ns);
        let (deployments, sets, pods) = tokio::join!(
            deployments.list(&params),
            sets.list(&params),
            pods.list(&params)
        );
        (ns, (items(deployments), items(sets), items(pods)))
    });
    let read: HashMap<String, Behind> =
        futures::future::join_all(reads).await.into_iter().collect();
    services
        .iter()
        .zip(published)
        .map(
            |(svc, published)| match read.get(&svc.namespace().unwrap_or_default()) {
                Some((deployments, sets, pods)) => published
                    .with_makers(svc, &published::makers(deployments, sets))
                    .with_near_miss(svc, pods),
                None => published,
            },
        )
        .collect()
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
        let published = with_unready_cause(&ctx.client, &services, published).await;
        return Ok((services, published));
    };

    let published = published_from_slices(&services, &slices.items);
    let published = with_unready_cause(&ctx.client, &services, published).await;
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

    /// Sam's `web`: its slice carries no port because `targetPort` names a
    /// port no container declares. The compact answer keeps the stop that
    /// names it, so Needs attention can give the cause the Service page
    /// gives. Fails if the stop or its port names are dropped on the way.
    #[test]
    fn the_compact_answer_keeps_the_port_no_container_declares() {
        let (services, mut slices) = synthetic(1, |_| false);
        slices[0].ports = None;
        let published = published_from_slices(&services, &slices);
        let inputs = health_inputs_of(&services, published);

        let stop = serde_json::to_value(&inputs[0].groups[0].stop).expect("json");
        assert_eq!(stop["reason"], "publishesNothing");
        assert_eq!(stop["unnamedPorts"], serde_json::json!(["http"]));
    }

    /// The Ingress the attention count reads is its row cut down, not a
    /// second reading. Fails if a field the verdict reads changes on the way,
    /// or if the labels and annotations come back.
    #[test]
    fn an_ingress_health_input_is_its_row_without_the_metadata() {
        let ingress: Ingress = serde_json::from_value(serde_json::json!({
            "metadata": {
                "name": "storefront",
                "namespace": "net",
                "labels": { "app.kubernetes.io/name": "storefront" },
                "annotations": {
                    "kubectl.kubernetes.io/last-applied-configuration": "{\"apiVersion\":\"networking.k8s.io/v1\",\"kind\":\"Ingress\",\"metadata\":{\"name\":\"storefront\",\"namespace\":\"net\"},\"spec\":{\"ingressClassName\":\"nginx\",\"rules\":[{\"host\":\"shop.example.test\",\"http\":{\"paths\":[{\"backend\":{\"service\":{\"name\":\"web\",\"port\":{\"number\":80}}},\"path\":\"/\",\"pathType\":\"Prefix\"}]}}]}}",
                    "nginx.ingress.kubernetes.io/proxy-body-size": "16m"
                }
            },
            "spec": {
                "ingressClassName": "nginx",
                "tls": [{ "hosts": ["shop.example.test"], "secretName": "shop-tls" }],
                "rules": [{
                    "host": "shop.example.test",
                    "http": { "paths": [{
                        "path": "/",
                        "pathType": "Prefix",
                        "backend": { "service": { "name": "web", "port": { "number": 80 } } }
                    }] }
                }]
            }
        }))
        .expect("an Ingress");
        let whole = serde_json::to_value(IngressInfo::from(&ingress)).expect("json");
        let input = serde_json::to_value(IngressHealthInput::from(&ingress)).expect("json");

        let fields = input.as_object().expect("an object");
        assert_eq!(fields.len(), 7);
        for (field, value) in fields {
            assert_eq!(&whole[field], value, "{field}");
        }
        eprintln!(
            "one Ingress: {} B whole, {} B as its verdict reads it",
            wire_len(&whole),
            wire_len(&input)
        );
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

    /// unready-demo as the cluster serves it: one `ClusterIP` Service, a slice
    /// holding two addresses that are not ready, and two Running pods failing
    /// their readiness probe.
    fn unready_demo(pods: (u16, String)) -> impl Fn(&str, usize) -> (u16, String) {
        let service = serde_json::json!({
            "apiVersion": "v1", "kind": "ServiceList", "metadata": {},
            "items": [{
                "metadata": { "name": "unready-demo", "namespace": "k8s-gui-test" },
                "spec": {
                    "type": "ClusterIP",
                    "clusterIP": "10.104.33.201",
                    "selector": { "app": "unready-demo" },
                    "ports": [{ "name": "http", "port": 80, "targetPort": 8080, "protocol": "TCP" }]
                }
            }]
        });
        let endpoint = |ip: &str, node: &str, pod: &str| {
            serde_json::json!({
                "addresses": [ip],
                "conditions": { "ready": false, "serving": false, "terminating": false },
                "nodeName": node,
                "targetRef": { "kind": "Pod", "name": pod, "namespace": "k8s-gui-test" }
            })
        };
        let slices = serde_json::json!({
            "apiVersion": "discovery.k8s.io/v1", "kind": "EndpointSliceList", "metadata": {},
            "items": [{
                "metadata": {
                    "name": "unready-demo-7xk2p",
                    "namespace": "k8s-gui-test",
                    "labels": { "kubernetes.io/service-name": "unready-demo" }
                },
                "addressType": "IPv4",
                "endpoints": [
                    endpoint("192.168.0.100", "controlplane", "unready-demo-6d4f8b7c9-2xkqp"),
                    endpoint("192.168.1.187", "node01", "unready-demo-6d4f8b7c9-9mzrt")
                ],
                "ports": [{ "name": "http", "port": 8080, "protocol": "TCP" }]
            }]
        });
        move |path, _| match path {
            "/api/v1/namespaces/k8s-gui-test/services" => (200, service.to_string()),
            "/apis/discovery.k8s.io/v1/namespaces/k8s-gui-test/endpointslices" => {
                (200, slices.to_string())
            }
            "/api/v1/namespaces/k8s-gui-test/pods" => pods.clone(),
            _ => (404, "{}".to_string()),
        }
    }

    fn failing_readiness() -> String {
        let pod = |name: &str, node: &str| {
            serde_json::json!({
                "metadata": {
                    "name": name,
                    "namespace": "k8s-gui-test",
                    "labels": { "app": "unready-demo" }
                },
                "spec": {
                    "nodeName": node,
                    "containers": [{ "name": "app", "image": "busybox:1.36" }]
                },
                "status": {
                    "phase": "Running",
                    "conditions": [
                        { "type": "Ready", "status": "False" },
                        { "type": "ContainersReady", "status": "False" }
                    ],
                    "containerStatuses": [{
                        "name": "app", "ready": false, "restartCount": 0,
                        "image": "busybox:1.36", "imageID": "",
                        "state": { "running": { "startedAt": "2026-10-06T21:00:00Z" } }
                    }]
                }
            })
        };
        serde_json::json!({
            "apiVersion": "v1", "kind": "PodList", "metadata": {},
            "items": [
                pod("unready-demo-6d4f8b7c9-2xkqp", "controlplane"),
                pod("unready-demo-6d4f8b7c9-9mzrt", "node01")
            ]
        })
        .to_string()
    }

    /// The Services list and the Overview ended unready-demo's reason with
    /// "the Service page will show the cause", while that page and the peek
    /// said its pods fail their readiness probe. Fails if the list reader
    /// stops asking the pods why.
    #[tokio::test]
    async fn a_service_with_only_unready_addresses_says_why_from_its_pods() {
        use crate::client::served::test_server::answering;
        let (client, _) = answering(unready_demo((200, failing_readiness()))).await;
        let inputs = health_inputs_in(client, Some("k8s-gui-test".to_string()))
            .await
            .expect("inputs");
        let stop = inputs[0].groups[0].stop.as_ref().expect("a stop");
        assert!(
            matches!(
                stop,
                ChainStop::NoneReady {
                    why: NotServing::FailingReadiness,
                    pods: 2,
                    ..
                }
            ),
            "{stop:?}"
        );
    }

    /// Pods nobody may list leave the slices' own answer, never a guess.
    #[tokio::test]
    async fn a_refused_pod_list_leaves_the_cause_to_the_service_page() {
        use crate::client::served::test_server::{answering, failure};
        let (client, _) = answering(unready_demo(failure(403, "Forbidden"))).await;
        let inputs = health_inputs_in(client, Some("k8s-gui-test".to_string()))
            .await
            .expect("inputs");
        let stop = inputs[0].groups[0].stop.as_ref().expect("a stop");
        assert!(
            matches!(
                stop,
                ChainStop::NoneReady {
                    why: NotServing::InSlices,
                    ..
                }
            ),
            "{stop:?}"
        );
    }

    /// Marco's ledger in the shell's count: pods refused, and the Deployment
    /// behind the Service waiting on them by its own counts. Fails if the list
    /// reader stops asking the workloads behind a Service with none ready, or
    /// lets one off whose Deployments it could not read.
    #[tokio::test]
    async fn a_service_whose_workload_waits_on_unread_pods_says_so_in_the_shells_count() {
        use crate::client::served::test_server::{answering, failure};
        let deployments = serde_json::json!({
            "apiVersion": "apps/v1", "kind": "DeploymentList", "metadata": {},
            "items": [{
                "metadata": { "name": "unready-demo", "namespace": "k8s-gui-test", "generation": 1 },
                "spec": {
                    "replicas": 2,
                    "selector": { "matchLabels": { "app": "unready-demo" } },
                    "template": {
                        "metadata": { "labels": { "app": "unready-demo" } },
                        "spec": { "containers": [] }
                    }
                },
                "status": {
                    "observedGeneration": 1, "replicas": 2, "updatedReplicas": 2,
                    "availableReplicas": 0,
                    "conditions": [{
                        "type": "Available", "status": "False",
                        "reason": "MinimumReplicasUnavailable"
                    }]
                }
            }]
        })
        .to_string();
        let stop_with = |answer: (u16, String)| {
            let base = unready_demo(failure(403, "Forbidden"));
            async move {
                let (client, _) = answering(move |path, n| match path {
                    "/apis/apps/v1/namespaces/k8s-gui-test/deployments" => answer.clone(),
                    _ => base(path, n),
                })
                .await;
                health_inputs_in(client, Some("k8s-gui-test".to_string()))
                    .await
                    .expect("inputs")[0]
                    .groups[0]
                    .stop
                    .clone()
            }
        };
        let waiting = stop_with((200, deployments)).await;
        assert!(
            matches!(
                waiting,
                Some(ChainStop::NoneReady {
                    why: NotServing::PodsUnread,
                    pods: 2,
                    ..
                })
            ),
            "{waiting:?}"
        );
        let refused = stop_with(failure(403, "Forbidden")).await;
        assert!(
            matches!(
                refused,
                Some(ChainStop::NoneReady {
                    why: NotServing::InSlices,
                    ..
                })
            ),
            "{refused:?}"
        );
    }

    /// hello-web as Lena left it: scaled to zero, so its Service has no slice
    /// endpoint and no pod carries app=hello-web.
    fn hello_web_at_zero(deployments: (u16, String)) -> impl Fn(&str, usize) -> (u16, String) {
        let list = |kind: &str, items: serde_json::Value| {
            serde_json::json!({ "apiVersion": "v1", "kind": kind, "metadata": {}, "items": items })
                .to_string()
        };
        let services = list(
            "ServiceList",
            serde_json::json!([{
                "metadata": { "name": "hello-web", "namespace": "lena-sandbox" },
                "spec": {
                    "type": "ClusterIP",
                    "selector": { "app": "hello-web" },
                    "ports": [{ "name": "http", "port": 80, "targetPort": 8080, "protocol": "TCP" }]
                }
            }]),
        );
        let slices = list("EndpointSliceList", serde_json::json!([]));
        let pods = list("PodList", serde_json::json!([]));
        let sets = list("StatefulSetList", serde_json::json!([]));
        move |path, _| match path {
            "/api/v1/namespaces/lena-sandbox/services" => (200, services.clone()),
            "/apis/discovery.k8s.io/v1/namespaces/lena-sandbox/endpointslices" => {
                (200, slices.clone())
            }
            "/api/v1/namespaces/lena-sandbox/pods" => (200, pods.clone()),
            "/apis/apps/v1/namespaces/lena-sandbox/deployments" => deployments.clone(),
            "/apis/apps/v1/namespaces/lena-sandbox/statefulsets" => (200, sets.clone()),
            _ => (404, "{}".to_string()),
        }
    }

    /// The Overview, the sidebar badge and the status bar counted hello-web
    /// at zero as a Service with no endpoints. Fails if the list reader stops
    /// asking the workloads behind an empty selector, or calls one idle whose
    /// Deployments it could not read.
    #[tokio::test]
    async fn a_service_behind_a_workload_scaled_to_zero_reads_idle_in_the_shells_count() {
        use crate::client::served::test_server::{answering, failure};
        let deployments = serde_json::json!({
            "apiVersion": "apps/v1", "kind": "DeploymentList", "metadata": {},
            "items": [{
                "metadata": { "name": "hello-web", "namespace": "lena-sandbox" },
                "spec": {
                    "replicas": 0,
                    "selector": { "matchLabels": { "app": "hello-web" } },
                    "template": {
                        "metadata": { "labels": { "app": "hello-web" } },
                        "spec": { "containers": [] }
                    }
                }
            }]
        });
        let stop_with = |answer: (u16, String)| async move {
            let (client, _) = answering(hello_web_at_zero(answer)).await;
            health_inputs_in(client, Some("lena-sandbox".to_string()))
                .await
                .expect("inputs")[0]
                .groups[0]
                .stop
                .clone()
        };

        let idle = stop_with((200, deployments.to_string())).await;
        assert!(
            matches!(&idle, Some(ChainStop::ScaledToZero { workloads, .. }) if workloads[0].name == "hello-web"),
            "{idle:?}"
        );
        let refused = stop_with(failure(403, "Forbidden")).await;
        assert!(
            matches!(refused, Some(ChainStop::SelectsNothing { .. })),
            "{refused:?}"
        );
    }

    /// The Overview's row for Marco's checkout-api said only that no pod
    /// carries app=checkout-api,track=stable. Fails if the shell's read stops
    /// naming the pods one label short, which the Service page names.
    #[tokio::test]
    async fn a_selector_one_label_short_names_its_closest_pods_in_the_shells_count() {
        use crate::client::served::test_server::answering;
        let list = |kind: &str, items: serde_json::Value| {
            serde_json::json!({ "apiVersion": "v1", "kind": kind, "metadata": {}, "items": items })
                .to_string()
        };
        let services = list(
            "ServiceList",
            serde_json::json!([{
                "metadata": { "name": "checkout-api", "namespace": "team-checkout" },
                "spec": {
                    "type": "ClusterIP",
                    "selector": { "app": "checkout-api", "track": "stable" },
                    "ports": [{ "port": 80, "targetPort": 8080, "protocol": "TCP" }]
                }
            }]),
        );
        let canary = |name: &str| {
            serde_json::json!({
                "metadata": {
                    "name": name,
                    "namespace": "team-checkout",
                    "labels": { "app": "checkout-api", "track": "canary" }
                }
            })
        };
        let none = list("PodList", serde_json::json!([]));
        let pods = list(
            "PodList",
            serde_json::json!([canary("checkout-api-a"), canary("checkout-api-b")]),
        );
        let empty = |kind: &str| list(kind, serde_json::json!([]));
        let (slices, deployments, sets) = (
            empty("EndpointSliceList"),
            empty("DeploymentList"),
            empty("StatefulSetList"),
        );
        let (client, _) = answering(move |path, nth| match path {
            "/api/v1/namespaces/team-checkout/services" => (200, services.clone()),
            "/apis/discovery.k8s.io/v1/namespaces/team-checkout/endpointslices" => {
                (200, slices.clone())
            }
            "/api/v1/namespaces/team-checkout/pods" if nth == 1 => (200, none.clone()),
            "/api/v1/namespaces/team-checkout/pods" => (200, pods.clone()),
            "/apis/apps/v1/namespaces/team-checkout/deployments" => (200, deployments.clone()),
            "/apis/apps/v1/namespaces/team-checkout/statefulsets" => (200, sets.clone()),
            _ => (404, "{}".to_string()),
        })
        .await;
        let inputs = health_inputs_in(client, Some("team-checkout".to_string()))
            .await
            .expect("inputs");
        let stop = inputs[0].groups[0].stop.clone();
        let Some(ChainStop::SelectsNothing {
            near: Some(near), ..
        }) = stop
        else {
            panic!("the closest pods are named, got {stop:?}");
        };
        assert_eq!((near.pods.len(), near.lacks.as_str()), (2, "track=stable"));
    }
}
