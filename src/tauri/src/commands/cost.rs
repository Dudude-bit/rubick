//! What the cluster holds that a price can be put on: node capacity, what
//! each workload's running pods request, and the volumes they claim.
//!
//! No price is here. The arithmetic is `src/ui/lib/cost.ts`; this reads the
//! quantities once, keyed by the workload the app already names a pod's
//! owner by, so the numbers a supplier prices (folded onto the same keys by
//! `integrations::prometheus::by_workload`) and an estimate land on one row.
//!
//! Nothing here starts a watch of its own: pods, jobs and nodes come from the
//! overview's stores while they serve, and are listed otherwise. Volumes are
//! listed on every call.

#![allow(clippy::needless_pass_by_value)]

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::Arc;

use futures::future::join_all;
use k8s_openapi::api::batch::v1::Job;
use k8s_openapi::api::core::v1::{Node, PersistentVolume, PersistentVolumeClaim, Pod};
use k8s_openapi::apimachinery::pkg::api::resource::Quantity;
use kube::api::ListParams;
use kube::{Api, Client};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::helpers::{api_in, reaches, scope_of, UnreadNamespace};
use crate::commands::overview::OverviewSource;
use crate::error::{Error, Result};
use crate::overview::KeptClaims;
use crate::resources::node_budget::holds_reservation;
use crate::resources::reservation::pod_reservation;
use crate::resources::workload_of;
use crate::state::AppState;
use crate::utils::quantities::{parse_cpu_checked, parse_memory_checked};

/// The most workload rows one answer carries; `src/contracts/cost-budget.json`.
pub const MAX_COST_ROWS: usize = 600;

/// Who a pod's cost is billed to.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkloadKey {
    pub namespace: String,
    /// The API group, `""` for the core one: a custom kind may share a
    /// built-in's name, and the two are different objects.
    pub group: String,
    pub kind: String,
    pub name: String,
}

/// A failed cluster-wide read, as a failed command would have crossed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFailure {
    pub code: String,
    pub message: String,
}

impl ReadFailure {
    fn of(error: &Error) -> Self {
        Self {
            code: error.code().to_string(),
            message: error.said(),
        }
    }
}

/// What one workload's pods on a node request: millicores, bytes, devices,
/// and the bytes of the claims they mount (a claim mounted by several
/// workloads is split between them).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkloadBasis {
    pub key: WorkloadKey,
    pub pods: u32,
    pub cpu: f64,
    pub memory: f64,
    pub gpus: f64,
    pub claim_bytes: f64,
}

/// The workloads past [`MAX_COST_ROWS`], added up.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestBasis {
    pub workloads: u32,
    pub pods: u32,
    pub cpu: f64,
    pub memory: f64,
    pub gpus: f64,
    pub claim_bytes: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamespaceBasis {
    pub namespace: String,
    pub workloads: u32,
    pub pods: u32,
    pub cpu: f64,
    pub memory: f64,
    pub gpus: f64,
    /// Its bound claims, mounted or not; `None` where they could not be read.
    pub storage_bytes: Option<f64>,
}

/// One node's size and what is held on it. A capacity the node did not
/// state, or that would not parse, is `None`: unpriced, never zero.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeBasis {
    pub name: String,
    pub instance_type: Option<String>,
    pub cpu_capacity: Option<f64>,
    pub cpu_allocatable: Option<f64>,
    pub memory_capacity: Option<f64>,
    pub memory_allocatable: Option<f64>,
    pub gpus: f64,
    /// What its pods hold; `None` where they were not counted: a page about
    /// one object, with the stores not serving, does not list the cluster's
    /// pods for a node table it does not draw.
    pub cpu_requested: Option<f64>,
    pub memory_requested: Option<f64>,
    pub gpus_requested: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnclaimedVolume {
    pub name: String,
    pub bytes: f64,
    /// `Available`, `Released` or `Failed`, as the cluster writes it.
    pub phase: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CostBasis {
    /// The cluster's nodes whichever scope is asked; `None` where the node
    /// list, or the pods held on them, could not be read.
    pub nodes: Option<Vec<NodeBasis>>,
    pub nodes_unread: Option<ReadFailure>,
    /// Why what each listed node holds was not counted, where the pods on
    /// them were asked for and the list was refused or failed.
    pub held_unread: Option<ReadFailure>,
    /// Every namespace of the scope that was read; an explicit scope lists
    /// each one read, at zero where nothing runs.
    pub namespaces: Vec<NamespaceBasis>,
    /// The workloads that request most, at most [`MAX_COST_ROWS`].
    pub workloads: Vec<WorkloadBasis>,
    /// Chosen by what they request, against the scope's totals.
    pub rest: Option<RestBasis>,
    /// Pods of the scope that wait for a node and are paid for by nobody.
    pub waiting: u32,
    /// Namespaces whose pods could not be read.
    pub unread: Vec<UnreadNamespace>,
    /// Every volume in the cluster, claimed or not; `None` where volumes
    /// could not be listed.
    pub volume_bytes: Option<f64>,
    pub volume_count: Option<u32>,
    pub unclaimed: Option<Vec<UnclaimedVolume>>,
    pub volumes_unread: Option<ReadFailure>,
    /// Namespaces whose claims could not be read, where volumes were not.
    pub claims_unread: Vec<UnreadNamespace>,
    pub served_from: OverviewSource,
}

/// `held_on_nodes` false leaves what each node holds uncounted where that
/// would cost a list of every pod in the cluster.
#[tauri::command]
pub async fn cost_basis(
    scope: Option<Vec<String>>,
    held_on_nodes: bool,
    state: State<'_, AppState>,
) -> Result<CostBasis> {
    crate::client::clock::timed(
        &state.perf,
        "costBasis",
        Box::pin(basis(&state, scope, held_on_nodes)),
    )
    .await
}

async fn basis(
    state: &AppState,
    scope: Option<Vec<String>>,
    held_on_nodes: bool,
) -> Result<CostBasis> {
    let scope = scope_of(scope)?;
    let client = (*state.here()?.client).clone();
    let (read, volumes) = tokio::join!(
        scoped_pods(state, scope.as_deref()),
        volumes_in(&client, scope.as_deref())
    );
    let read = read?;
    let cluster = match &read.stored {
        Some((nodes, pods)) => Ok((nodes.clone(), Ok(Some(pods.clone())))),
        None => cluster_read(&client, scope.as_deref(), &read, held_on_nodes).await,
    };
    Ok(assemble(&read, cluster, &volumes, scope.as_deref()))
}

/// The pods of a scope and what names their workload.
pub(crate) struct ScopedPods {
    pub pods: Vec<Arc<Pod>>,
    /// `(namespace, Job)` to the `CronJob` that made it.
    pub cron_of: HashMap<(String, String), String>,
    pub unread: Vec<UnreadNamespace>,
    pub served_from: OverviewSource,
    /// Nodes and every pod of the cluster, where the stores served.
    pub(crate) stored: Option<Stored>,
    /// The claims the store's pods mount, by uid: a stored pod has no volumes.
    pub(crate) kept: Option<Arc<KeptClaims>>,
}

/// The overview's nodes and every pod it holds.
type Stored = (Vec<Arc<Node>>, Vec<Arc<Pod>>);
/// The cluster's nodes, and every pod on them: `Ok(None)` where nobody asked,
/// `Err` where the list was asked for and did not come.
type Cluster = (
    Vec<Arc<Node>>,
    std::result::Result<Option<Vec<Arc<Pod>>>, ReadFailure>,
);

fn in_scope<K>(
    items: &[Arc<K>],
    scope: Option<&[String]>,
    of: fn(&K) -> Option<&str>,
) -> Vec<Arc<K>> {
    items
        .iter()
        .filter(|item| {
            scope.is_none_or(|names| of(item).is_some_and(|ns| names.iter().any(|n| n == ns)))
        })
        .cloned()
        .collect()
}

fn cron_of(jobs: &[Arc<Job>]) -> HashMap<(String, String), String> {
    jobs.iter()
        .filter_map(|job| {
            let owner = job
                .metadata
                .owner_references
                .iter()
                .flatten()
                .find(|o| o.controller == Some(true) && o.kind == "CronJob")?;
            Some((
                (job.metadata.namespace.clone()?, job.metadata.name.clone()?),
                owner.name.clone(),
            ))
        })
        .collect()
}

/// From the overview's stores while they serve (holding them, never
/// starting a second set), by listing each reach otherwise.
pub(crate) async fn scoped_pods(state: &AppState, scope: Option<&[String]>) -> Result<ScopedPods> {
    let here = state.here()?;
    let client = (*here.client).clone();
    let context = here.context.clone();
    if let Some(snapshot) = state
        .overview_cache
        .snapshot(&context, || client.clone())
        .await
    {
        let pods = in_scope(&snapshot.pods, scope, |p| p.metadata.namespace.as_deref());
        let jobs = in_scope(&snapshot.jobs, scope, |j| j.metadata.namespace.as_deref());
        return Ok(ScopedPods {
            pods,
            cron_of: cron_of(&jobs),
            unread: Vec::new(),
            served_from: OverviewSource::Watch,
            stored: Some((snapshot.nodes, snapshot.pods)),
            kept: Some(snapshot.claims),
        });
    }
    let params = ListParams::default();
    let reaches = reaches(scope);
    let lists = join_all(reaches.iter().map(|reach| {
        let pods: Api<Pod> = api_in(&client, *reach);
        let jobs: Api<Job> = api_in(&client, *reach);
        let params = params.clone();
        async move {
            let (pods, jobs) = tokio::join!(pods.list(&params), jobs.list(&params));
            (
                pods.map(|l| l.items).map_err(Error::from),
                jobs.map(|l| l.items).ok(),
            )
        }
    }))
    .await;
    let mut pods = Vec::new();
    let mut jobs = Vec::new();
    let mut unread = Vec::new();
    let mut first = None;
    for (reach, (listed, listed_jobs)) in reaches.iter().zip(lists) {
        match listed {
            Ok(items) => pods.extend(items.into_iter().map(Arc::new)),
            Err(error @ Error::CredentialsExpired(_)) => return Err(error),
            Err(error) => {
                if let Some(namespace) = reach {
                    unread.push(UnreadNamespace::of((*namespace).to_string(), &error));
                }
                first.get_or_insert(error);
            }
        }
        // ponytail: a refused Job list leaves its CronJobs' pods under their Job.
        jobs.extend(listed_jobs.into_iter().flatten().map(Arc::new));
    }
    if let Some(error) = first {
        if unread.len() == reaches.len() || scope.is_none() {
            return Err(error);
        }
    }
    Ok(ScopedPods {
        pods,
        cron_of: cron_of(&jobs),
        unread,
        served_from: OverviewSource::List,
        stored: None,
        kept: None,
    })
}

async fn cluster_read(
    client: &Client,
    scope: Option<&[String]>,
    read: &ScopedPods,
    held_on_nodes: bool,
) -> Result<Cluster> {
    let params = ListParams::default();
    let nodes: Api<Node> = Api::all(client.clone());
    let nodes = nodes.list(&params).await?.items;
    // A token that may list the nodes and not every pod still has the
    // nodes: what they hold goes uncounted, the cluster's total does not.
    let pods = match scope {
        None => Ok(Some(read.pods.clone())),
        Some(_) if !held_on_nodes => Ok(None),
        Some(_) => {
            let all: Api<Pod> = Api::all(client.clone());
            all.list(&params)
                .await
                .map(|list| Some(list.items.into_iter().map(Arc::new).collect()))
                .map_err(|error| ReadFailure::of(&Error::from(error)))
        }
    };
    Ok((nodes.into_iter().map(Arc::new).collect(), pods))
}

/// The workload a pod's cost goes to: the one the pod list names, a Job
/// made by a `CronJob` folded into it, and a pod nothing controls as itself.
#[must_use]
pub(crate) fn cost_key(pod: &Pod, cron_of: &HashMap<(String, String), String>) -> WorkloadKey {
    let namespace = pod.metadata.namespace.clone().unwrap_or_default();
    let controller_group = || {
        pod.metadata
            .owner_references
            .iter()
            .flatten()
            .find(|o| o.controller == Some(true))
            .map(|o| {
                o.api_version
                    .rsplit_once('/')
                    .map_or("", |(group, _)| group)
                    .to_string()
            })
            .unwrap_or_default()
    };
    let (group, kind, name) = match workload_of(pod) {
        Some(("Deployment", deployment)) if crate::resources::deployment_of(pod).is_some() => (
            "apps".to_string(),
            "Deployment".to_string(),
            deployment.to_string(),
        ),
        Some(("Job", job)) => match cron_of.get(&(namespace.clone(), job.to_string())) {
            Some(cron) => ("batch".to_string(), "CronJob".to_string(), cron.clone()),
            None => (controller_group(), "Job".to_string(), job.to_string()),
        },
        Some((kind, name)) => (controller_group(), kind.to_string(), name.to_string()),
        None => (
            String::new(),
            "Pod".to_string(),
            pod.metadata.name.clone().unwrap_or_default(),
        ),
    };
    WorkloadKey {
        namespace,
        group,
        kind,
        name,
    }
}

/// On a node and holding its place there: what somebody pays for.
#[must_use]
pub(crate) fn on_a_node(pod: &Pod) -> bool {
    holds_reservation(pod) && pod.spec.as_ref().is_some_and(|s| s.node_name.is_some())
}

fn is_gpu(resource: &str) -> bool {
    resource.ends_with("/gpu")
}

/// Millicores, bytes and devices a pod holds, by the scheduler's own rule.
fn held(pod: &Pod) -> (f64, f64, f64) {
    let Some(spec) = pod.spec.as_ref() else {
        return (0.0, 0.0, 0.0);
    };
    let requests = pod_reservation(spec).requests;
    let gpus = requests
        .iter()
        .filter(|(k, _)| is_gpu(k))
        .map(|(_, v)| v)
        .sum();
    (
        requests.get("cpu").copied().unwrap_or(0.0),
        requests.get("memory").copied().unwrap_or(0.0),
        gpus,
    )
}

/// The claims a pod mounts: from its volumes where it was listed whole, and
/// from beside the overview's store, by its uid, where it was stripped.
fn claims_of<'a>(pod: &'a Pod, kept: Option<&KeptClaims>) -> Vec<String> {
    let mounted = pod
        .spec
        .iter()
        .flat_map(|s| s.volumes.iter().flatten())
        .filter_map(|v| {
            v.persistent_volume_claim
                .as_ref()
                .map(|c| c.claim_name.clone())
        });
    let stored = kept
        .zip(pod.metadata.uid.as_deref())
        .and_then(|(kept, uid): (&KeptClaims, &'a str)| kept.get(uid).map(|names| names.0.to_vec()))
        .into_iter()
        .flatten();
    mounted.chain(stored).collect()
}

/// Volumes as the cluster's PVs state them, or its claims where PVs are refused.
#[derive(Debug, Default)]
struct Volumes {
    claims: HashMap<(String, String), f64>,
    by_namespace: BTreeMap<String, f64>,
    namespaces_unread: Vec<UnreadNamespace>,
    /// False where no claim at all could be read: every namespace's storage is unknown.
    claims_known: bool,
    total: Option<f64>,
    count: Option<u32>,
    unclaimed: Option<Vec<UnclaimedVolume>>,
    unread: Option<ReadFailure>,
}

type Quantities = BTreeMap<String, Quantity>;

fn bytes_of(quantities: Option<&Quantities>, resource: &str) -> Option<f64> {
    quantities
        .and_then(|q| q.get(resource))
        .and_then(|q| parse_memory_checked(&q.0))
        .map(|b| b as f64)
}

fn cpu_of(quantities: Option<&Quantities>) -> Option<f64> {
    quantities
        .and_then(|q| q.get("cpu"))
        .and_then(|q| parse_cpu_checked(&q.0))
}

fn volumes_from_pvs(pvs: &[PersistentVolume]) -> Volumes {
    let mut volumes = Volumes {
        claims_known: true,
        total: Some(0.0),
        count: Some(0),
        unclaimed: Some(Vec::new()),
        ..Volumes::default()
    };
    for pv in pvs {
        // ponytail: a PV whose size will not parse is left out of every sum.
        let Some(bytes) = bytes_of(
            pv.spec.as_ref().and_then(|s| s.capacity.as_ref()),
            "storage",
        ) else {
            continue;
        };
        *volumes.total.as_mut().expect("set above") += bytes;
        *volumes.count.as_mut().expect("set above") += 1;
        let phase = pv.status.as_ref().and_then(|s| s.phase.clone());
        let claim = pv.spec.as_ref().and_then(|s| s.claim_ref.as_ref());
        match (phase.as_deref(), claim) {
            (Some("Bound"), Some(claim)) => {
                let namespace = claim.namespace.clone().unwrap_or_default();
                let name = claim.name.clone().unwrap_or_default();
                *volumes.by_namespace.entry(namespace.clone()).or_default() += bytes;
                volumes.claims.insert((namespace, name), bytes);
            }
            _ => volumes
                .unclaimed
                .as_mut()
                .expect("set above")
                .push(UnclaimedVolume {
                    name: pv.metadata.name.clone().unwrap_or_default(),
                    bytes,
                    phase,
                }),
        }
    }
    volumes
}

fn add_claims(volumes: &mut Volumes, claims: &[PersistentVolumeClaim]) {
    for claim in claims {
        let bound = claim.status.as_ref().and_then(|s| s.phase.as_deref()) == Some("Bound");
        let Some(bytes) = bytes_of(
            claim.status.as_ref().and_then(|s| s.capacity.as_ref()),
            "storage",
        ) else {
            continue;
        };
        if !bound {
            continue;
        }
        let namespace = claim.metadata.namespace.clone().unwrap_or_default();
        *volumes.by_namespace.entry(namespace.clone()).or_default() += bytes;
        volumes.claims.insert(
            (namespace, claim.metadata.name.clone().unwrap_or_default()),
            bytes,
        );
    }
}

async fn volumes_in(client: &Client, scope: Option<&[String]>) -> Volumes {
    let params = ListParams::default();
    let pvs: Api<PersistentVolume> = Api::all(client.clone());
    let refused = match pvs.list(&params).await {
        Ok(list) => return volumes_from_pvs(&list.items),
        Err(error) => Error::from(error),
    };
    let mut volumes = Volumes {
        claims_known: true,
        unread: Some(ReadFailure::of(&refused)),
        ..Volumes::default()
    };
    let reaches = reaches(scope);
    let answers = join_all(reaches.iter().map(|reach| {
        let api: Api<PersistentVolumeClaim> = api_in(client, *reach);
        let params = params.clone();
        async move {
            api.list(&params)
                .await
                .map(|l| l.items)
                .map_err(Error::from)
        }
    }))
    .await;
    for (reach, answer) in reaches.iter().zip(answers) {
        match answer {
            Ok(claims) => add_claims(&mut volumes, &claims),
            Err(error) => match reach {
                Some(namespace) => volumes
                    .namespaces_unread
                    .push(UnreadNamespace::of((*namespace).to_string(), &error)),
                None => volumes.claims_known = false,
            },
        }
    }
    volumes
}

fn node_rows(nodes: &[Arc<Node>], pods: Option<&[Arc<Pod>]>) -> Vec<NodeBasis> {
    let mut held_on: HashMap<&str, (f64, f64, f64)> = HashMap::new();
    for pod in pods.into_iter().flatten().filter(|p| on_a_node(p)) {
        let node = pod
            .spec
            .as_ref()
            .and_then(|s| s.node_name.as_deref())
            .unwrap_or_default();
        let (cpu, memory, gpus) = held(pod);
        let slot = held_on.entry(node).or_default();
        slot.0 += cpu;
        slot.1 += memory;
        slot.2 += gpus;
    }
    nodes
        .iter()
        .map(|node| {
            let name = node.metadata.name.clone().unwrap_or_default();
            let status = node.status.as_ref();
            let capacity = status.and_then(|s| s.capacity.as_ref());
            let allocatable = status.and_then(|s| s.allocatable.as_ref());
            let gpus = capacity
                .into_iter()
                .flatten()
                .filter(|(k, _)| is_gpu(k))
                .filter_map(|(_, v)| parse_memory_checked(&v.0))
                .map(|n| n as f64)
                .sum();
            let labels = node.metadata.labels.as_ref();
            let instance_type = labels.and_then(|l| {
                l.get("node.kubernetes.io/instance-type")
                    .or_else(|| l.get("beta.kubernetes.io/instance-type"))
                    .cloned()
            });
            let held = pods.map(|_| held_on.get(name.as_str()).copied().unwrap_or_default());
            NodeBasis {
                instance_type,
                cpu_capacity: cpu_of(capacity),
                cpu_allocatable: cpu_of(allocatable),
                memory_capacity: bytes_of(capacity, "memory"),
                memory_allocatable: bytes_of(allocatable, "memory"),
                gpus,
                cpu_requested: held.map(|h| h.0),
                memory_requested: held.map(|h| h.1),
                gpus_requested: held.map(|h| h.2),
                name,
            }
        })
        .collect()
}

/// The rows past `max`, chosen by each workload's share of what the scope
/// requests (CPU, memory and devices weighed alike), added up.
fn keep(mut rows: Vec<WorkloadBasis>, max: usize) -> (Vec<WorkloadBasis>, Option<RestBasis>) {
    if rows.len() <= max {
        return (rows, None);
    }
    let total = rows.iter().fold((0.0, 0.0, 0.0), |t, r| {
        (t.0 + r.cpu, t.1 + r.memory, t.2 + r.gpus)
    });
    let share = |part: f64, whole: f64| if whole > 0.0 { part / whole } else { 0.0 };
    let weight = |r: &WorkloadBasis| {
        share(r.cpu, total.0) + share(r.memory, total.1) + share(r.gpus, total.2)
    };
    rows.sort_by(|a, b| {
        weight(b)
            .total_cmp(&weight(a))
            .then_with(|| a.key.cmp(&b.key))
    });
    let cut = rows.split_off(max);
    let rest = cut.iter().fold(RestBasis::default(), |mut rest, row| {
        rest.workloads += 1;
        rest.pods += row.pods;
        rest.cpu += row.cpu;
        rest.memory += row.memory;
        rest.gpus += row.gpus;
        rest.claim_bytes += row.claim_bytes;
        rest
    });
    rows.sort_by(|a, b| a.key.cmp(&b.key));
    (rows, Some(rest))
}

fn assemble(
    read: &ScopedPods,
    cluster: Result<Cluster>,
    volumes: &Volumes,
    scope: Option<&[String]>,
) -> CostBasis {
    let mut rows: BTreeMap<WorkloadKey, WorkloadBasis> = BTreeMap::new();
    let mut waiting = 0;
    let mut claimants: HashMap<(String, String), BTreeSet<WorkloadKey>> = HashMap::new();
    for pod in &read.pods {
        if !on_a_node(pod) {
            if holds_reservation(pod) {
                waiting += 1;
            }
            continue;
        }
        let key = cost_key(pod, &read.cron_of);
        let (cpu, memory, gpus) = held(pod);
        let row = rows.entry(key.clone()).or_insert_with(|| WorkloadBasis {
            key: key.clone(),
            pods: 0,
            cpu: 0.0,
            memory: 0.0,
            gpus: 0.0,
            claim_bytes: 0.0,
        });
        row.pods += 1;
        row.cpu += cpu;
        row.memory += memory;
        row.gpus += gpus;
        for claim in claims_of(pod, read.kept.as_deref()) {
            claimants
                .entry((key.namespace.clone(), claim))
                .or_default()
                .insert(key.clone());
        }
    }
    for (claim, keys) in &claimants {
        let Some(bytes) = volumes.claims.get(claim) else {
            continue;
        };
        for key in keys {
            if let Some(row) = rows.get_mut(key) {
                row.claim_bytes += bytes / keys.len() as f64;
            }
        }
    }

    let unread_claims: HashSet<&str> = volumes
        .namespaces_unread
        .iter()
        .map(|u| u.namespace.as_str())
        .collect();
    let unread_pods: HashSet<&str> = read.unread.iter().map(|u| u.namespace.as_str()).collect();
    let mut namespaces: BTreeMap<String, NamespaceBasis> = BTreeMap::new();
    let namespace = |name: &str| -> NamespaceBasis {
        NamespaceBasis {
            namespace: name.to_string(),
            workloads: 0,
            pods: 0,
            cpu: 0.0,
            memory: 0.0,
            gpus: 0.0,
            storage_bytes: if !volumes.claims_known || unread_claims.contains(name) {
                None
            } else {
                Some(volumes.by_namespace.get(name).copied().unwrap_or(0.0))
            },
        }
    };
    let named: Vec<String> = match scope {
        Some(names) => names
            .iter()
            .filter(|n| !unread_pods.contains(n.as_str()))
            .cloned()
            .collect(),
        None => volumes.by_namespace.keys().cloned().collect(),
    };
    for name in named {
        let entry = namespace(&name);
        namespaces.insert(name, entry);
    }
    for row in rows.values() {
        let entry = namespaces
            .entry(row.key.namespace.clone())
            .or_insert_with(|| namespace(&row.key.namespace));
        entry.workloads += 1;
        entry.pods += row.pods;
        entry.cpu += row.cpu;
        entry.memory += row.memory;
        entry.gpus += row.gpus;
    }

    let (nodes, nodes_unread, held_unread) = match cluster {
        Ok((nodes, Ok(pods))) => (Some(node_rows(&nodes, pods.as_deref())), None, None),
        Ok((nodes, Err(failure))) => (Some(node_rows(&nodes, None)), None, Some(failure)),
        Err(error) => (None, Some(ReadFailure::of(&error)), None),
    };
    let (workloads, rest) = keep(rows.into_values().collect(), MAX_COST_ROWS);
    CostBasis {
        nodes,
        nodes_unread,
        held_unread,
        namespaces: namespaces.into_values().collect(),
        workloads,
        rest,
        waiting,
        unread: read.unread.clone(),
        volume_bytes: volumes.total,
        volume_count: volumes.count,
        unclaimed: volumes.unclaimed.clone(),
        volumes_unread: volumes.unread.clone(),
        claims_unread: volumes.namespaces_unread.clone(),
        served_from: read.served_from,
    }
}

#[cfg(test)]
#[allow(clippy::float_cmp)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;

    pub(crate) struct Spec<'a> {
        pub namespace: &'a str,
        pub name: &'a str,
        pub node: Option<&'a str>,
        pub phase: &'a str,
        pub owner: Option<(&'a str, &'a str)>,
        pub cpu: &'a str,
        pub memory: &'a str,
        pub claims: &'a [&'a str],
    }

    pub(crate) fn running<'a>(
        namespace: &'a str,
        name: &'a str,
        owner: (&'a str, &'a str),
    ) -> Spec<'a> {
        Spec {
            namespace,
            name,
            node: Some("node-a"),
            phase: "Running",
            owner: Some(owner),
            cpu: "100m",
            memory: "128Mi",
            claims: &[],
        }
    }

    pub(crate) fn pod(spec: &Spec) -> Arc<Pod> {
        let owners: Vec<_> = spec
            .owner
            .iter()
            .map(|(kind, name)| json!({"apiVersion": "apps/v1", "kind": kind, "name": name, "uid": name, "controller": true}))
            .collect();
        let volumes: Vec<_> = spec
            .claims
            .iter()
            .map(|claim| json!({"name": claim, "persistentVolumeClaim": {"claimName": claim}}))
            .collect();
        Arc::new(
            serde_json::from_value(json!({
                "metadata": {"namespace": spec.namespace, "name": spec.name, "uid": spec.name, "ownerReferences": owners},
                "spec": {
                    "nodeName": spec.node,
                    "containers": [{"name": "app", "resources": {"requests": {"cpu": spec.cpu, "memory": spec.memory}}}],
                    "volumes": volumes,
                },
                "status": {"phase": spec.phase},
            }))
            .expect("a pod"),
        )
    }

    pub(crate) fn read_of(pods: Vec<Arc<Pod>>) -> ScopedPods {
        ScopedPods {
            pods,
            cron_of: HashMap::new(),
            unread: Vec::new(),
            served_from: OverviewSource::Watch,
            stored: None,
            kept: None,
        }
    }

    fn node(name: &str, cpu: &str, memory: &str) -> Arc<Node> {
        Arc::new(
            serde_json::from_value(json!({
                "metadata": {"name": name, "labels": {"node.kubernetes.io/instance-type": "m5.large"}},
                "status": {
                    "capacity": {"cpu": cpu, "memory": memory, "nvidia.com/gpu": "1"},
                    "allocatable": {"cpu": "1900m", "memory": "3Gi"},
                },
            }))
            .expect("a node"),
        )
    }

    fn refused() -> Error {
        Error::PermissionDenied("nodes is forbidden".into())
    }

    fn row<'a>(basis: &'a CostBasis, kind: &str, name: &str) -> Option<&'a WorkloadBasis> {
        basis
            .workloads
            .iter()
            .find(|r| r.key.kind == kind && r.key.name == name)
    }

    /// A token that lists the nodes and not every pod keeps the nodes: the
    /// cluster's total stands, and only what each node holds is unknown,
    /// with the refusal said. Fails if the refused pod list took the nodes
    /// with it, or what they hold read as nothing.
    #[test]
    fn a_refused_pod_list_keeps_the_nodes_and_leaves_what_they_hold_unknown() {
        let read = read_of(vec![pod(&running("shop", "web-0", ("StatefulSet", "web")))]);
        let refusal = ReadFailure::of(&refused());
        let basis = assemble(
            &read,
            Ok((vec![node("node-a", "2", "4Gi")], Err(refusal.clone()))),
            &Volumes::default(),
            None,
        );
        let nodes = basis.nodes.expect("the nodes were listed");
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].cpu_requested, None);
        assert_eq!(basis.nodes_unread, None);
        assert_eq!(basis.held_unread, Some(refusal));
    }

    /// A token refused the node list must not read as a cluster with no
    /// nodes: the page would price the cluster at zero and call it complete.
    #[test]
    fn a_refused_node_list_leaves_the_nodes_unknown_and_not_empty() {
        let read = read_of(vec![pod(&running("shop", "web-0", ("StatefulSet", "web")))]);
        let basis = assemble(&read, Err(refused()), &Volumes::default(), None);
        assert!(basis.nodes.is_none());
        assert_eq!(
            basis.nodes_unread.expect("the refusal").code,
            "PERMISSION_DENIED"
        );
        assert_eq!(
            basis.workloads.len(),
            1,
            "the workloads the token can read still stand"
        );
    }

    /// Only a pod on a node is paid for. A Pending pod with no node waits,
    /// and a finished one holds nothing; either counted would bill a
    /// workload for a machine it never had.
    #[test]
    fn a_pod_waiting_for_a_node_or_finished_is_billed_to_nobody() {
        let waiting = Spec {
            node: None,
            phase: "Pending",
            ..running("shop", "web-1", ("StatefulSet", "web"))
        };
        let done = Spec {
            phase: "Succeeded",
            ..running("shop", "web-2", ("StatefulSet", "web"))
        };
        let read = read_of(vec![
            pod(&running("shop", "web-0", ("StatefulSet", "web"))),
            pod(&waiting),
            pod(&done),
        ]);
        let basis = assemble(
            &read,
            Ok((vec![], Ok(Some(vec![])))),
            &Volumes::default(),
            None,
        );
        let web = row(&basis, "StatefulSet", "web").expect("its running pod");
        assert_eq!(web.pods, 1);
        assert_eq!(web.cpu, 100.0);
        assert_eq!(basis.waiting, 1);
    }

    /// The scheduler's rule, not the containers added up: a native sidecar
    /// holds its request beside the app for the pod's whole life.
    #[test]
    fn a_sidecar_s_request_is_part_of_what_its_workload_holds() {
        let pod: Pod = serde_json::from_value(json!({
            "metadata": {"namespace": "shop", "name": "web-0", "ownerReferences": [
                {"apiVersion": "apps/v1", "kind": "StatefulSet", "name": "web", "uid": "u", "controller": true}
            ]},
            "spec": {
                "nodeName": "node-a",
                "initContainers": [{"name": "proxy", "restartPolicy": "Always", "resources": {"requests": {"cpu": "50m"}}}],
                "containers": [{"name": "app", "resources": {"requests": {"cpu": "100m"}}}],
            },
            "status": {"phase": "Running"},
        }))
        .unwrap();
        let basis = assemble(
            &read_of(vec![Arc::new(pod)]),
            Ok((vec![], Ok(Some(vec![])))),
            &Volumes::default(),
            None,
        );
        assert_eq!(row(&basis, "StatefulSet", "web").unwrap().cpu, 150.0);
    }

    /// A schedule's runs are one thing to pay for; each `Job` a row would
    /// scatter the `CronJob`'s cost over names that change every run.
    #[test]
    fn a_job_a_cronjob_made_is_billed_to_the_cronjob() {
        let mut read = read_of(vec![pod(&running(
            "ops",
            "backup-29-x2k9z",
            ("Job", "backup-29"),
        ))]);
        read.cron_of
            .insert(("ops".into(), "backup-29".into()), "backup".into());
        let basis = assemble(
            &read,
            Ok((vec![], Ok(Some(vec![])))),
            &Volumes::default(),
            None,
        );
        assert!(row(&basis, "CronJob", "backup").is_some());
        assert!(row(&basis, "Job", "backup-29").is_none());

        let alone = read_of(vec![pod(&running("ops", "once-x2k9z", ("Job", "once")))]);
        let basis = assemble(
            &alone,
            Ok((vec![], Ok(Some(vec![])))),
            &Volumes::default(),
            None,
        );
        assert!(
            row(&basis, "Job", "once").is_some(),
            "a Job nothing scheduled stands as itself"
        );
    }

    /// A custom kind may share a built-in's name: the key carries the
    /// owner's group, so an Argo `Rollout`'s pods are not a `Deployment`'s
    /// and a `CronJob`'s runs are batch's own.
    #[test]
    fn a_workload_is_keyed_by_its_group_as_well_as_its_kind() {
        let rollout: Pod = serde_json::from_value(json!({
            "metadata": {"namespace": "shop", "name": "web-6d4f-x2k9z", "ownerReferences": [
                {"apiVersion": "argoproj.io/v1alpha1", "kind": "Rollout", "name": "web", "uid": "u", "controller": true}
            ]},
        }))
        .unwrap();
        let key = cost_key(&rollout, &HashMap::new());
        assert_eq!(
            (key.group.as_str(), key.kind.as_str()),
            ("argoproj.io", "Rollout")
        );

        let run = pod(&running("ops", "backup-29-x2k9z", ("Job", "backup-29")));
        let crons = HashMap::from([(
            ("ops".to_string(), "backup-29".to_string()),
            "backup".to_string(),
        )]);
        let key = cost_key(&run, &crons);
        assert_eq!(
            (key.group.as_str(), key.kind.as_str()),
            ("batch", "CronJob")
        );

        let bare = pod(&Spec {
            owner: None,
            ..running("ops", "debug", ("", ""))
        });
        assert_eq!(cost_key(&bare, &HashMap::new()).group, "");
    }

    /// A claim two workloads mount is paid for once: billed whole to each,
    /// the namespace would add up to more than its volumes.
    #[test]
    fn a_claim_two_workloads_mount_is_split_between_them() {
        let a = Spec {
            claims: &["shared"],
            ..running("shop", "a-0", ("StatefulSet", "a"))
        };
        let b = Spec {
            claims: &["shared"],
            ..running("shop", "b-0", ("StatefulSet", "b"))
        };
        let volumes = Volumes {
            claims_known: true,
            claims: HashMap::from([(("shop".to_string(), "shared".to_string()), 10.0)]),
            by_namespace: BTreeMap::from([("shop".to_string(), 10.0)]),
            ..Volumes::default()
        };
        // One listed whole, one as the overview's store keeps it: stripped,
        // its claims beside it by uid.
        let kept = crate::overview::KeptClaims::default();
        let listed = pod(&b);
        crate::overview::keep_claims(&kept, &listed);
        let mut stored = (*listed).clone();
        crate::overview::strip_pod(&mut stored);
        let mut read = read_of(vec![pod(&a), Arc::new(stored)]);
        read.kept = Some(Arc::new(kept));
        let basis = assemble(&read, Ok((vec![], Ok(Some(vec![])))), &volumes, None);
        assert_eq!(row(&basis, "StatefulSet", "a").unwrap().claim_bytes, 5.0);
        assert_eq!(row(&basis, "StatefulSet", "b").unwrap().claim_bytes, 5.0);
        assert_eq!(basis.namespaces[0].storage_bytes, Some(10.0));
    }

    /// Storage nobody could read is unknown, not zero: zero is a namespace
    /// paying for no volumes, stated about one nobody looked at.
    #[test]
    fn a_namespace_s_storage_is_unknown_where_no_claim_could_be_read() {
        let read = read_of(vec![pod(&running("shop", "web-0", ("StatefulSet", "web")))]);
        let blind = Volumes {
            claims_known: false,
            ..Volumes::default()
        };
        let basis = assemble(&read, Ok((vec![], Ok(Some(vec![])))), &blind, None);
        assert_eq!(basis.namespaces[0].storage_bytes, None);

        let mut one_refused = Volumes {
            claims_known: true,
            ..Volumes::default()
        };
        one_refused
            .namespaces_unread
            .push(UnreadNamespace::of("shop".into(), &refused()));
        let basis = assemble(&read, Ok((vec![], Ok(Some(vec![])))), &one_refused, None);
        assert_eq!(basis.namespaces[0].storage_bytes, None);
        assert_eq!(basis.claims_unread[0].namespace, "shop");
    }

    /// A namespace whose pods were refused is named, never listed at zero,
    /// and the namespaces that answered keep their rows.
    #[test]
    fn a_namespace_whose_pods_were_refused_is_named_and_not_priced_at_zero() {
        let mut read = read_of(vec![pod(&running("shop", "web-0", ("StatefulSet", "web")))]);
        read.unread
            .push(UnreadNamespace::of("bank".into(), &refused()));
        let scope = ["bank".to_string(), "shop".to_string()];
        let volumes = Volumes {
            claims_known: true,
            ..Volumes::default()
        };
        let basis = assemble(
            &read,
            Ok((vec![], Ok(Some(vec![])))),
            &volumes,
            Some(&scope),
        );
        let named: Vec<_> = basis
            .namespaces
            .iter()
            .map(|n| n.namespace.as_str())
            .collect();
        assert_eq!(named, ["shop"]);
        assert_eq!(basis.unread[0].namespace, "bank");
    }

    /// A node that does not state its size is unpriced, not free.
    #[test]
    fn a_node_capacity_that_will_not_parse_is_none_and_not_zero() {
        let nodes = vec![node("node-a", "2", "4Gi"), node("node-b", "two", "4Gi")];
        let pods = vec![pod(&running("shop", "web-0", ("StatefulSet", "web")))];
        let rows = node_rows(&nodes, Some(&pods));
        assert_eq!(rows[0].cpu_capacity, Some(2000.0));
        assert_eq!(rows[0].cpu_requested, Some(100.0));
        assert_eq!(
            node_rows(&nodes, None)[0].cpu_requested,
            None,
            "pods not counted are not zero held"
        );
        assert_eq!(rows[0].gpus, 1.0);
        assert_eq!(rows[0].instance_type.as_deref(), Some("m5.large"));
        assert_eq!(rows[1].cpu_capacity, None);
    }

    /// The cut keeps the workloads that request most, and what it drops is
    /// added up rather than lost: kept plus rest is the whole scope.
    #[test]
    fn past_the_cap_the_rest_is_added_up_and_kept_plus_rest_is_the_total() {
        let rows: Vec<WorkloadBasis> = (0..5)
            .map(|i| WorkloadBasis {
                key: WorkloadKey {
                    namespace: "shop".into(),
                    group: "apps".into(),
                    kind: "Deployment".into(),
                    name: format!("w{i}"),
                },
                pods: 1,
                cpu: f64::from(i) * 100.0,
                memory: 0.0,
                gpus: 0.0,
                claim_bytes: 0.0,
            })
            .collect();
        let total: f64 = rows.iter().map(|r| r.cpu).sum();
        let (kept, rest) = keep(rows, 2);
        let names: Vec<_> = kept.iter().map(|r| r.key.name.as_str()).collect();
        assert_eq!(names, ["w3", "w4"]);
        let rest = rest.expect("three were cut");
        assert_eq!(rest.workloads, 3);
        assert_eq!(kept.iter().map(|r| r.cpu).sum::<f64>() + rest.cpu, total);
    }

    /// The frontend reads the same file; a constant edited on one side is the drift this catches.
    #[test]
    fn the_row_cap_matches_the_shared_file() {
        const BUDGET: &str = include_str!("../../../contracts/cost-budget.json");
        let budget: serde_json::Value = serde_json::from_str(BUDGET).unwrap();
        assert_eq!(budget["maxCostRows"], MAX_COST_ROWS);
    }

    /// The cap is what keeps one answer inside the IPC budget: a full
    /// answer with names at the length a label allows still fits.
    #[test]
    fn a_full_capped_answer_stays_under_the_ipc_target() {
        let long = |i: usize| format!("{i:0>63}");
        let workloads = (0..MAX_COST_ROWS)
            .map(|i| WorkloadBasis {
                key: WorkloadKey {
                    namespace: long(i % 100),
                    group: "apps".into(),
                    kind: "StatefulSet".into(),
                    name: long(i),
                },
                pods: 12,
                cpu: 123_456.789,
                memory: 123_456_789_012.0,
                gpus: 8.0,
                claim_bytes: 123_456_789_012.0,
            })
            .collect();
        let namespaces = (0..100)
            .map(|i| NamespaceBasis {
                namespace: long(i),
                workloads: 10,
                pods: 120,
                cpu: 123_456.789,
                memory: 123_456_789_012.0,
                gpus: 8.0,
                storage_bytes: Some(123_456_789_012.0),
            })
            .collect();
        let nodes = (0..200)
            .map(|i| NodeBasis {
                name: long(i),
                instance_type: Some("m5.24xlarge".into()),
                cpu_capacity: Some(96_000.0),
                cpu_allocatable: Some(95_000.0),
                memory_capacity: Some(400_000_000_000.0),
                memory_allocatable: Some(390_000_000_000.0),
                gpus: 8.0,
                cpu_requested: Some(90_000.0),
                memory_requested: Some(380_000_000_000.0),
                gpus_requested: Some(8.0),
            })
            .collect();
        let basis = CostBasis {
            nodes: Some(nodes),
            nodes_unread: None,
            held_unread: None,
            namespaces,
            workloads,
            rest: Some(RestBasis::default()),
            waiting: 0,
            unread: Vec::new(),
            volume_bytes: Some(1.0),
            volume_count: Some(1),
            unclaimed: Some(Vec::new()),
            volumes_unread: None,
            claims_unread: Vec::new(),
            served_from: OverviewSource::Watch,
        };
        let bytes = serde_json::to_vec(&basis).unwrap().len();
        assert!(bytes < 262_144, "a full answer is {bytes} bytes");
    }

    /// The perf rig is 10 000 pods Pending in ten namespaces on a node
    /// selector nothing matches. None of them is on a node, so none is
    /// billed: the answer is the count of pods waiting, not a row each.
    #[test]
    fn the_perf_rig_s_shape_answers_with_a_count_and_no_rows() {
        let names: Vec<(String, String)> = (0..10_000)
            .map(|i| (format!("perf-{}", i % 10), format!("p-{i:05}")))
            .collect();
        let pods = names
            .iter()
            .map(|(namespace, name)| {
                pod(&Spec {
                    node: None,
                    phase: "Pending",
                    owner: None,
                    ..running(namespace, name, ("", ""))
                })
            })
            .collect();
        let started = std::time::Instant::now();
        let basis = assemble(
            &read_of(pods),
            Ok((vec![], Ok(Some(vec![])))),
            &Volumes::default(),
            None,
        );
        let took = started.elapsed();
        let bytes = serde_json::to_vec(&basis).unwrap().len();
        eprintln!("rig shape: {bytes} bytes, assembled in {took:?}");
        assert_eq!(basis.waiting, 10_000);
        assert!(basis.workloads.is_empty());
        assert!(bytes < 1024, "{bytes} bytes");
    }

    /// Ten thousand pods on nodes, in a thousand workloads: the work is a
    /// pass over the pods, and the answer is the capped rows.
    #[test]
    fn ten_thousand_running_pods_fold_into_the_capped_rows() {
        let names: Vec<(String, String, String)> = (0..10_000)
            .map(|i| {
                (
                    format!("perf-{}", i % 10),
                    format!("w-{:04}-{i:05}", i % 1000),
                    format!("w-{:04}", i % 1000),
                )
            })
            .collect();
        let pods = names
            .iter()
            .map(|(namespace, name, owner)| pod(&running(namespace, name, ("StatefulSet", owner))))
            .collect();
        let started = std::time::Instant::now();
        let basis = assemble(
            &read_of(pods),
            Ok((vec![], Ok(Some(vec![])))),
            &Volumes::default(),
            None,
        );
        let took = started.elapsed();
        let bytes = serde_json::to_vec(&basis).unwrap().len();
        eprintln!("10 000 running pods: {bytes} bytes, assembled in {took:?}");
        assert_eq!(basis.workloads.len(), MAX_COST_ROWS);
        assert_eq!(
            basis.rest.as_ref().unwrap().workloads as usize,
            1000 - MAX_COST_ROWS
        );
        assert!(bytes < 262_144, "{bytes} bytes");
    }
}
