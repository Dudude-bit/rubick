//! One command for a whole neighbourhood.
//!
//! A detail page that fires a list-Services, a list-Ingresses and a list-PVCs
//! on every open is how a detail page becomes slow on a real cluster, so
//! there is one command here and it answers everything at once.
//!
//! Both directions come out of the same work: "which Services select this
//! pod" and "which pods does this Service select" are the same selector test
//! read from opposite ends, and the namespace's Services are one list either
//! way. In a namespace with 200 Services that is a single Services list and
//! 200 in-memory comparisons, not 200 requests.
//!
//! The sections below live in their own files and read the names this
//! module holds, as the one file they were cut from did.
#![allow(clippy::wildcard_imports)]

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

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
    condition_is_true, facts_of, published, usages_in_pod_spec, AutoscalerMetric, ChainStop,
    ConditionInfo, ConnectionEdge, Existence, KindScope, ObjectFacts, ObjectRef, Relation,
    ResourceConnections, Selector, ServicePublished, UnexploredKind, Usage, REVISION_ANNOTATION,
};
use crate::state::AppState;
use crate::utils::Moment;

mod governance;
mod kinds;
mod owners;
mod snapshot;
mod traffic;
mod uses;

use governance::*;
use kinds::*;
use owners::*;
use snapshot::*;
pub use snapshot::{Snapshots, Source};
use traffic::*;
use uses::*;

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
    let context = state.get_current_context().unwrap_or_default();
    let source = Source::shared(&state.neighbourhoods, &context);
    Box::pin(connections_through(
        source,
        &ctx,
        &kind,
        &name,
        gateway.as_ref(),
    ))
    .await
}

/// The kinds that are not in a namespace.
///
/// Read from `shared/kinds.json`, the file the frontend registry builds every
/// URL from. An unknown kind, a custom resource above all, is treated as
/// namespaced, which is what the overwhelming majority of them are.
/// `owner_ref` asks it about arbitrary owner kinds, not just the handful this
/// file dispatches on.
fn cluster_scoped(kind: &str) -> bool {
    facts_of(kind).is_some_and(|facts| facts.scope == KindScope::Cluster)
}

/// The same answer, for callers that already hold a client — the live
/// harness in `tests/live_connections.rs` runs against this. Every read is
/// fresh.
pub async fn connections_of(
    ctx: &ResourceContext,
    kind: &str,
    name: &str,
    gateway: Option<&crate::resources::GatewayApiDetection>,
) -> Result<ResourceConnections> {
    connections_through(Source::default(), ctx, kind, name, gateway).await
}

async fn connections_through(
    source: Source<'_>,
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
        "Pod" => pod_connections(source, ctx, &ns, name, gateway, &mut out).await?,
        "Deployment" | "StatefulSet" | "DaemonSet" | "ReplicaSet" | "Job" | "CronJob" => {
            Box::pin(workload_connections(
                source, ctx, &ns, canonical, name, gateway, &mut out,
            ))
            .await?;
        }
        "Service" => service_connections(source, ctx, &ns, name, gateway, &mut out).await?,
        "Ingress" => ingress_connections(source, ctx, &ns, name, &mut out).await?,
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
