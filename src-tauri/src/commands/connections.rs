//! One command for a whole neighbourhood.
//!
//! A detail page that fires a list-Services, a list-Ingresses and a list-PVCs
//! on every open is how a detail page becomes slow on a real cluster, so
//! there is one command here and it answers everything at once.
//!
//! Both directions come out of the same work. "Which Services select this
//! pod" and "which pods does this Service select" are the same selector test
//! read from opposite ends, and the namespace's Services are one list either
//! way — not one request per neighbour. That is what keeps the cost flat:
//! in a namespace with 200 Services this is still a single Services list and
//! 200 in-memory comparisons, not 200 requests.

use std::collections::{BTreeMap, HashSet};

use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, ReplicaSet, StatefulSet};
use k8s_openapi::api::autoscaling::v2::{
    HorizontalPodAutoscaler, MetricSpec, MetricStatus, MetricTarget, MetricValueStatus,
};
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{
    Endpoints, Node, PersistentVolume, PersistentVolumeClaim, Pod, PodSpec, Service,
};
use k8s_openapi::api::discovery::v1::EndpointSlice;
use k8s_openapi::api::networking::v1::{HTTPIngressPath, Ingress, IngressBackend};
use k8s_openapi::api::policy::v1::PodDisruptionBudget;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::{LabelSelector, OwnerReference};
use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
use kube::api::{Api, ListParams};
use kube::ResourceExt;
use tauri::State;

use crate::commands::helpers::ResourceContext;
use crate::error::{Error, Result};
use crate::resources::{
    condition_is_true, published, usages_in_pod_spec, AutoscalerMetric, ChainStop, ConditionInfo,
    ConnectionEdge, Existence, ObjectFacts, ObjectRef, Relation, ResourceConnections, Selector,
    ServicePublished, UnexploredKind, Usage, REVISION_ANNOTATION,
};
use crate::state::AppState;

/// The whole neighbourhood of one object.
///
/// `kind` is the Kubernetes kind, in any casing: `Pod`, `Deployment`,
/// `StatefulSet`, `DaemonSet`, `ReplicaSet`, `Job`, `CronJob`, `Service`,
/// `Ingress`, `PersistentVolumeClaim`, `ConfigMap`, `Secret`, `Node` or
/// `PersistentVolume`.
#[tauri::command]
pub async fn get_resource_connections(
    kind: String,
    name: String,
    namespace: Option<String>,
    gateway: Option<crate::resources::GatewayApiDetection>,
    state: State<'_, AppState>,
) -> Result<ResourceConnections> {
    crate::validation::validate_dns_subdomain(&name)?;
    // The subject's own scope decides, never the page the reader came from.
    // `for_command` defaults an absent namespace to `default`, and a
    // cluster-scoped subject read under that default answers with whatever
    // happens to live in `default` and draws it as the whole answer — which
    // is the reason a Node was never given this tab.
    let ctx = if cluster_scoped(normalized(&kind)) {
        ResourceContext::for_list(&state, None)?
    } else {
        ResourceContext::for_command(&state, namespace)?
    };
    connections_of(&ctx, &kind, &name, gateway.as_ref()).await
}

/// The kinds whose neighbourhood spans every namespace there is: the pods a
/// Node carries, and the claim a PersistentVolume is bound to.
fn cluster_scoped(kind: &str) -> bool {
    matches!(kind, "Node" | "PersistentVolume")
}

/// The same answer, for callers that already hold a client — the live
/// harness in `tests/live_connections.rs` runs against this.
pub async fn connections_of(
    ctx: &ResourceContext,
    kind: &str,
    name: &str,
    gateway: Option<&crate::resources::GatewayApiDetection>,
) -> Result<ResourceConnections> {
    let canonical = normalized(kind);
    // Read once, for the namespaced arms only. The two cluster-scoped ones
    // below take no namespace at all, which is what makes them correct.
    let ns = ctx
        .namespace
        .clone()
        .unwrap_or_else(|| "default".to_string());

    let mut out = Neighbourhood::new();
    match canonical {
        "Pod" => pod_connections(ctx, &ns, name, gateway, &mut out).await?,
        "Deployment" | "StatefulSet" | "DaemonSet" | "ReplicaSet" | "Job" | "CronJob" => {
            workload_connections(ctx, &ns, canonical, name, gateway, &mut out).await?;
        }
        "Service" => service_connections(ctx, &ns, name, gateway, &mut out).await?,
        "Ingress" => ingress_connections(ctx, &ns, name, &mut out).await?,
        "PersistentVolumeClaim" => claim_connections(ctx, &ns, name, &mut out).await?,
        "ConfigMap" | "Secret" => {
            config_connections(ctx, &ns, canonical, name, &mut out).await?;
        }
        "Node" => node_connections(ctx, name, &mut out).await?,
        "PersistentVolume" => volume_connections(ctx, name, &mut out).await?,
        _ => {
            return Err(Error::InvalidInput(format!(
                "connections are not read for kind {kind}"
            )))
        }
    }
    out.finish()
}

/// The kind names this command answers for, canonicalised. Casing is what a
/// URL or a list page happens to carry; it does not change which object is
/// meant.
fn normalized(kind: &str) -> &'static str {
    match kind.to_lowercase().as_str() {
        "pod" => "Pod",
        "deployment" => "Deployment",
        "statefulset" => "StatefulSet",
        "daemonset" => "DaemonSet",
        "replicaset" => "ReplicaSet",
        "job" => "Job",
        "cronjob" => "CronJob",
        "service" => "Service",
        "ingress" => "Ingress",
        "persistentvolumeclaim" | "pvc" => "PersistentVolumeClaim",
        "persistentvolume" | "pv" => "PersistentVolume",
        "configmap" => "ConfigMap",
        "secret" => "Secret",
        "node" => "Node",
        _ => "",
    }
}

/// What the answer is built into.
struct Neighbourhood {
    subject: Option<ObjectRef>,
    edges: Vec<ConnectionEdge>,
    stops: Vec<ChainStop>,
    published: Vec<ServicePublished>,
    not_looked_at: Vec<UnexploredKind>,
}

impl Neighbourhood {
    fn new() -> Self {
        Self {
            subject: None,
            edges: Vec::new(),
            stops: Vec::new(),
            published: Vec::new(),
            not_looked_at: Vec::new(),
        }
    }

    fn edge(&mut self, from: ObjectRef, to: ObjectRef, relation: Relation) {
        self.edges.push(ConnectionEdge { from, to, relation });
    }

    fn finish(self) -> Result<ResourceConnections> {
        let subject = self
            .subject
            .ok_or_else(|| Error::Internal("connections built without a subject".to_string()))?;
        Ok(ResourceConnections {
            subject,
            edges: self.edges,
            stops: self.stops,
            published: self.published,
            not_looked_at: self.not_looked_at,
        })
    }
}

// --- the traffic chain -------------------------------------------------

fn service_ref(svc: &Service, ns: &str) -> ObjectRef {
    let spec = svc.spec.as_ref();
    let selector = spec.and_then(|s| s.selector.clone()).unwrap_or_default();
    ObjectRef::new(
        "Service",
        &svc.name_any(),
        Some(ns.to_string()),
        Existence::Present,
    )
    .with_facts(ObjectFacts::Service {
        type_: spec
            .and_then(|s| s.type_.clone())
            .unwrap_or_else(|| "ClusterIP".to_string()),
        cluster_ip: spec.and_then(|s| s.cluster_ip.clone()),
        external_name: spec.and_then(|s| s.external_name.clone()),
        selector: Selector::Equality(&selector).query_text(),
        ports: crate::resources::ServiceInfo::from(svc).ports,
    })
}

fn pod_ref(pod: &Pod, ns: &str) -> ObjectRef {
    let status = pod.status.as_ref();
    ObjectRef::new(
        "Pod",
        &pod.name_any(),
        Some(ns.to_string()),
        Existence::Present,
    )
    .with_facts(ObjectFacts::Pod {
        phase: status
            .and_then(|s| s.phase.clone())
            .unwrap_or_else(|| "Unknown".to_string()),
        display: crate::resources::PodInfo::from(pod).status.display,
        ready: condition_is_true(status, "Ready"),
    })
}

fn service_selector(svc: &Service) -> BTreeMap<String, String> {
    svc.spec
        .as_ref()
        .and_then(|s| s.selector.clone())
        .unwrap_or_default()
}

/// Every Service in the namespace whose selector matches `labels`, what each
/// of those Services publishes, and the Ingresses that route to them.
///
/// Reachability is judged over what the Service publishes, not only over the
/// subject's own pods — a Service takes traffic when any address behind it
/// does, and that address need not belong to the workload being looked at.
fn traffic_into(
    ns: &str,
    target: &ObjectRef,
    labels: &BTreeMap<String, String>,
    snapshot: &Snapshot,
    out: &mut Neighbourhood,
) {
    for svc in &snapshot.services {
        let selector = service_selector(svc);
        let Some(text) = Selector::Equality(&selector).says() else {
            continue;
        };
        if !Selector::Equality(&selector).matches(labels) {
            continue;
        }
        let svc_ref = service_ref(svc, ns);
        out.edge(
            svc_ref.clone(),
            target.clone(),
            Relation::Selects { selector: text },
        );
        note_reach(svc, &svc_ref, snapshot, out, false);
        routes_into(ns, &svc_ref, snapshot, out);
        gateway_traffic_into(
            ns,
            &svc_ref,
            &snapshot.gateway_routes,
            &snapshot.gateways,
            out,
        );
    }
}

/// The Gateway API routes whose `backendRefs` name this Service, with the
/// Gateway above each and every stop its status names.
///
/// Stops come from what the controller wrote — `Accepted: False`,
/// `ResolvedRefs: False`, per parent — plus the one thing no condition will
/// ever say: a parentRef naming a Gateway the API server does not have,
/// for which no controller will ever write status at all. A parentRef of
/// any other kind — `Service` is GAMMA/mesh — is recognized and left
/// alone: not a Gateway, so never "a missing Gateway".
fn gateway_traffic_into(
    ns: &str,
    svc_ref: &ObjectRef,
    routes: &[crate::resources::RouteInfo],
    gateways: &[crate::resources::GatewayInfo],
    out: &mut Neighbourhood,
) {
    use crate::resources::GATEWAY_API_GROUP;

    for route in routes {
        let backends: Vec<_> = route
            .rules
            .iter()
            .flat_map(|rule| &rule.backend_refs)
            .filter(|b| {
                b.kind == "Service"
                    && b.group.is_empty()
                    && b.name == svc_ref.name
                    && b.namespace.as_deref().unwrap_or(&route.namespace) == ns
            })
            .collect();
        if backends.is_empty() {
            continue;
        }

        let route_ref = ObjectRef::new(
            &route.kind,
            &route.name,
            Some(route.namespace.clone()),
            Existence::Present,
        );

        for backend in backends {
            out.edge(
                route_ref.clone(),
                svc_ref.clone(),
                Relation::RuleRoutes {
                    hostnames: route.hostnames.clone(),
                    port: backend.port.map(|p| p.to_string()),
                    weight: backend.weight,
                },
            );
        }

        for parent in &route.parent_refs {
            if parent.kind != "Gateway" || parent.group != GATEWAY_API_GROUP {
                continue;
            }
            let gw_ns = parent
                .namespace
                .clone()
                .unwrap_or_else(|| route.namespace.clone());
            let found = gateways
                .iter()
                .find(|g| g.name == parent.name && g.namespace == gw_ns);

            let gw_ref = match found {
                Some(g) => ObjectRef::new(
                    "Gateway",
                    &g.name,
                    Some(g.namespace.clone()),
                    Existence::Present,
                )
                .with_facts(ObjectFacts::Gateway {
                    class_name: g.class_name.clone(),
                }),
                None => ObjectRef::new(
                    "Gateway",
                    &parent.name,
                    Some(gw_ns.clone()),
                    Existence::Missing,
                ),
            };
            if found.is_none() {
                out.stops.push(ChainStop::GatewayMissing {
                    route: route_ref.clone(),
                    gateway: gw_ref.clone(),
                });
            }
            out.edge(
                route_ref.clone(),
                gw_ref.clone(),
                Relation::AttachesTo {
                    section_name: parent.section_name.clone(),
                },
            );

            let Some(status) = route.parents.iter().find(|p| {
                p.parent.name == parent.name
                    && p.parent
                        .namespace
                        .clone()
                        .unwrap_or_else(|| route.namespace.clone())
                        == gw_ns
            }) else {
                continue;
            };
            for condition in &status.conditions {
                if condition.status != "False" {
                    continue;
                }
                match condition.type_.as_str() {
                    "Accepted" => out.stops.push(ChainStop::RouteNotAccepted {
                        route: route_ref.clone(),
                        gateway: gw_ref.clone(),
                        condition_reason: condition.reason.clone(),
                        message: condition.message.clone(),
                    }),
                    "ResolvedRefs" => out.stops.push(ChainStop::RouteRefsUnresolved {
                        route: route_ref.clone(),
                        condition_reason: condition.reason.clone(),
                        message: condition.message.clone(),
                    }),
                    _ => {}
                }
            }
        }
    }
}

/// The Ingresses whose backend names this Service.
fn routes_into(ns: &str, svc_ref: &ObjectRef, snapshot: &Snapshot, out: &mut Neighbourhood) {
    for ing in &snapshot.ingresses {
        for (backend, relation) in ingress_backends(ing) {
            if backend != Backend::Service(svc_ref.name.clone()) {
                continue;
            }
            out.edge(ingress_ref(ing, ns), svc_ref.clone(), relation);
        }
    }
}

/// What this Service publishes, and where the path stops if it does.
///
/// The last hop used to be one `Selects` edge per selected pod and a count of
/// their `Ready` conditions — 300 pod refs on a 300-pod Service, and a
/// deduction at the end of it. It is the Service's own slices now: three
/// objects, the cluster's own answer, and the two disagree in exactly the
/// cases nobody can see.
///
/// A Service with no selector is not a stop: an ExternalName resolves
/// elsewhere and a hand-managed one has endpoints this app never wrote — but
/// what it publishes is still read and still drawn, because a slice is a
/// slice however it got written.
/// `detail` is whether the reader is on this Service's own page, where the
/// endpoint rows and the pods it does not publish are the point rather than a
/// payload every other page would carry for nothing.
fn note_reach(
    svc: &Service,
    svc_ref: &ObjectRef,
    snapshot: &Snapshot,
    out: &mut Neighbourhood,
    detail: bool,
) {
    if out
        .published
        .iter()
        .any(|entry| entry.service.same_object(svc_ref))
    {
        return;
    }

    let selector = service_selector(svc);
    let query = Selector::Equality(&selector);
    let selected: Vec<&Pod> = snapshot
        .pods
        .iter()
        .filter(|pod| query.matches(pod.labels()))
        .collect();

    let published = snapshot.published_of(svc, svc_ref.clone(), &selected);
    let serving = published.serving();
    let not_ready = published.not_ready;
    out.published.push(if detail {
        published
    } else {
        published.summary()
    });

    let Some(text) = query.says() else {
        return;
    };

    if selected.is_empty() {
        out.stops.push(ChainStop::SelectsNothing {
            service: svc_ref.clone(),
            selector: text,
        });
        return;
    }
    // A draining address counts here. `serving: true, ready: false` is a pod
    // finishing its open connections, and kube-proxy falls back to exactly
    // those when no ready endpoint is left — announcing an outage through a
    // rolling restart is the defect this replaces.
    if serving > 0 {
        return;
    }

    let ready_pods = selected
        .iter()
        .filter(|pod| condition_is_true(pod.status.as_ref(), "Ready"))
        .count();
    let count = |n: usize| i32::try_from(n).unwrap_or(i32::MAX);

    // Pods that are in the answer and not passing their probes are the old
    // stop, and it is still the right repair. Pods that are Ready and in no
    // published address are the new one.
    if not_ready > 0 || ready_pods == 0 {
        out.stops.push(ChainStop::NoneReady {
            service: svc_ref.clone(),
            selector: text,
            pods: count(selected.len()),
        });
        return;
    }

    out.stops.push(ChainStop::PublishesNothing {
        service: svc_ref.clone(),
        selector: text,
        pods: count(selected.len()),
        ready_pods: count(ready_pods),
        unnamed_ports: unresolved_target_ports(svc, &selected),
    });
}

/// The `targetPort` names not one selected container declares.
///
/// The whole of the app's inference about *why* a Service publishes nothing,
/// and it is derived from two things the call already holds: the names the
/// Service asks for, and the names the containers have. A pod missing for any
/// other reason gets no explanation, because none is written down.
fn unresolved_target_ports(svc: &Service, selected: &[&Pod]) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for pod in selected {
        for name in published::unnamed_ports_of(svc, pod) {
            if !names.contains(&name) {
                names.push(name);
            }
        }
    }
    // Only the names that resolve on no pod at all. One pod out of six
    // missing a port name is a different finding from a Service asking for a
    // name that exists nowhere.
    names.retain(|name| {
        selected
            .iter()
            .all(|pod| published::unnamed_ports_of(svc, pod).contains(name))
    });
    names
}

fn ingress_ref(ing: &Ingress, ns: &str) -> ObjectRef {
    ObjectRef::new(
        "Ingress",
        &ing.name_any(),
        Some(ns.to_string()),
        Existence::Present,
    )
    .with_facts(ObjectFacts::Ingress {
        class_name: ing.spec.as_ref().and_then(|s| s.ingress_class_name.clone()),
    })
}

#[derive(PartialEq, Eq)]
enum Backend {
    Service(String),
    /// A backend that names an API object instead of a Service. The app does
    /// not follow it, and says so rather than dropping the path.
    Resource {
        kind: String,
        name: String,
    },
}

/// Every backend an Ingress states, with the route that reaches it.
fn ingress_backends(ing: &Ingress) -> Vec<(Backend, Relation)> {
    let Some(spec) = ing.spec.as_ref() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for rule in spec.rules.iter().flatten() {
        let host = rule.host.clone();
        let tls = tls_covers(ing, host.as_deref());
        for path in rule.http.iter().flat_map(|http| &http.paths) {
            if let Some((backend, port)) = path_backend(path) {
                out.push((
                    backend,
                    Relation::Routes {
                        host: host.clone(),
                        path: path.path.clone().unwrap_or_else(|| "/".to_string()),
                        path_type: path.path_type.clone(),
                        port,
                        tls,
                    },
                ));
            }
        }
    }

    // `spec.defaultBackend` is a route too — for a rules-less Ingress it is
    // the whole object, the ordinary way a cloud load balancer fronts an
    // in-cluster proxy. Without this edge the graph drew such an Ingress as
    // touching nothing: an empty chain and an empty Connections tab.
    if let Some(fallback) = spec.default_backend.as_ref() {
        if let Some((backend, port)) = backend_of(fallback) {
            out.push((
                backend,
                Relation::Routes {
                    host: None,
                    path: "*".to_string(),
                    path_type: "DefaultBackend".to_string(),
                    port,
                    tls: tls_covers(ing, None),
                },
            ));
        }
    }
    out
}

fn path_backend(path: &HTTPIngressPath) -> Option<(Backend, Option<String>)> {
    backend_of(&path.backend)
}

fn backend_of(backend: &IngressBackend) -> Option<(Backend, Option<String>)> {
    if let Some(svc) = &backend.service {
        let port = svc.port.as_ref().and_then(|p| {
            p.name
                .clone()
                .or_else(|| p.number.map(|number| number.to_string()))
        });
        return Some((Backend::Service(svc.name.clone()), port));
    }
    let resource = backend.resource.as_ref()?;
    Some((
        Backend::Resource {
            kind: resource.kind.clone(),
            name: resource.name.clone(),
        },
        None,
    ))
}

/// Whether `spec.tls` covers a host. A TLS block with no hosts is the
/// catch-all the API defines, and a leading `*.` matches one label.
fn tls_covers(ing: &Ingress, host: Option<&str>) -> bool {
    let Some(spec) = ing.spec.as_ref() else {
        return false;
    };
    spec.tls.iter().flatten().any(|tls| {
        let hosts = tls.hosts.clone().unwrap_or_default();
        if hosts.is_empty() {
            return true;
        }
        let Some(host) = host else { return false };
        hosts.iter().any(|candidate| {
            candidate == host
                || candidate
                    .strip_prefix("*.")
                    .and_then(|suffix| host.split_once('.').map(|(_, rest)| rest == suffix))
                    .unwrap_or(false)
        })
    })
}

// --- what it needs to run ----------------------------------------------

/// The ConfigMaps, Secrets, claims and identity a pod spec names, with how
/// each one is used.
fn uses_from_spec(
    ns: &str,
    subject: &ObjectRef,
    spec: &PodSpec,
    claims: &[PersistentVolumeClaim],
    out: &mut Neighbourhood,
) {
    let mut targets: Vec<(String, String)> = Vec::new();
    for volume in spec.volumes.iter().flatten() {
        for object in crate::resources::volume_source(volume).1 {
            targets.push((object.kind, object.name));
        }
    }
    for container in spec
        .init_containers
        .iter()
        .flatten()
        .chain(&spec.containers)
    {
        for env in container.env.iter().flatten() {
            let Some(from) = &env.value_from else {
                continue;
            };
            if let Some(r) = &from.config_map_key_ref {
                targets.push(("ConfigMap".to_string(), r.name.clone()));
            }
            if let Some(r) = &from.secret_key_ref {
                targets.push(("Secret".to_string(), r.name.clone()));
            }
        }
        for env_from in container.env_from.iter().flatten() {
            if let Some(r) = &env_from.config_map_ref {
                targets.push(("ConfigMap".to_string(), r.name.clone()));
            }
            if let Some(r) = &env_from.secret_ref {
                targets.push(("Secret".to_string(), r.name.clone()));
            }
        }
    }
    for pull in spec.image_pull_secrets.iter().flatten() {
        targets.push(("Secret".to_string(), pull.name.clone()));
    }
    if let Some(account) = &spec.service_account_name {
        targets.push(("ServiceAccount".to_string(), account.clone()));
    }

    let mut seen = HashSet::new();
    for (kind, name) in targets {
        if !seen.insert((kind.clone(), name.clone())) {
            continue;
        }
        let usages = usages_in_pod_spec(spec, &kind, &name);
        if usages.is_empty() {
            continue;
        }
        out.edge(
            subject.clone(),
            named_object(ns, &kind, &name, claims),
            Relation::Uses { usages },
        );
    }
}

/// A name a pod spec states, resolved as far as this call actually looked.
///
/// Claims were listed, so they carry their phase and size and can be called
/// present or missing. ConfigMaps, Secrets and ServiceAccounts were not, and
/// saying `notChecked` is the difference between "the app did not ask" and
/// "the cluster does not have it".
fn named_object(ns: &str, kind: &str, name: &str, claims: &[PersistentVolumeClaim]) -> ObjectRef {
    if kind != "PersistentVolumeClaim" {
        return ObjectRef::unchecked(kind, name, Some(ns.to_string()));
    }
    match claims.iter().find(|claim| claim.name_any() == name) {
        Some(claim) => claim_ref(claim, ns),
        None => ObjectRef::new(kind, name, Some(ns.to_string()), Existence::Missing),
    }
}

fn claim_ref(claim: &PersistentVolumeClaim, ns: &str) -> ObjectRef {
    let info = crate::resources::PersistentVolumeClaimInfo::from(claim);
    ObjectRef::new(
        "PersistentVolumeClaim",
        &claim.name_any(),
        Some(ns.to_string()),
        Existence::Present,
    )
    .with_facts(ObjectFacts::Claim {
        phase: info.status,
        capacity: info.capacity,
        storage_class: info.storage_class,
    })
}

// --- what acts on it without being asked --------------------------------

/// The autoscaler as the workload it scales needs to read it.
fn autoscaler_ref(hpa: &HorizontalPodAutoscaler, ns: &str) -> ObjectRef {
    let spec = hpa.spec.as_ref();
    let status = hpa.status.as_ref();
    let readings: Vec<&MetricStatus> = status
        .and_then(|s| s.current_metrics.as_ref())
        .map(|m| m.iter().collect())
        .unwrap_or_default();

    ObjectRef::new(
        "HorizontalPodAutoscaler",
        &hpa.name_any(),
        Some(ns.to_string()),
        Existence::Present,
    )
    .with_facts(ObjectFacts::Autoscaler {
        // The API server defaults an absent `minReplicas` to 1, and the
        // reader is looking at a range: leaving it null would draw "— to 5".
        min_replicas: spec.and_then(|s| s.min_replicas).unwrap_or(1),
        max_replicas: spec.map_or(0, |s| s.max_replicas),
        current_replicas: status.and_then(|s| s.current_replicas).unwrap_or(0),
        desired_replicas: status.map_or(0, |s| s.desired_replicas),
        metrics: spec
            .and_then(|s| s.metrics.as_ref())
            .map(|metrics| {
                metrics
                    .iter()
                    .map(|metric| autoscaler_metric(metric, &readings))
                    .collect()
            })
            .unwrap_or_default(),
        conditions: status
            .and_then(|s| s.conditions.as_ref())
            .map(|conditions| {
                conditions
                    .iter()
                    .map(|c| ConditionInfo {
                        type_: c.type_.clone(),
                        status: c.status.clone(),
                        reason: c.reason.clone(),
                        message: c.message.clone(),
                        last_transition_time: c.last_transition_time.as_ref().map(|t| t.0),
                        observed_generation: None,
                    })
                    .collect()
            })
            .unwrap_or_default(),
        last_scale_time: status.and_then(|s| s.last_scale_time.as_ref()).map(|t| t.0),
    })
}

/// The name a metric spec is known by, which is also how its reading is found.
fn metric_name(metric: &MetricSpec) -> (String, String) {
    if let Some(resource) = &metric.resource {
        return (resource.name.clone(), "resource".to_string());
    }
    if let Some(container) = &metric.container_resource {
        return (
            format!("{} in {}", container.name, container.container),
            "containerResource".to_string(),
        );
    }
    if let Some(pods) = &metric.pods {
        return (pods.metric.name.clone(), "pods".to_string());
    }
    if let Some(object) = &metric.object {
        return (object.metric.name.clone(), "object".to_string());
    }
    if let Some(external) = &metric.external {
        return (external.metric.name.clone(), "external".to_string());
    }
    (metric.type_.clone(), metric.type_.to_lowercase())
}

/// The reading published for one spec'd metric, matched by name and shape.
///
/// `None` rather than zero where nothing matched: an HPA that cannot reach
/// its metrics publishes no `currentMetrics` at all, and a zero there would
/// be a reading it never took.
fn reading_for(metric: &MetricSpec, readings: &[&MetricStatus]) -> Option<MetricValueStatus> {
    readings.iter().find_map(|status| {
        match (&metric.resource, &status.resource) {
            (Some(spec), Some(got)) if spec.name == got.name => {
                return Some(got.current.clone());
            }
            _ => {}
        }
        match (&metric.container_resource, &status.container_resource) {
            (Some(spec), Some(got)) if spec.name == got.name && spec.container == got.container => {
                return Some(got.current.clone());
            }
            _ => {}
        }
        match (&metric.pods, &status.pods) {
            (Some(spec), Some(got)) if spec.metric.name == got.metric.name => {
                return Some(got.current.clone());
            }
            _ => {}
        }
        match (&metric.object, &status.object) {
            (Some(spec), Some(got)) if spec.metric.name == got.metric.name => {
                return Some(got.current.clone());
            }
            _ => {}
        }
        match (&metric.external, &status.external) {
            (Some(spec), Some(got)) if spec.metric.name == got.metric.name => {
                Some(got.current.clone())
            }
            _ => None,
        }
    })
}

fn autoscaler_metric(metric: &MetricSpec, readings: &[&MetricStatus]) -> AutoscalerMetric {
    let (name, source) = metric_name(metric);
    let target = metric
        .resource
        .as_ref()
        .map(|m| &m.target)
        .or_else(|| metric.container_resource.as_ref().map(|m| &m.target))
        .or_else(|| metric.pods.as_ref().map(|m| &m.target))
        .or_else(|| metric.object.as_ref().map(|m| &m.target))
        .or_else(|| metric.external.as_ref().map(|m| &m.target));

    AutoscalerMetric {
        name,
        source,
        target: target.map(target_text).unwrap_or_default(),
        current: reading_for(metric, readings).as_ref().map(reading_text),
    }
}

/// A target in the unit the reader compares against — a percentage for a
/// utilisation target, the bare quantity for the other two.
fn target_text(target: &MetricTarget) -> String {
    if let Some(utilisation) = target.average_utilization {
        return format!("{utilisation}%");
    }
    if let Some(average) = &target.average_value {
        return average.0.clone();
    }
    target
        .value
        .as_ref()
        .map(|v| v.0.clone())
        .unwrap_or_default()
}

fn reading_text(reading: &MetricValueStatus) -> String {
    if let Some(utilisation) = reading.average_utilization {
        return format!("{utilisation}%");
    }
    if let Some(average) = &reading.average_value {
        return average.0.clone();
    }
    reading
        .value
        .as_ref()
        .map(|v| v.0.clone())
        .unwrap_or_default()
}

fn budget_ref(pdb: &PodDisruptionBudget, ns: &str) -> ObjectRef {
    let spec = pdb.spec.as_ref();
    let status = pdb.status.as_ref();
    let text = |value: &IntOrString| match value {
        IntOrString::Int(n) => n.to_string(),
        IntOrString::String(s) => s.clone(),
    };

    ObjectRef::new(
        "PodDisruptionBudget",
        &pdb.name_any(),
        Some(ns.to_string()),
        Existence::Present,
    )
    .with_facts(ObjectFacts::Budget {
        min_available: spec.and_then(|s| s.min_available.as_ref()).map(text),
        max_unavailable: spec.and_then(|s| s.max_unavailable.as_ref()).map(text),
        disruptions_allowed: status.map_or(0, |s| s.disruptions_allowed),
        current_healthy: status.map_or(0, |s| s.current_healthy),
        desired_healthy: status.map_or(0, |s| s.desired_healthy),
        expected_pods: status.map_or(0, |s| s.expected_pods),
        conditions: status
            .and_then(|s| s.conditions.as_ref())
            .map(|conditions| {
                conditions
                    .iter()
                    .map(|c| ConditionInfo {
                        type_: c.type_.clone(),
                        status: c.status.clone(),
                        reason: Some(c.reason.clone()).filter(|r| !r.is_empty()),
                        message: Some(c.message.clone()).filter(|m| !m.is_empty()),
                        last_transition_time: Some(c.last_transition_time.0),
                        observed_generation: None,
                    })
                    .collect()
            })
            .unwrap_or_default(),
    })
}

/// Whether an autoscaler's `scaleTargetRef` names this object.
///
/// Group, kind and name — not the version. The API server resolves the
/// reference through the scale subresource, which is addressed by
/// group-resource, so an `apps/v1` and an `apps/v1beta2` reference to the
/// same Deployment are the same reference. The group is not optional
/// though: a `Deployment` in some other group is a different object, and
/// matching on the bare kind would draw an edge Kubernetes does not make.
fn scale_target_matches(hpa: &HorizontalPodAutoscaler, target: &ObjectRef) -> bool {
    let Some(reference) = hpa.spec.as_ref().map(|s| &s.scale_target_ref) else {
        return false;
    };
    if reference.kind != target.kind || reference.name != target.name {
        return false;
    }
    let Some(group) = target_group(&target.kind) else {
        return true;
    };
    match &reference.api_version {
        // `apiVersion` is optional in the type and required by validation;
        // an object that somehow has none states no group to disagree with.
        None => true,
        Some(version) => version.split_once('/').map_or("", |(g, _)| g) == group,
    }
}

/// The API group of a kind an autoscaler can plausibly point at.
fn target_group(kind: &str) -> Option<&'static str> {
    match kind {
        "Deployment" | "StatefulSet" | "ReplicaSet" | "DaemonSet" => Some("apps"),
        "ReplicationController" => Some(""),
        _ => None,
    }
}

/// The autoscalers that name any of `scalable`, and the budgets that match
/// `labels`.
///
/// Both lists were taken once with the rest of the namespace, so this is a
/// pass over memory whatever the answer is — the same contract the Services
/// and the Ingresses are read under.
fn governed_by(
    ns: &str,
    scalable: &[ObjectRef],
    target: &ObjectRef,
    labels: &BTreeMap<String, String>,
    snapshot: &Snapshot,
    out: &mut Neighbourhood,
) {
    for hpa in snapshot.autoscalers.as_deref().unwrap_or_default() {
        for object in scalable {
            if scale_target_matches(hpa, object) {
                out.edge(
                    autoscaler_ref(hpa, ns),
                    object.clone(),
                    Relation::Governs { selector: None },
                );
            }
        }
    }
    budgets_over(ns, target, labels, &snapshot.budgets, out);
}

/// The PodDisruptionBudgets whose selector matches these pod labels.
fn budgets_over(
    ns: &str,
    target: &ObjectRef,
    labels: &BTreeMap<String, String>,
    budgets: &Read<PodDisruptionBudget>,
    out: &mut Neighbourhood,
) {
    for pdb in budgets.as_deref().unwrap_or_default() {
        // A budget only ever covers pods in its own namespace. The check is
        // free where the list was namespace-scoped and load-bearing where it
        // was not — a node's is taken across the whole cluster.
        if pdb.namespace().as_deref() != Some(ns) {
            continue;
        }
        // `policy/v1`, and it is the reverse of a Service's rule: a null
        // selector matches no pods, an empty `{}` one covers every pod in
        // the namespace.
        let selector = Selector::Query(pdb.spec.as_ref().and_then(|s| s.selector.as_ref()));
        if !selector.matches(labels) {
            continue;
        }
        out.edge(
            budget_ref(pdb, ns),
            target.clone(),
            Relation::Governs {
                selector: selector.says(),
            },
        );
    }
}

/// What the reads that failed leave the answer unable to say.
fn unanswered(snapshot: &Snapshot) -> Vec<UnexploredKind> {
    UnexploredKind::governance(
        snapshot.autoscalers.as_ref().err().map(|why| why.as_str()),
        snapshot.budgets.as_ref().err().map(|why| why.as_str()),
    )
}

// --- ownership ---------------------------------------------------------

fn owner_ref(owner: &OwnerReference, ns: &str) -> ObjectRef {
    ObjectRef::unchecked(&owner.kind, &owner.name, Some(ns.to_string()))
}

/// Walk `metadata.ownerReferences` to the top.
///
/// Only the controller is followed; a non-controller owner is stated once
/// and left alone, because it is not what made the object. The two kinds
/// that are themselves owned are the only ones fetched, which bounds this at
/// two GETs whatever the chain looks like.
///
/// `seen` is shared across the pods of one Service so that each pod states
/// the ReplicaSet that made it while the hop above it is walked once.
async fn owner_chain(
    ctx: &ResourceContext,
    ns: &str,
    child: ObjectRef,
    owners: Vec<OwnerReference>,
    seen: &mut HashSet<String>,
    out: &mut Neighbourhood,
) {
    let mut child = child;
    let mut owners = owners;

    loop {
        let mut controller = None;
        for owner in &owners {
            let is_controller = owner.controller.unwrap_or(false);
            if is_controller {
                controller = Some(owner.clone());
            }
            out.edge(
                owner_ref(owner, ns),
                child.clone(),
                Relation::Owns {
                    controller: is_controller,
                },
            );
        }

        let Some(controller) = controller else { break };
        if !seen.insert(controller.uid.clone()) {
            break;
        }
        let Some(next) = fetch_owners(ctx, &controller.kind, &controller.name).await else {
            break;
        };
        child = ObjectRef::new(
            &controller.kind,
            &controller.name,
            Some(ns.to_string()),
            Existence::Present,
        );
        owners = next;
    }
}

/// The owner references of the only two kinds that have any.
///
/// A Deployment, a StatefulSet, a DaemonSet and a CronJob are tops; fetching
/// them would buy nothing, so the walk ends there rather than spending a
/// request to learn that.
async fn fetch_owners(
    ctx: &ResourceContext,
    kind: &str,
    name: &str,
) -> Option<Vec<OwnerReference>> {
    match kind {
        "ReplicaSet" => ctx
            .namespaced_api::<ReplicaSet>()
            .get(name)
            .await
            .ok()
            .map(|rs| rs.owner_references().to_vec()),
        "Job" => ctx
            .namespaced_api::<Job>()
            .get(name)
            .await
            .ok()
            .map(|job| job.owner_references().to_vec()),
        _ => None,
    }
}

// --- the namespace snapshot --------------------------------------------

/// One list per kind, taken once and read from both ends.
struct Snapshot {
    pods: Vec<Pod>,
    services: Vec<Service>,
    ingresses: Vec<Ingress>,
    claims: Vec<PersistentVolumeClaim>,
    /// `Err` carries why the read failed, and is not the same answer as an
    /// empty list: `autoscaling/v2` is not served by every cluster this app
    /// connects to, and "nothing scales this" is not what a 404 means.
    autoscalers: Read<HorizontalPodAutoscaler>,
    budgets: Read<PodDisruptionBudget>,
    /// What every Service in the namespace publishes, in one list keyed by
    /// the `kubernetes.io/service-name` label — the same shape the Services
    /// and the Ingresses are read under.
    slices: Read<EndpointSlice>,
    /// Only read where the slice list did not answer. A cluster below 1.21
    /// serves no `discovery.k8s.io/v1` at all, and a confident empty there
    /// would be the app inventing an outage out of its own API version.
    legacy: Read<Endpoints>,
    /// The namespace's Gateway API routes, all five kinds in one list —
    /// empty where the caller brought no detection, or the cluster serves
    /// none of them.
    gateway_routes: Vec<crate::resources::RouteInfo>,
    /// Every Gateway in the cluster, unscoped: a route in this namespace
    /// ordinarily attaches to a Gateway in another one, and a
    /// namespace-scoped list would call every such parent missing.
    gateways: Vec<crate::resources::GatewayInfo>,
}

/// A list whose failure is part of the answer rather than the end of it, and
/// so is carried alongside the items instead of aborting the whole call.
type Read<K> = std::result::Result<Vec<K>, String>;

fn read<K: Clone>(list: kube::Result<kube::core::ObjectList<K>>) -> Read<K> {
    list.map(|list| list.items).map_err(|err| err.to_string())
}

impl Snapshot {
    /// The namespace's pods, Services, Ingresses, claims, autoscalers and
    /// disruption budgets, in six concurrent lists.
    ///
    /// The pods are listed unscoped on purpose. A Service's readiness is a
    /// fact about every pod it selects, and a selector-scoped list would only
    /// ever show the subject's own — which is how a Service that looks empty
    /// from one workload turns out to be served by another.
    async fn of(
        ctx: &ResourceContext,
        gateway: Option<&crate::resources::GatewayApiDetection>,
    ) -> Result<Self> {
        let params = ListParams::default();
        let pods_api = ctx.namespaced_api::<Pod>();
        let services_api = ctx.namespaced_api::<Service>();
        let ingresses_api = ctx.namespaced_api::<Ingress>();
        let claims_api = ctx.namespaced_api::<PersistentVolumeClaim>();
        let autoscalers_api = ctx.namespaced_api::<HorizontalPodAutoscaler>();
        let budgets_api = ctx.namespaced_api::<PodDisruptionBudget>();
        let slices_api = ctx.namespaced_api::<EndpointSlice>();
        let (pods, services, ingresses, claims, autoscalers, budgets, slices) = tokio::join!(
            pods_api.list(&params),
            services_api.list(&params),
            ingresses_api.list(&params),
            claims_api.list(&params),
            autoscalers_api.list(&params),
            budgets_api.list(&params),
            slices_api.list(&params),
        );
        let slices = read(slices);
        // The one read that is not in the join, and deliberately: it is the
        // fallback for a cluster that serves no slices, and paying a round
        // trip for it on every call to every other cluster would be the cost
        // this feature is supposed to bring down.
        let legacy = match slices {
            Ok(_) => Err("the slices answered".to_string()),
            Err(_) => read(ctx.namespaced_api::<Endpoints>().list(&params).await),
        };
        let (gateway_routes, gateways) = gateway_lists(ctx, gateway).await;
        Ok(Self {
            pods: pods?.items,
            services: services?.items,
            ingresses: ingresses?.items,
            claims: claims.map(|list| list.items).unwrap_or_default(),
            autoscalers: read(autoscalers),
            budgets: read(budgets),
            slices,
            legacy,
            gateway_routes,
            gateways,
        })
    }

    /// What one Service publishes, from whichever object answered.
    ///
    /// The three sources produce one shape, so nothing downstream branches on
    /// which one spoke — it only says so.
    fn published_of(
        &self,
        svc: &Service,
        svc_ref: ObjectRef,
        selected: &[&Pod],
    ) -> ServicePublished {
        match (&self.slices, &self.legacy) {
            (Ok(slices), _) => published::from_slices(
                svc,
                svc_ref,
                &published::slices_of(slices, &svc.name_any()),
                selected,
            ),
            (Err(_), Ok(legacy)) => published::from_legacy(
                svc,
                svc_ref,
                legacy.iter().find(|ep| ep.name_any() == svc.name_any()),
            ),
            (Err(_), Err(_)) => published::from_pod_readiness(svc, svc_ref, selected),
        }
    }
}

/// The Gateway API halves of a snapshot, where the caller brought the
/// cluster's detection along.
///
/// The detection is the frontend's cached one-scan-per-cluster answer —
/// passed in rather than re-derived here, so a workload page costs no CRD
/// list. A kind whose list fails is read as absent for this call; the page
/// draws the chain it has rather than failing the whole neighbourhood.
async fn gateway_lists(
    ctx: &ResourceContext,
    gateway: Option<&crate::resources::GatewayApiDetection>,
) -> (
    Vec<crate::resources::RouteInfo>,
    Vec<crate::resources::GatewayInfo>,
) {
    use crate::resources::{GatewayInfo, RouteInfo};

    let Some(detection) = gateway.filter(|d| d.installed) else {
        return (Vec::new(), Vec::new());
    };

    let params = ListParams::default();
    let mut routes = Vec::new();
    let mut gateways = Vec::new();
    for served in &detection.kinds {
        let api_resource = served.api_resource();
        match served.kind.as_str() {
            "HTTPRoute" | "GRPCRoute" | "TLSRoute" | "TCPRoute" | "UDPRoute" => {
                let api = ctx.dynamic_api_for_resource(&api_resource, false);
                if let Ok(list) = api.list(&params).await {
                    routes.extend(list.items.into_iter().map(|obj| {
                        RouteInfo::read(&crate::commands::gateway::with_types(obj, &api_resource))
                    }));
                }
            }
            "Gateway" => {
                let api = ctx.dynamic_api_for_resource(&api_resource, true);
                if let Ok(list) = api.list(&params).await {
                    gateways.extend(list.items.into_iter().map(|obj| {
                        GatewayInfo::read(&crate::commands::gateway::with_types(obj, &api_resource))
                    }));
                }
            }
            _ => {}
        }
    }
    (routes, gateways)
}

// --- per-kind answers --------------------------------------------------

async fn pod_connections(
    ctx: &ResourceContext,
    ns: &str,
    name: &str,
    gateway: Option<&crate::resources::GatewayApiDetection>,
    out: &mut Neighbourhood,
) -> Result<()> {
    let snapshot = Snapshot::of(ctx, gateway).await?;
    let pod = snapshot
        .pods
        .iter()
        .find(|pod| pod.name_any() == name)
        .ok_or_else(|| Error::NotFound {
            kind: "Pod".to_string(),
            name: name.to_string(),
            namespace: ns.to_string(),
        })?;

    let subject = pod_ref(pod, ns);
    out.subject = Some(subject.clone());

    if let Some(spec) = pod.spec.as_ref() {
        uses_from_spec(ns, &subject, spec, &snapshot.claims, out);
        if let Some(node) = &spec.node_name {
            out.edge(
                subject.clone(),
                ObjectRef::unchecked("Node", node, None),
                Relation::RunsOn,
            );
        }
    }

    traffic_into(ns, &subject, pod.labels(), &snapshot, out);
    owner_chain(
        ctx,
        ns,
        subject.clone(),
        pod.owner_references().to_vec(),
        &mut HashSet::new(),
        out,
    )
    .await;

    // An autoscaler never names a pod; it names the workload above it, and
    // the chain that was just walked is where that workload's name is. A
    // reader on a pod page asking "why did this come back" is asking about
    // the same HPA, so the edge is drawn to the object it really scales.
    let scalable: Vec<ObjectRef> = out
        .edges
        .iter()
        .filter(|edge| matches!(edge.relation, Relation::Owns { .. }))
        .map(|edge| edge.from.clone())
        .collect();
    governed_by(ns, &scalable, &subject, pod.labels(), &snapshot, out);

    out.not_looked_at = unanswered(&snapshot);
    Ok(())
}

/// The pod template of the kinds that carry one, and the selector that
/// claims its pods.
struct Template {
    labels: BTreeMap<String, String>,
    /// The whole `metav1.LabelSelector`, not its `matchLabels`: a workload
    /// selecting its pods by a set-based requirement claims exactly the pods
    /// the controller claims, and reading half of it drew a workload with no
    /// pods at all.
    selector: Option<LabelSelector>,
    spec: Option<PodSpec>,
    owners: Vec<OwnerReference>,
    replicas: i32,
    ready_replicas: i32,
}

async fn fetch_template(
    ctx: &ResourceContext,
    kind: &str,
    name: &str,
) -> Result<(Template, Option<String>)> {
    macro_rules! from_workload {
        ($ty:ty, $obj:ident, $labels:expr, $selector:expr, $spec:expr, $replicas:expr, $ready:expr) => {{
            let $obj: $ty = ctx.namespaced_api().get(name).await?;
            let uid = $obj.uid();
            (
                Template {
                    labels: $labels,
                    selector: $selector,
                    spec: $spec,
                    owners: $obj.owner_references().to_vec(),
                    replicas: $replicas,
                    ready_replicas: $ready,
                },
                uid,
            )
        }};
    }

    Ok(match kind {
        "Deployment" => from_workload!(
            Deployment,
            obj,
            obj.spec
                .as_ref()
                .and_then(|s| s.template.metadata.as_ref())
                .and_then(|m| m.labels.clone())
                .unwrap_or_default(),
            obj.spec.as_ref().map(|s| s.selector.clone()),
            obj.spec.as_ref().and_then(|s| s.template.spec.clone()),
            obj.status.as_ref().and_then(|s| s.replicas).unwrap_or(0),
            obj.status
                .as_ref()
                .and_then(|s| s.ready_replicas)
                .unwrap_or(0)
        ),
        "StatefulSet" => from_workload!(
            StatefulSet,
            obj,
            obj.spec
                .as_ref()
                .and_then(|s| s.template.metadata.as_ref())
                .and_then(|m| m.labels.clone())
                .unwrap_or_default(),
            obj.spec.as_ref().map(|s| s.selector.clone()),
            obj.spec.as_ref().and_then(|s| s.template.spec.clone()),
            obj.status.as_ref().map_or(0, |s| s.replicas),
            obj.status
                .as_ref()
                .and_then(|s| s.ready_replicas)
                .unwrap_or(0)
        ),
        "DaemonSet" => from_workload!(
            DaemonSet,
            obj,
            obj.spec
                .as_ref()
                .and_then(|s| s.template.metadata.as_ref())
                .and_then(|m| m.labels.clone())
                .unwrap_or_default(),
            obj.spec.as_ref().map(|s| s.selector.clone()),
            obj.spec.as_ref().and_then(|s| s.template.spec.clone()),
            obj.status
                .as_ref()
                .map_or(0, |s| s.desired_number_scheduled),
            obj.status.as_ref().map_or(0, |s| s.number_ready)
        ),
        "ReplicaSet" => from_workload!(
            ReplicaSet,
            obj,
            obj.spec
                .as_ref()
                .and_then(|s| s.template.as_ref())
                .and_then(|t| t.metadata.as_ref())
                .and_then(|m| m.labels.clone())
                .unwrap_or_default(),
            obj.spec.as_ref().map(|s| s.selector.clone()),
            obj.spec
                .as_ref()
                .and_then(|s| s.template.as_ref())
                .and_then(|t| t.spec.clone()),
            obj.status.as_ref().map_or(0, |s| s.replicas),
            obj.status
                .as_ref()
                .and_then(|s| s.ready_replicas)
                .unwrap_or(0)
        ),
        "Job" => from_workload!(
            Job,
            obj,
            obj.spec
                .as_ref()
                .and_then(|s| s.template.metadata.as_ref())
                .and_then(|m| m.labels.clone())
                .unwrap_or_default(),
            obj.spec.as_ref().and_then(|s| s.selector.clone()),
            obj.spec.as_ref().and_then(|s| s.template.spec.clone()),
            obj.status.as_ref().and_then(|s| s.active).unwrap_or(0),
            obj.status.as_ref().and_then(|s| s.succeeded).unwrap_or(0)
        ),
        "CronJob" => from_workload!(
            CronJob,
            obj,
            BTreeMap::new(),
            None,
            obj.spec
                .as_ref()
                .and_then(|s| s.job_template.spec.as_ref())
                .and_then(|s| s.template.spec.clone()),
            0,
            0
        ),
        _ => unreachable!("fetch_template is only called for workload kinds"),
    })
}

async fn workload_connections(
    ctx: &ResourceContext,
    ns: &str,
    kind: &str,
    name: &str,
    gateway: Option<&crate::resources::GatewayApiDetection>,
    out: &mut Neighbourhood,
) -> Result<()> {
    let (snapshot, template) =
        tokio::try_join!(Snapshot::of(ctx, gateway), fetch_template(ctx, kind, name))?;
    let (template, uid) = template;

    let subject = ObjectRef::new(kind, name, Some(ns.to_string()), Existence::Present).with_facts(
        ObjectFacts::Workload {
            replicas: template.replicas,
            ready_replicas: template.ready_replicas,
            revision: None,
            current: None,
        },
    );
    out.subject = Some(subject.clone());

    if let Some(spec) = template.spec.as_ref() {
        uses_from_spec(ns, &subject, spec, &snapshot.claims, out);
    }

    let selector = Selector::Query(template.selector.as_ref());
    let mine: Vec<&Pod> = snapshot
        .pods
        .iter()
        .filter(|pod| selector.matches(pod.labels()))
        .collect();
    let selector_text = selector.says().unwrap_or_default();
    let mut nodes = HashSet::new();
    for pod in &mine {
        let this = pod_ref(pod, ns);
        out.edge(
            subject.clone(),
            this.clone(),
            Relation::Selects {
                selector: selector_text.clone(),
            },
        );
        if let Some(node) = pod.spec.as_ref().and_then(|s| s.node_name.clone()) {
            if nodes.insert(node.clone()) {
                out.edge(
                    this,
                    ObjectRef::unchecked("Node", &node, None),
                    Relation::RunsOn,
                );
            }
        }
    }

    // The template's labels, not the selector: an Ingress reaches the pods
    // this workload creates, and it is their labels a Service tests.
    traffic_into(ns, &subject, &template.labels, &snapshot, out);
    owner_chain(
        ctx,
        ns,
        subject.clone(),
        template.owners.clone(),
        &mut HashSet::new(),
        out,
    )
    .await;

    if kind == "Deployment" {
        revisions_of(
            ctx,
            ns,
            &subject,
            uid.as_deref(),
            template.selector.as_ref(),
            out,
        )
        .await?;
    }

    // The template's labels again, and for the same reason a Service is
    // tested against them: a budget protects the pods, and the workload is
    // covered exactly when the pods it makes are.
    governed_by(
        ns,
        std::slice::from_ref(&subject),
        &subject,
        &template.labels,
        &snapshot,
        out,
    );

    out.not_looked_at = unanswered(&snapshot);
    Ok(())
}

/// The ReplicaSets a Deployment made, newest first.
///
/// Filtered by controller owner rather than by the selector alone: matching
/// the selector is what makes a `ReplicaSet` adoptable, and the ownership is
/// what says it was adopted.
async fn revisions_of(
    ctx: &ResourceContext,
    ns: &str,
    subject: &ObjectRef,
    uid: Option<&str>,
    selector: Option<&LabelSelector>,
    out: &mut Neighbourhood,
) -> Result<()> {
    let Some(uid) = uid else { return Ok(()) };
    let Some(text) = Selector::Query(selector).query_text() else {
        return Ok(());
    };
    let params = ListParams::default().labels(&text);
    let sets = ctx.namespaced_api::<ReplicaSet>().list(&params).await?;

    let owned: Vec<&ReplicaSet> = sets
        .items
        .iter()
        .filter(|rs| {
            rs.owner_references()
                .iter()
                .any(|o| o.uid == uid && o.controller.unwrap_or(false))
        })
        .collect();

    let revision = |rs: &ReplicaSet| rs.annotations().get(REVISION_ANNOTATION).cloned();
    let newest = owned
        .iter()
        .filter_map(|rs| revision(rs))
        .filter_map(|r| r.parse::<u64>().ok())
        .max();

    for rs in owned {
        let this = revision(rs);
        out.edge(
            subject.clone(),
            ObjectRef::new(
                "ReplicaSet",
                &rs.name_any(),
                Some(ns.to_string()),
                Existence::Present,
            )
            .with_facts(ObjectFacts::Workload {
                replicas: rs.status.as_ref().map_or(0, |s| s.replicas),
                ready_replicas: rs
                    .status
                    .as_ref()
                    .and_then(|s| s.ready_replicas)
                    .unwrap_or(0),
                revision: this.clone(),
                current: Some(
                    this.and_then(|r| r.parse::<u64>().ok())
                        .is_some_and(|r| Some(r) == newest),
                ),
            }),
            Relation::Owns { controller: true },
        );
    }
    Ok(())
}

async fn service_connections(
    ctx: &ResourceContext,
    ns: &str,
    name: &str,
    gateway: Option<&crate::resources::GatewayApiDetection>,
    out: &mut Neighbourhood,
) -> Result<()> {
    let snapshot = Snapshot::of(ctx, gateway).await?;
    let svc = snapshot
        .services
        .iter()
        .find(|svc| svc.name_any() == name)
        .ok_or_else(|| Error::NotFound {
            kind: "Service".to_string(),
            name: name.to_string(),
            namespace: ns.to_string(),
        })?;

    let subject = service_ref(svc, ns);
    out.subject = Some(subject.clone());

    note_reach(svc, &subject, &snapshot, out, true);
    routes_into(ns, &subject, &snapshot, out);
    gateway_traffic_into(
        ns,
        &subject,
        &snapshot.gateway_routes,
        &snapshot.gateways,
        out,
    );
    workloads_behind(ctx, ns, &service_selector(svc), &snapshot, out).await;

    Ok(())
}

/// What made the pods a Service reaches.
///
/// The Service states no workload; the pods it selects state their owners,
/// and that is the only stated route from an address to the thing that
/// answers it.
async fn workloads_behind(
    ctx: &ResourceContext,
    ns: &str,
    selector: &BTreeMap<String, String>,
    snapshot: &Snapshot,
    out: &mut Neighbourhood,
) {
    let query = Selector::Equality(selector);
    let mut walked = HashSet::new();
    for pod in snapshot
        .pods
        .iter()
        .filter(|pod| query.matches(pod.labels()))
    {
        let owners = pod.owner_references().to_vec();
        owner_chain(ctx, ns, pod_ref(pod, ns), owners, &mut walked, out).await;
    }
}

async fn ingress_connections(
    ctx: &ResourceContext,
    ns: &str,
    name: &str,
    out: &mut Neighbourhood,
) -> Result<()> {
    let snapshot = Snapshot::of(ctx, None).await?;
    let ing = snapshot
        .ingresses
        .iter()
        .find(|ing| ing.name_any() == name)
        .ok_or_else(|| Error::NotFound {
            kind: "Ingress".to_string(),
            name: name.to_string(),
            namespace: ns.to_string(),
        })?;

    let subject = ingress_ref(ing, ns);
    out.subject = Some(subject.clone());

    for tls in ing.spec.iter().flat_map(|spec| spec.tls.iter().flatten()) {
        let Some(secret) = &tls.secret_name else {
            continue;
        };
        out.edge(
            subject.clone(),
            ObjectRef::unchecked("Secret", secret, Some(ns.to_string())),
            Relation::Uses {
                usages: vec![Usage::IngressTls {
                    hosts: tls.hosts.clone().unwrap_or_default(),
                }],
            },
        );
    }

    let mut reached = HashSet::new();
    for (backend, relation) in ingress_backends(ing) {
        match backend {
            Backend::Service(service) => {
                match snapshot.services.iter().find(|s| s.name_any() == service) {
                    Some(svc) => {
                        let svc_ref = service_ref(svc, ns);
                        out.edge(subject.clone(), svc_ref.clone(), relation);
                        if !reached.insert(service.clone()) {
                            continue;
                        }
                        note_reach(svc, &svc_ref, &snapshot, out, false);
                        workloads_behind(ctx, ns, &service_selector(svc), &snapshot, out).await;
                    }
                    None => {
                        let missing = ObjectRef::new(
                            "Service",
                            &service,
                            Some(ns.to_string()),
                            Existence::Missing,
                        );
                        out.edge(subject.clone(), missing.clone(), relation);
                        if reached.insert(service.clone()) {
                            out.stops.push(ChainStop::BackendMissing {
                                ingress: subject.clone(),
                                service: missing,
                            });
                        }
                    }
                }
            }
            // A resource backend names an object this app does not read.
            // Stating it unchecked keeps the path on the page instead of
            // dropping it and implying the Ingress routes nowhere.
            Backend::Resource { kind, name } => {
                out.edge(
                    subject.clone(),
                    ObjectRef::unchecked(&kind, &name, Some(ns.to_string())),
                    relation,
                );
            }
        }
    }

    Ok(())
}

async fn claim_connections(
    ctx: &ResourceContext,
    ns: &str,
    name: &str,
    out: &mut Neighbourhood,
) -> Result<()> {
    let claim: PersistentVolumeClaim = ctx.namespaced_api().get(name).await?;
    let subject = claim_ref(&claim, ns);
    out.subject = Some(subject.clone());

    let spec = claim.spec.as_ref();
    if let Some(volume) = spec.and_then(|s| s.volume_name.clone()) {
        out.edge(
            subject.clone(),
            ObjectRef::unchecked("PersistentVolume", &volume, None),
            Relation::Binds,
        );
    }
    if let Some(class) = spec.and_then(|s| s.storage_class_name.clone()) {
        out.edge(
            subject.clone(),
            ObjectRef::unchecked("StorageClass", &class, None),
            Relation::Binds,
        );
    }

    users_of(ctx, ns, &subject, out).await?;
    Ok(())
}

/// A ConfigMap or a Secret: the objects that draw on it, and nothing else.
/// Neither kind states an edge of its own — every edge it has was written
/// somewhere that names it.
async fn config_connections(
    ctx: &ResourceContext,
    ns: &str,
    kind: &str,
    name: &str,
    out: &mut Neighbourhood,
) -> Result<()> {
    let subject = ObjectRef::new(kind, name, Some(ns.to_string()), Existence::NotChecked);
    out.subject = Some(subject.clone());
    users_of(ctx, ns, &subject, out).await
}

/// A node: what is running on it, what would refuse to move, and what the
/// scheduler will still hand out.
///
/// Both lists are cluster-wide rather than scoped to the caller's namespace,
/// and that is a correctness point rather than a widening: a Node is
/// cluster-scoped, and the pods a drain has to evict are in every namespace
/// there is. Answering with one namespace's worth would name a subset and
/// draw it as the whole.
///
/// The node itself is read too, so the subject is a fact rather than a name
/// this call took on trust — and so the pod list has a denominator.
async fn node_connections(
    ctx: &ResourceContext,
    name: &str,
    out: &mut Neighbourhood,
) -> Result<()> {
    let params = ListParams::default().fields(&format!("spec.nodeName={name}"));
    let nodes_api: Api<Node> = Api::all(ctx.client.clone());
    let pods_api: Api<Pod> = Api::all(ctx.client.clone());
    let budgets_api: Api<PodDisruptionBudget> = Api::all(ctx.client.clone());
    let every = ListParams::default();
    let (node, pods, budgets) = tokio::join!(
        nodes_api.get(name),
        pods_api.list(&params),
        budgets_api.list(&every)
    );
    let node = node?;
    let pods = pods?.items;
    let budgets = read(budgets);

    let subject = node_ref(&node);
    out.subject = Some(subject.clone());

    for pod in &pods {
        let ns = pod.namespace().unwrap_or_default();
        let this = pod_ref(pod, &ns);
        out.edge(this.clone(), subject.clone(), Relation::RunsOn);
        // Per pod and not per node: a budget only ever covers pods in its
        // own namespace, and which of them sit on this node is the whole
        // question a drain asks.
        budgets_over(&ns, &this, pod.labels(), &budgets, out);
    }

    out.not_looked_at = UnexploredKind::on_a_node(budgets.as_ref().err().map(|why| why.as_str()));
    Ok(())
}

/// The node, in the terms the pods placed on it are read against.
///
/// Allocatable rather than capacity, and the difference is the one the
/// scheduler uses: capacity is what the machine has, allocatable is what is
/// left once the kubelet has reserved its own, and a pod is placed against
/// the second.
fn node_ref(node: &Node) -> ObjectRef {
    let info = crate::resources::NodeInfo::from(node);
    ObjectRef::new("Node", &node.name_any(), None, Existence::Present).with_facts(
        ObjectFacts::Node {
            schedulable: !node
                .spec
                .as_ref()
                .and_then(|s| s.unschedulable)
                .unwrap_or(false),
            pod_capacity: info.allocatable.pods.and_then(|pods| pods.parse().ok()),
            cpu: info.allocatable.cpu,
            memory: info.allocatable.memory,
        },
    )
}

/// A PersistentVolume: the claim it is bound to, and the class that made it.
///
/// The claim is the cluster-scoped case in miniature. `spec.claimRef` names
/// its namespace outright, and that namespace is neither the page the reader
/// came from nor `default` — reading it under either is how a bound volume
/// reports its claim missing.
async fn volume_connections(
    ctx: &ResourceContext,
    name: &str,
    out: &mut Neighbourhood,
) -> Result<()> {
    let volumes: Api<PersistentVolume> = Api::all(ctx.client.clone());
    let volume = volumes.get(name).await?;
    let subject = ObjectRef::new("PersistentVolume", name, None, Existence::Present);
    out.subject = Some(subject.clone());

    let spec = volume.spec.as_ref();
    if let Some(claim) = spec.and_then(|s| s.claim_ref.as_ref()) {
        if let (Some(ns), Some(claim_name)) = (claim.namespace.clone(), claim.name.clone()) {
            let api: Api<PersistentVolumeClaim> = Api::namespaced(ctx.client.clone(), &ns);
            let to = match api.get(&claim_name).await {
                Ok(found) => claim_ref(&found, &ns),
                // A claim the API server does not have is a released volume
                // holding a reference to something deleted. Any other failure
                // is the app not having looked, and says so.
                Err(kube::Error::Api(err)) if err.code == 404 => ObjectRef::new(
                    "PersistentVolumeClaim",
                    &claim_name,
                    Some(ns),
                    Existence::Missing,
                ),
                Err(_) => ObjectRef::unchecked("PersistentVolumeClaim", &claim_name, Some(ns)),
            };
            out.edge(subject.clone(), to, Relation::Binds);
        }
    }
    if let Some(class) = spec.and_then(|s| s.storage_class_name.clone()) {
        out.edge(
            subject.clone(),
            ObjectRef::unchecked("StorageClass", &class, None),
            Relation::Binds,
        );
    }

    out.not_looked_at = UnexploredKind::on_a_volume();
    Ok(())
}

/// Everything in the namespace whose pod spec names this object.
///
/// Deployments, StatefulSets, DaemonSets, Jobs and CronJobs, plus the pods
/// themselves, and — for a Secret — the Ingresses that serve it as a
/// certificate. Seven concurrent lists, one per kind, whatever the answer
/// turns out to be.
async fn users_of(
    ctx: &ResourceContext,
    ns: &str,
    target: &ObjectRef,
    out: &mut Neighbourhood,
) -> Result<()> {
    let params = ListParams::default();
    let pods_api = ctx.namespaced_api::<Pod>();
    let deploys_api = ctx.namespaced_api::<Deployment>();
    let sets_api = ctx.namespaced_api::<StatefulSet>();
    let daemons_api = ctx.namespaced_api::<DaemonSet>();
    let jobs_api = ctx.namespaced_api::<Job>();
    let crons_api = ctx.namespaced_api::<CronJob>();
    let ingresses_api = ctx.namespaced_api::<Ingress>();
    let (pods, deploys, sets, daemons, jobs, crons, ingresses) = tokio::join!(
        pods_api.list(&params),
        deploys_api.list(&params),
        sets_api.list(&params),
        daemons_api.list(&params),
        jobs_api.list(&params),
        crons_api.list(&params),
        ingresses_api.list(&params),
    );

    let mut note = |kind: &str, name: String, spec: Option<&PodSpec>| {
        let Some(spec) = spec else { return };
        let usages = usages_in_pod_spec(spec, &target.kind, &target.name);
        if usages.is_empty() {
            return;
        }
        out.edge(
            ObjectRef::new(kind, &name, Some(ns.to_string()), Existence::Present),
            target.clone(),
            Relation::Uses { usages },
        );
    };

    for pod in pods?.items {
        note("Pod", pod.name_any(), pod.spec.as_ref());
    }
    for obj in deploys?.items {
        note(
            "Deployment",
            obj.name_any(),
            obj.spec.as_ref().and_then(|s| s.template.spec.as_ref()),
        );
    }
    for obj in sets?.items {
        note(
            "StatefulSet",
            obj.name_any(),
            obj.spec.as_ref().and_then(|s| s.template.spec.as_ref()),
        );
    }
    for obj in daemons?.items {
        note(
            "DaemonSet",
            obj.name_any(),
            obj.spec.as_ref().and_then(|s| s.template.spec.as_ref()),
        );
    }
    for obj in jobs?.items {
        note(
            "Job",
            obj.name_any(),
            obj.spec.as_ref().and_then(|s| s.template.spec.as_ref()),
        );
    }
    for obj in crons?.items {
        note(
            "CronJob",
            obj.name_any(),
            obj.spec
                .as_ref()
                .and_then(|s| s.job_template.spec.as_ref())
                .and_then(|s| s.template.spec.as_ref()),
        );
    }

    if target.kind == "Secret" {
        for ing in ingresses?.items {
            for tls in ing.spec.iter().flat_map(|spec| spec.tls.iter().flatten()) {
                if tls.secret_name.as_deref() != Some(target.name.as_str()) {
                    continue;
                }
                out.edge(
                    ingress_ref(&ing, ns),
                    target.clone(),
                    Relation::Uses {
                        usages: vec![Usage::IngressTls {
                            hosts: tls.hosts.clone().unwrap_or_default(),
                        }],
                    },
                );
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod ingress_backend_tests {
    use super::*;
    use k8s_openapi::api::networking::v1::{
        IngressBackend, IngressServiceBackend, IngressSpec, IngressTLS, ServiceBackendPort,
    };

    /// A defaultBackend-only Ingress is how a cloud load balancer fronts an
    /// in-cluster proxy, and the connections graph used to draw it as
    /// touching nothing — an empty chain and an empty tab on the one
    /// Ingress the reported cluster has.
    #[test]
    fn default_backend_is_an_edge() {
        let ingress = Ingress {
            spec: Some(IngressSpec {
                default_backend: Some(IngressBackend {
                    service: Some(IngressServiceBackend {
                        name: "traefik".into(),
                        port: Some(ServiceBackendPort {
                            number: Some(80),
                            ..Default::default()
                        }),
                    }),
                    resource: None,
                }),
                tls: Some(vec![IngressTLS {
                    hosts: None,
                    secret_name: Some("wildcard-tls".into()),
                }]),
                ..Default::default()
            }),
            ..Default::default()
        };

        let backends = ingress_backends(&ingress);
        assert_eq!(backends.len(), 1);
        let (backend, relation) = &backends[0];
        assert!(matches!(backend, Backend::Service(name) if name == "traefik"));
        match relation {
            Relation::Routes {
                host,
                path,
                path_type,
                port,
                tls,
            } => {
                assert_eq!(host.as_deref(), None);
                assert_eq!(path, "*");
                assert_eq!(path_type, "DefaultBackend");
                assert_eq!(port.as_deref(), Some("80"));
                assert!(*tls);
            }
            other => panic!("expected Routes, got {other:?}"),
        }
    }
}

#[cfg(test)]
mod gateway_traffic_tests {
    use super::*;
    use crate::resources::{GatewayInfo, RouteInfo};

    fn route(yaml: &str) -> RouteInfo {
        RouteInfo::read(&serde_yaml::from_str(yaml).expect("route fixture parses"))
    }

    fn gateway(yaml: &str) -> GatewayInfo {
        GatewayInfo::read(&serde_yaml::from_str(yaml).expect("gateway fixture parses"))
    }

    fn service(ns: &str, name: &str) -> ObjectRef {
        ObjectRef::new("Service", name, Some(ns.to_string()), Existence::Present)
    }

    const EDGE_GATEWAY: &str = r#"
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata: { name: edge, namespace: shop }
spec: { gatewayClassName: envoy }
"#;

    const HEALTHY_ROUTE: &str = r#"
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata: { name: promo, namespace: shop }
spec:
  parentRefs:
  - { name: edge, sectionName: https }
  hostnames: [promo.example.com]
  rules:
  - backendRefs:
    - { name: promo, port: 8080 }
status:
  parents:
  - parentRef: { name: edge, sectionName: https }
    controllerName: example.net/gw
    conditions:
    - { type: Accepted, status: "True", reason: Accepted, message: ok }
    - { type: ResolvedRefs, status: "True", reason: ResolvedRefs, message: ok }
"#;

    #[test]
    fn backend_ref_becomes_an_edge_and_the_gateway_sits_above() {
        let mut out = Neighbourhood::new();
        gateway_traffic_into(
            "shop",
            &service("shop", "promo"),
            &[route(HEALTHY_ROUTE)],
            &[gateway(EDGE_GATEWAY)],
            &mut out,
        );

        assert!(out.stops.is_empty());

        let to_service = out
            .edges
            .iter()
            .find(|e| e.to.kind == "Service")
            .expect("route -> service edge");
        assert_eq!(to_service.from.kind, "HTTPRoute");
        assert_eq!(to_service.from.name, "promo");
        match &to_service.relation {
            Relation::RuleRoutes {
                hostnames,
                port,
                weight,
            } => {
                assert_eq!(hostnames, &vec!["promo.example.com".to_string()]);
                assert_eq!(port.as_deref(), Some("8080"));
                assert_eq!(*weight, None);
            }
            other => panic!("expected RuleRoutes, got {other:?}"),
        }

        let to_gateway = out
            .edges
            .iter()
            .find(|e| e.to.kind == "Gateway")
            .expect("route -> gateway edge");
        assert_eq!(to_gateway.to.name, "edge");
        assert!(matches!(to_gateway.to.existence, Existence::Present));
        assert!(matches!(
            &to_gateway.relation,
            Relation::AttachesTo { section_name } if section_name.as_deref() == Some("https")
        ));
        assert!(matches!(
            &to_gateway.to.facts,
            Some(ObjectFacts::Gateway { class_name }) if class_name == "envoy"
        ));
    }

    #[test]
    fn a_route_naming_another_service_draws_nothing() {
        let mut out = Neighbourhood::new();
        gateway_traffic_into(
            "shop",
            &service("shop", "checkout"),
            &[route(HEALTHY_ROUTE)],
            &[gateway(EDGE_GATEWAY)],
            &mut out,
        );
        assert!(out.edges.is_empty());
        assert!(out.stops.is_empty());
    }

    #[test]
    fn cross_namespace_backend_ref_does_not_match_by_name_alone() {
        // The route names `promo` in the `audit` namespace; the subject is
        // `promo` in `shop`. Same name, different Service.
        let cross = r#"
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata: { name: promo, namespace: shop }
spec:
  rules:
  - backendRefs:
    - { name: promo, namespace: audit, port: 8080 }
"#;
        let mut out = Neighbourhood::new();
        gateway_traffic_into(
            "shop",
            &service("shop", "promo"),
            &[route(cross)],
            &[],
            &mut out,
        );
        assert!(out.edges.is_empty());
    }

    #[test]
    fn accepted_false_is_a_stop_in_the_controllers_words() {
        let refused = r#"
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata: { name: promo, namespace: shop }
spec:
  parentRefs:
  - { name: edge }
  hostnames: [promo.example.com]
  rules:
  - backendRefs:
    - { name: promo, port: 8080 }
status:
  parents:
  - parentRef: { name: edge }
    controllerName: example.net/gw
    conditions:
    - { type: Accepted, status: "False", reason: NoMatchingListenerHostname, message: no listener matches }
"#;
        let mut out = Neighbourhood::new();
        gateway_traffic_into(
            "shop",
            &service("shop", "promo"),
            &[route(refused)],
            &[gateway(EDGE_GATEWAY)],
            &mut out,
        );

        let stop = out.stops.first().expect("a stop");
        match stop {
            ChainStop::RouteNotAccepted {
                route,
                gateway,
                condition_reason,
                ..
            } => {
                assert_eq!(route.name, "promo");
                assert_eq!(gateway.name, "edge");
                assert_eq!(
                    condition_reason.as_deref(),
                    Some("NoMatchingListenerHostname")
                );
            }
            other => panic!("expected RouteNotAccepted, got {other:?}"),
        }
    }

    #[test]
    fn resolved_refs_false_is_a_stop() {
        let unresolved = r#"
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata: { name: promo, namespace: shop }
spec:
  parentRefs:
  - { name: edge }
  rules:
  - backendRefs:
    - { name: promo, namespace: shop, port: 8080 }
status:
  parents:
  - parentRef: { name: edge }
    controllerName: example.net/gw
    conditions:
    - { type: Accepted, status: "True", reason: Accepted, message: ok }
    - { type: ResolvedRefs, status: "False", reason: RefNotPermitted, message: no ReferenceGrant allows it }
"#;
        let mut out = Neighbourhood::new();
        gateway_traffic_into(
            "shop",
            &service("shop", "promo"),
            &[route(unresolved)],
            &[gateway(EDGE_GATEWAY)],
            &mut out,
        );

        assert!(out.stops.iter().any(|stop| matches!(
            stop,
            ChainStop::RouteRefsUnresolved { condition_reason, .. }
                if condition_reason.as_deref() == Some("RefNotPermitted")
        )));
    }

    #[test]
    fn a_parent_gateway_the_server_does_not_have_is_named_missing() {
        let orphan = r#"
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata: { name: promo, namespace: shop }
spec:
  parentRefs:
  - { name: ghost }
  rules:
  - backendRefs:
    - { name: promo, port: 8080 }
"#;
        let mut out = Neighbourhood::new();
        gateway_traffic_into(
            "shop",
            &service("shop", "promo"),
            &[route(orphan)],
            &[],
            &mut out,
        );

        let stop = out.stops.first().expect("a stop");
        match stop {
            ChainStop::GatewayMissing { route, gateway } => {
                assert_eq!(route.name, "promo");
                assert_eq!(gateway.name, "ghost");
            }
            other => panic!("expected GatewayMissing, got {other:?}"),
        }
        let to_gateway = out
            .edges
            .iter()
            .find(|e| e.to.kind == "Gateway")
            .expect("the edge is still drawn, to a missing ref");
        assert!(matches!(to_gateway.to.existence, Existence::Missing));
    }

    #[test]
    fn a_mesh_parent_ref_is_not_a_missing_gateway() {
        let mesh = r#"
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata: { name: split, namespace: shop }
spec:
  parentRefs:
  - { group: "", kind: Service, name: promo }
  rules:
  - backendRefs:
    - { name: promo, port: 8080 }
"#;
        let mut out = Neighbourhood::new();
        gateway_traffic_into(
            "shop",
            &service("shop", "promo"),
            &[route(mesh)],
            &[],
            &mut out,
        );
        // The backend edge is real; the Service parentRef must produce
        // neither a Gateway edge nor a "gateway missing" lie.
        assert!(out.edges.iter().all(|e| e.to.kind != "Gateway"));
        assert!(out.stops.is_empty());
    }
}
