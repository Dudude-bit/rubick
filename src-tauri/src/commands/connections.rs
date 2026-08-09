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
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{PersistentVolumeClaim, Pod, PodSpec, Service};
use k8s_openapi::api::networking::v1::{HTTPIngressPath, Ingress};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::OwnerReference;
use kube::api::ListParams;
use kube::ResourceExt;
use tauri::State;

use crate::commands::helpers::{build_label_selector, ResourceContext};
use crate::error::{Error, Result};
use crate::resources::{
    condition_is_true, selector_matches, usages_in_pod_spec, ChainStop, ConnectionEdge, Existence,
    ObjectFacts, ObjectRef, Relation, ResourceConnections, UnexploredKind, Usage,
    REVISION_ANNOTATION,
};
use crate::state::AppState;

/// The whole neighbourhood of one object.
///
/// `kind` is the Kubernetes kind, in any casing: `Pod`, `Deployment`,
/// `StatefulSet`, `DaemonSet`, `ReplicaSet`, `Job`, `CronJob`, `Service`,
/// `Ingress`, `PersistentVolumeClaim`, `ConfigMap`, `Secret` or `Node`.
#[tauri::command]
pub async fn get_resource_connections(
    kind: String,
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<ResourceConnections> {
    crate::validation::validate_dns_subdomain(&name)?;
    let ctx = ResourceContext::for_command(&state, namespace)?;
    connections_of(&ctx, &kind, &name).await
}

/// The same answer, for callers that already hold a client — the live
/// harness in `tests/live_connections.rs` runs against this.
pub async fn connections_of(
    ctx: &ResourceContext,
    kind: &str,
    name: &str,
) -> Result<ResourceConnections> {
    let ns = ctx
        .namespace
        .clone()
        .unwrap_or_else(|| "default".to_string());
    let canonical = normalized(kind);

    let mut out = Neighbourhood::new();
    match canonical {
        "Pod" => pod_connections(ctx, &ns, name, &mut out).await?,
        "Deployment" | "StatefulSet" | "DaemonSet" | "ReplicaSet" | "Job" | "CronJob" => {
            workload_connections(ctx, &ns, canonical, name, &mut out).await?;
        }
        "Service" => service_connections(ctx, &ns, name, &mut out).await?,
        "Ingress" => ingress_connections(ctx, &ns, name, &mut out).await?,
        "PersistentVolumeClaim" => claim_connections(ctx, &ns, name, &mut out).await?,
        "ConfigMap" | "Secret" => {
            config_connections(ctx, &ns, canonical, name, &mut out).await?;
        }
        "Node" => node_connections(ctx, name, &mut out).await?,
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
    not_looked_at: Vec<UnexploredKind>,
}

impl Neighbourhood {
    fn new() -> Self {
        Self {
            subject: None,
            edges: Vec::new(),
            stops: Vec::new(),
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
        selector: (!selector.is_empty()).then(|| build_label_selector(&selector)),
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

/// Every Service in the namespace whose selector matches `labels`, the pods
/// each of those Services actually reaches, and the Ingresses that route to
/// them.
///
/// Readiness is judged over every pod the Service selects, not only the
/// subject's — a Service is reachable when any pod behind it is ready, and
/// that pod need not belong to the workload being looked at.
fn traffic_into(
    ns: &str,
    target: &ObjectRef,
    labels: &BTreeMap<String, String>,
    snapshot: &Snapshot,
    out: &mut Neighbourhood,
) {
    for svc in &snapshot.services {
        let selector = service_selector(svc);
        if !selector_matches(&selector, labels) {
            continue;
        }
        let svc_ref = service_ref(svc, ns);
        // A Pod target is already one of the pods `note_reach` enumerates.
        // A workload is not: the selector matches its *template*, and that
        // match is the stated fact that this Service fronts this workload.
        if target.kind != "Pod" {
            out.edge(
                svc_ref.clone(),
                target.clone(),
                Relation::Selects {
                    selector: build_label_selector(&selector),
                },
            );
        }
        note_reach(ns, &svc_ref, &selector, snapshot, out);
        routes_into(ns, &svc_ref, snapshot, out);
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

/// Where the path stops behind this Service, if it does.
///
/// A Service with no selector is not a stop: an ExternalName resolves
/// elsewhere and a hand-managed one has endpoints this app never wrote.
fn note_reach(
    ns: &str,
    svc_ref: &ObjectRef,
    selector: &BTreeMap<String, String>,
    snapshot: &Snapshot,
    out: &mut Neighbourhood,
) {
    if selector.is_empty() {
        return;
    }
    let text = build_label_selector(selector);
    let selected: Vec<&Pod> = snapshot
        .pods
        .iter()
        .filter(|pod| selector_matches(selector, pod.labels()))
        .collect();

    if selected.is_empty() {
        out.stops.push(ChainStop::SelectsNothing {
            service: svc_ref.clone(),
            selector: text,
        });
        return;
    }

    for pod in &selected {
        out.edge(
            svc_ref.clone(),
            pod_ref(pod, ns),
            Relation::Selects {
                selector: text.clone(),
            },
        );
    }

    if !selected
        .iter()
        .any(|pod| condition_is_true(pod.status.as_ref(), "Ready"))
    {
        out.stops.push(ChainStop::NoneReady {
            service: svc_ref.clone(),
            selector: text,
            pods: i32::try_from(selected.len()).unwrap_or(i32::MAX),
        });
    }
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
    out
}

fn path_backend(path: &HTTPIngressPath) -> Option<(Backend, Option<String>)> {
    if let Some(svc) = &path.backend.service {
        let port = svc.port.as_ref().and_then(|p| {
            p.name
                .clone()
                .or_else(|| p.number.map(|number| number.to_string()))
        });
        return Some((Backend::Service(svc.name.clone()), port));
    }
    let resource = path.backend.resource.as_ref()?;
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
}

impl Snapshot {
    /// The namespace's pods, Services, Ingresses and claims, in four
    /// concurrent lists.
    ///
    /// The pods are listed unscoped on purpose. A Service's readiness is a
    /// fact about every pod it selects, and a selector-scoped list would only
    /// ever show the subject's own — which is how a Service that looks empty
    /// from one workload turns out to be served by another.
    async fn of(ctx: &ResourceContext) -> Result<Self> {
        let params = ListParams::default();
        let pods_api = ctx.namespaced_api::<Pod>();
        let services_api = ctx.namespaced_api::<Service>();
        let ingresses_api = ctx.namespaced_api::<Ingress>();
        let claims_api = ctx.namespaced_api::<PersistentVolumeClaim>();
        let (pods, services, ingresses, claims) = tokio::join!(
            pods_api.list(&params),
            services_api.list(&params),
            ingresses_api.list(&params),
            claims_api.list(&params),
        );
        Ok(Self {
            pods: pods?.items,
            services: services?.items,
            ingresses: ingresses?.items,
            claims: claims.map(|list| list.items).unwrap_or_default(),
        })
    }
}

// --- per-kind answers --------------------------------------------------

async fn pod_connections(
    ctx: &ResourceContext,
    ns: &str,
    name: &str,
    out: &mut Neighbourhood,
) -> Result<()> {
    let snapshot = Snapshot::of(ctx).await?;
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
        subject,
        pod.owner_references().to_vec(),
        &mut HashSet::new(),
        out,
    )
    .await;

    out.not_looked_at = UnexploredKind::for_workload();
    out.not_looked_at.push(UnexploredKind::endpoint_slice());
    Ok(())
}

/// The pod template of the kinds that carry one, and the selector that
/// claims its pods.
struct Template {
    labels: BTreeMap<String, String>,
    selector: BTreeMap<String, String>,
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
            obj.spec
                .as_ref()
                .and_then(|s| s.selector.match_labels.clone())
                .unwrap_or_default(),
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
            obj.spec
                .as_ref()
                .and_then(|s| s.selector.match_labels.clone())
                .unwrap_or_default(),
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
            obj.spec
                .as_ref()
                .and_then(|s| s.selector.match_labels.clone())
                .unwrap_or_default(),
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
            obj.spec
                .as_ref()
                .and_then(|s| s.selector.match_labels.clone())
                .unwrap_or_default(),
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
            obj.spec
                .as_ref()
                .and_then(|s| s.selector.as_ref())
                .and_then(|s| s.match_labels.clone())
                .unwrap_or_default(),
            obj.spec.as_ref().and_then(|s| s.template.spec.clone()),
            obj.status.as_ref().and_then(|s| s.active).unwrap_or(0),
            obj.status.as_ref().and_then(|s| s.succeeded).unwrap_or(0)
        ),
        "CronJob" => from_workload!(
            CronJob,
            obj,
            BTreeMap::new(),
            BTreeMap::new(),
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
    out: &mut Neighbourhood,
) -> Result<()> {
    let (snapshot, template) =
        tokio::try_join!(Snapshot::of(ctx), fetch_template(ctx, kind, name))?;
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

    let mine: Vec<&Pod> = snapshot
        .pods
        .iter()
        .filter(|pod| selector_matches(&template.selector, pod.labels()))
        .collect();
    let selector_text = build_label_selector(&template.selector);
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
        revisions_of(ctx, ns, &subject, uid.as_deref(), &template.selector, out).await?;
    }

    out.not_looked_at = UnexploredKind::for_workload();
    out.not_looked_at.push(UnexploredKind::endpoint_slice());
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
    selector: &BTreeMap<String, String>,
    out: &mut Neighbourhood,
) -> Result<()> {
    let Some(uid) = uid else { return Ok(()) };
    if selector.is_empty() {
        return Ok(());
    }
    let params = ListParams::default().labels(&build_label_selector(selector));
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
    out: &mut Neighbourhood,
) -> Result<()> {
    let snapshot = Snapshot::of(ctx).await?;
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

    let selector = service_selector(svc);
    note_reach(ns, &subject, &selector, &snapshot, out);
    routes_into(ns, &subject, &snapshot, out);
    workloads_behind(ctx, ns, &selector, &snapshot, out).await;

    out.not_looked_at.push(UnexploredKind::endpoint_slice());
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
    if selector.is_empty() {
        return;
    }
    let mut walked = HashSet::new();
    for pod in snapshot
        .pods
        .iter()
        .filter(|pod| selector_matches(selector, pod.labels()))
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
    let snapshot = Snapshot::of(ctx).await?;
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
                        let selector = service_selector(svc);
                        note_reach(ns, &svc_ref, &selector, &snapshot, out);
                        workloads_behind(ctx, ns, &selector, &snapshot, out).await;
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

    out.not_looked_at.push(UnexploredKind::endpoint_slice());
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

async fn node_connections(
    ctx: &ResourceContext,
    name: &str,
    out: &mut Neighbourhood,
) -> Result<()> {
    let subject = ObjectRef::new("Node", name, None, Existence::NotChecked);
    out.subject = Some(subject.clone());

    let params = ListParams::default().fields(&format!("spec.nodeName={name}"));
    let pods = ctx.namespaced_or_cluster_api::<Pod>().list(&params).await?;
    for pod in &pods.items {
        let ns = pod.namespace().unwrap_or_default();
        out.edge(pod_ref(pod, &ns), subject.clone(), Relation::RunsOn);
    }
    Ok(())
}

/// Everything in the namespace whose pod spec names this object.
///
/// The same six workload kinds `get_resource_references` walks, plus the
/// pods themselves, and — for a Secret — the Ingresses that serve it as a
/// certificate. Six concurrent lists, one per kind, whatever the answer
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
