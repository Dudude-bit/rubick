//! Hubble Relay, read live: its observer API over a port-forward to a pod
//! behind the `hubble-relay` Service, folded into flows between workloads.
//!
//! The Service is found by the label Cilium's chart gives it
//! (`k8s-app=hubble-relay`, `templates/hubble-relay/service.yaml`), in
//! whatever namespace Cilium was installed to. How it serves is read from
//! its `hubble-relay-config`, where the chart writes
//! `disable-server-tls: true`, or `tls-relay-server-cert-file` and, for
//! mutual TLS, `tls-relay-client-ca-files` (`templates/_extensions.tpl`).
//! TLS is checked against the `ca.crt` of `hubble-relay-server-certs` alone,
//! read here and never sent on; mutual TLS asks for a client certificate the
//! app does not borrow, and is said.

#![allow(clippy::needless_pass_by_value)]
// Async because it spawns: Tauri runs a sync command off the reactor.
#![allow(clippy::unused_async)]

pub mod proto;

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use hyper_util::rt::TokioIo;
use k8s_openapi::api::core::v1::{ConfigMap, Pod, Secret, Service};
use kube::api::ListParams;
use kube::{Api, ResourceExt};
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;

use crate::client::K8sClientManager;
use crate::commands::cost::WorkloadKey;
use crate::commands::cost::{cost_key, scoped_pods_on, ScopedPods};
use crate::commands::helpers::scope_of;
use crate::error::{Error, Result};
use crate::integrations::prometheus::flows::{FlowEnd, NotListedWhy};
use crate::resources::facts_of;
use crate::state::streams::SUBSCRIBE_TIMEOUT;
use crate::state::{AppEvent, AppState};
use proto::flow::{self, DropReason, L7FlowType, Verdict};
use proto::observer::{get_flows_response::ResponseTypes, observer_client::ObserverClient};
use proto::relay::{NodeState, NodeStatusEvent};

/// How far back a pair's rates reach.
pub const WINDOW_SECS: u64 = 60;
/// Pairs held at once; a pair past it is counted, not drawn.
pub const MAX_LIVE_PAIRS: usize = 2000;
/// Pairs one event carries, well under the IPC target.
const BATCH_PAIRS: usize = 400;
/// Latencies a pair keeps a second, for its percentiles.
const KEPT_LATENCIES: usize = 64;
const SEND_EVERY: Duration = Duration::from_secs(1);
/// How often the connection asks the relay whether it is there, and how long
/// it waits: a port-forward that died in a sleep sends nothing, ever.
const KEEP_ALIVE: Duration = Duration::from_secs(15);
const SELECTOR: &str = "k8s-app=hubble-relay";
const CONFIG: &str = "hubble-relay-config";
const SERVER_CERTS: &str = "hubble-relay-server-certs";
/// The name its certificate is issued for: the chart's `relayName`, under
/// `*.hubble-relay.cilium.io`.
const SERVER_NAME: &str = "ui.hubble-relay.cilium.io";

/// A policy that denied a flow, as Hubble names it, with the API group of
/// its kind so the page can open it.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyRef {
    pub group: String,
    pub kind: String,
    pub namespace: Option<String>,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveDrop {
    /// Hubble's `DropReason` name, as it writes it: `POLICY_DENIED`.
    pub reason: String,
    pub rate: f64,
    pub policies: Vec<PolicyRef>,
    /// A request an L7 rule denied at the proxy, which Hubble gives no reason code.
    pub l7: bool,
}

/// One pair over the last `WINDOW_SECS`, every rate per second.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LivePair {
    pub from: FlowEnd,
    pub to: FlowEnd,
    pub forwarded: f64,
    pub dropped: f64,
    pub drops: Vec<LiveDrop>,
    /// HTTP responses Hubble saw, and the 5xx among them; `None` where it saw none.
    pub requests: Option<f64>,
    pub errors: Option<f64>,
    pub p50: Option<f64>,
    pub p95: Option<f64>,
    pub p99: Option<f64>,
    pub protocols: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveKey {
    pub from: FlowEnd,
    pub to: FlowEnd,
}

/// A node Hubble Relay cannot read flows from: none of its flows arrive.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnreachedNode {
    pub name: String,
    /// relay.proto's own word: `NODE_UNAVAILABLE` or `NODE_ERROR`.
    pub state: String,
    pub message: String,
}

/// Where the stream reads from, said once it is connected.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayAt {
    pub namespace: String,
    pub service: String,
    pub pod: String,
    /// Read over TLS, checked against the relay's own CA.
    pub tls: bool,
}

/// How a live stream ended; exactly one per stream.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "says", rename_all = "camelCase")]
pub enum LiveEnd {
    Closed,
    Unsubscribed,
    /// No Service carries the relay's label: Hubble Relay is not enabled.
    NotEnabled,
    /// The Services could not be listed: whether it is enabled is not known.
    NotLooked {
        said: String,
    },
    /// It asks every client for a certificate, which the app does not borrow.
    MutualTls {
        namespace: String,
    },
    /// It serves TLS and its CA could not be read.
    CaUnread {
        namespace: String,
        said: String,
    },
    /// It serves TLS and holds no `ca.crt` where the chart puts it.
    NoCa {
        namespace: String,
        secret: String,
    },
    /// Its certificate did not verify against that CA; `said` is the verifier's.
    NotVerified {
        namespace: String,
        said: String,
    },
    /// No pod behind it is ready.
    NoPod {
        namespace: String,
        service: String,
    },
    /// The relay closed the stream.
    RelayEnded,
    Failed {
        said: String,
    },
}

#[tauri::command]
pub async fn open_hubble_flows(
    scope: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<String> {
    let scope = scope_of(scope)?;
    let here = state.here()?;
    let context = here.context.clone();
    let clients = state.client_manager.clone();
    let cache = state.overview_cache.clone();
    let stream_id = crate::utils::generate_id("hubble");
    let mut opened = state.hubble_streams.open(stream_id.clone());
    let events = state.event_tx.clone();
    let id = stream_id.clone();
    tokio::spawn(async move {
        let end = if opened.wait_for_subscriber(SUBSCRIBE_TIMEOUT).await {
            let (cancel, _held) = opened.split();
            run(&clients, &cache, &context, scope, &id, &events, &cancel).await
        } else {
            LiveEnd::Unsubscribed
        };
        let _ = events.send(AppEvent::HubbleFlowsEnded { stream_id: id, end });
    });
    Ok(stream_id)
}

/// The frontend's listeners are up; let the flows come.
#[tauri::command]
pub fn hubble_flows_subscribed(stream_id: String, state: State<'_, AppState>) -> Result<()> {
    let _ = state.hubble_streams.subscribed(&stream_id);
    Ok(())
}

#[tauri::command]
pub fn close_hubble_flows(stream_id: String, state: State<'_, AppState>) -> Result<()> {
    let _ = state.hubble_streams.stop(&stream_id);
    Ok(())
}

fn client_of(clients: &K8sClientManager, context: &str) -> Result<kube::Client> {
    clients
        .get_client(context)
        .map(|client| (*client).clone())
        .ok_or_else(|| Error::NotConnected(context.to_string()))
}

#[derive(Debug, PartialEq, Eq)]
enum Serving {
    Plain,
    Tls,
    MutualTls,
}

/// A relay to read: where, through which pod and port, and the CA its TLS is
/// checked against.
#[derive(Debug)]
struct Found {
    at: RelayAt,
    remote: u16,
    ca: Option<Vec<u8>>,
}

/// Which relay to read, or why none.
async fn find(client: &kube::Client) -> std::result::Result<Found, LiveEnd> {
    let services = Api::<Service>::all(client.clone())
        .list(&ListParams::default().labels(SELECTOR))
        .await
        .map_err(|e| LiveEnd::NotLooked {
            said: Error::from(e).said(),
        })?;
    let Some(service) = services.items.into_iter().min_by_key(ResourceExt::name_any) else {
        return Err(LiveEnd::NotEnabled);
    };
    let namespace = service.namespace().unwrap_or_default();
    let name = service.name_any();
    let no_pod = || LiveEnd::NoPod {
        namespace: namespace.clone(),
        service: name.clone(),
    };
    let port = service
        .spec
        .as_ref()
        .and_then(|s| s.ports.as_ref()?.first().map(|p| p.port))
        .and_then(|p| u16::try_from(p).ok())
        .ok_or_else(no_pod)?;
    let config = Api::<ConfigMap>::namespaced(client.clone(), &namespace)
        .get_opt(CONFIG)
        .await;
    let serving = match config {
        Ok(Some(config)) => serving(&config),
        // Unread, the chart's own convention: 443 with TLS, 80 without.
        Ok(None) | Err(_) if port == 443 => Serving::Tls,
        Ok(None) | Err(_) => Serving::Plain,
    };
    let ca = match serving {
        Serving::Plain => None,
        Serving::MutualTls => return Err(LiveEnd::MutualTls { namespace }),
        Serving::Tls => Some(ca_of(client, &namespace).await?),
    };
    let selector = service
        .spec
        .as_ref()
        .and_then(|s| s.selector.clone())
        .unwrap_or_default()
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join(",");
    let pods = Api::<Pod>::namespaced(client.clone(), &namespace)
        .list(&ListParams::default().labels(&selector))
        .await
        .map_err(|e| LiveEnd::Failed {
            said: Error::from(e).said(),
        })?;
    let mut ready: Vec<&Pod> = pods.items.iter().filter(|p| is_ready(p)).collect();
    ready.sort_by_key(|p| p.name_any());
    let pod = ready.first().ok_or_else(no_pod)?;
    let remote = crate::commands::port_forward::pod_port(&service, port, pod).ok_or_else(no_pod)?;
    Ok(Found {
        at: RelayAt {
            namespace: namespace.clone(),
            service: name.clone(),
            pod: pod.name_any(),
            tls: ca.is_some(),
        },
        remote,
        ca,
    })
}

fn serving(config: &ConfigMap) -> Serving {
    let says = |key: &str| {
        config
            .data
            .iter()
            .flatten()
            .any(|(_, text)| text.contains(key))
    };
    if says("tls-relay-client-ca-files") {
        Serving::MutualTls
    } else if says("tls-relay-server-cert-file") {
        Serving::Tls
    } else {
        Serving::Plain
    }
}

/// The relay's CA, and nothing else of the Secret it sits in.
async fn ca_of(client: &kube::Client, namespace: &str) -> std::result::Result<Vec<u8>, LiveEnd> {
    let secret = Api::<Secret>::namespaced(client.clone(), namespace)
        .get_opt(SERVER_CERTS)
        .await
        .map_err(|e| LiveEnd::CaUnread {
            namespace: namespace.to_string(),
            said: Error::from(e).said(),
        })?;
    secret
        .and_then(|secret| secret.data?.remove("ca.crt"))
        .map(|bytes| bytes.0)
        .filter(|bytes| !bytes.is_empty())
        .ok_or_else(|| LiveEnd::NoCa {
            namespace: namespace.to_string(),
            secret: SERVER_CERTS.to_string(),
        })
}

fn is_ready(pod: &Pod) -> bool {
    pod.status
        .as_ref()
        .and_then(|s| s.conditions.as_ref())
        .is_some_and(|c| c.iter().any(|c| c.type_ == "Ready" && c.status == "True"))
}

/// The flows of `scope`: from or to a pod in one of its namespaces.
fn filters(scope: Option<&[String]>) -> Vec<flow::FlowFilter> {
    scope
        .into_iter()
        .flatten()
        .flat_map(|ns| {
            [
                flow::FlowFilter {
                    source_pod: vec![format!("{ns}/")],
                    ..Default::default()
                },
                flow::FlowFilter {
                    destination_pod: vec![format!("{ns}/")],
                    ..Default::default()
                },
            ]
        })
        .collect()
}

async fn connect(
    clients: &Arc<K8sClientManager>,
    context: &str,
    found: &Found,
) -> std::result::Result<ObserverClient<tonic::transport::Channel>, LiveEnd> {
    let clients = clients.clone();
    let context = context.to_string();
    let namespace = found.at.namespace.clone();
    let pod = found.at.pod.clone();
    let remote = found.remote;
    // A client per connection: a held one carries a token that expires.
    let connector = tower::service_fn(move |_: http::Uri| {
        let clients = clients.clone();
        let context = context.clone();
        let namespace = namespace.clone();
        let pod = pod.clone();
        async move {
            let client = client_of(&clients, &context).map_err(|e| e.said())?;
            let mut forwarder = Api::<Pod>::namespaced(client, &namespace)
                .portforward(&pod, &[remote])
                .await
                .map_err(|e| Error::from(e).said())?;
            let stream = forwarder
                .take_stream(remote)
                .ok_or_else(|| format!("{namespace}/{pod}:{remote}"))?;
            tokio::spawn(async move {
                let _ = forwarder.join().await;
            });
            Ok::<_, String>(TokioIo::new(stream))
        }
    });
    let endpoint = match &found.ca {
        None => tonic::transport::Endpoint::from_static("http://hubble-relay"),
        Some(ca) => tonic::transport::Endpoint::from_static("https://ui.hubble-relay.cilium.io")
            .tls_config(
                tonic::transport::ClientTlsConfig::new()
                    .ca_certificate(tonic::transport::Certificate::from_pem(ca))
                    .domain_name(SERVER_NAME),
            )
            .map_err(|e| LiveEnd::Failed {
                said: e.to_string(),
            })?,
    };
    let channel = kept_alive(endpoint, KEEP_ALIVE)
        .connect_with_connector(connector)
        .await
        .map_err(|e| ended_by(&e, &found.at.namespace))?;
    Ok(ObserverClient::new(channel))
}

fn kept_alive(endpoint: tonic::transport::Endpoint, every: Duration) -> tonic::transport::Endpoint {
    endpoint
        .http2_keep_alive_interval(every)
        .keep_alive_timeout(every)
        .keep_alive_while_idle(true)
}

/// How a failed connection or call ends the stream: a certificate the CA
/// did not vouch for, or a relay asking for one of ours, said as such with
/// the verifier's words; anything else as it was said.
fn ended_by(error: &(dyn std::error::Error + 'static), namespace: &str) -> LiveEnd {
    let mut next = Some(error);
    while let Some(at) = next {
        let inner = at
            .downcast_ref::<std::io::Error>()
            .and_then(std::io::Error::get_ref)
            .map(|inner| inner as &(dyn std::error::Error + 'static));
        for one in [Some(at), inner].into_iter().flatten() {
            match one.downcast_ref::<rustls::Error>() {
                Some(tls @ rustls::Error::InvalidCertificate(_)) => {
                    return LiveEnd::NotVerified {
                        namespace: namespace.to_string(),
                        said: tls.to_string(),
                    }
                }
                Some(rustls::Error::AlertReceived(
                    rustls::AlertDescription::CertificateRequired,
                )) => {
                    return LiveEnd::MutualTls {
                        namespace: namespace.to_string(),
                    }
                }
                _ => {}
            }
        }
        next = at.source();
    }
    LiveEnd::Failed {
        said: words_of(error),
    }
}

/// Every layer's own words, outermost first: a transport error says only
/// "transport error", and what failed is under it.
fn words_of(error: &(dyn std::error::Error + 'static)) -> String {
    let mut said: Vec<String> = Vec::new();
    let mut next = Some(error);
    while let Some(at) = next {
        let words = at.to_string();
        if said.last().is_none_or(|last| !last.contains(&words)) {
            said.push(words);
        }
        next = at.source();
    }
    said.join(": ")
}

/// How soon pods are read again when a flow names one the last read did not have.
const OWNERS_AGAIN: u64 = 15;

/// The namespaces whose pods name the live ends: the scope, and each one a
/// flow names a peer pod in. Read for this alone; the scope of anything
/// else stays the page's. `None` is every namespace.
fn owners_reach(
    scope: Option<&[String]>,
    missing: &BTreeSet<(String, String)>,
) -> Option<Vec<String>> {
    let mut reach: BTreeSet<String> = scope?.iter().cloned().collect();
    reach.extend(missing.iter().map(|(namespace, _)| namespace.clone()));
    Some(reach.into_iter().collect())
}

/// The pods of the scope, as their workloads, from the overview's stores
/// where they serve, by listing otherwise.
async fn owners_in(
    clients: &K8sClientManager,
    cache: &crate::overview::OverviewCache,
    context: &str,
    scope: Option<&[String]>,
) -> Owners {
    let Ok(client) = client_of(clients, context) else {
        return Owners::unread();
    };
    match scoped_pods_on(cache, client, context, scope).await {
        Ok(read) => Owners::of(&read),
        Err(_) => Owners::unread(),
    }
}

#[allow(clippy::too_many_lines)]
async fn run(
    clients: &Arc<K8sClientManager>,
    cache: &Arc<crate::overview::OverviewCache>,
    context: &str,
    scope: Option<Vec<String>>,
    id: &str,
    events: &broadcast::Sender<AppEvent>,
    cancel: &CancellationToken,
) -> LiveEnd {
    let client = match client_of(clients, context) {
        Ok(client) => client,
        Err(e) => return LiveEnd::Failed { said: e.said() },
    };
    let found = tokio::select! {
        () = cancel.cancelled() => return LiveEnd::Closed,
        found = find(&client) => found,
    };
    let found = match found {
        Ok(found) => found,
        Err(end) => return end,
    };
    let request = proto::observer::GetFlowsRequest {
        follow: true,
        whitelist: filters(scope.as_deref()),
        ..Default::default()
    };
    let opened = tokio::select! {
        () = cancel.cancelled() => return LiveEnd::Closed,
        opened = async {
            let mut observer = connect(clients, context, &found).await?;
            observer
                .get_flows(request)
                .await
                .map(tonic::Response::into_inner)
                .map_err(|status| ended_by(&status, &found.at.namespace))
        } => opened,
    };
    let mut stream = match opened {
        Ok(stream) => stream,
        Err(end) => return end,
    };
    let mut fold = Fold::new(now_secs());
    let send = |pairs: Vec<LivePair>, gone: Vec<LiveKey>, relay: Option<RelayAt>, fold: &Fold| {
        let _ = events.send(AppEvent::HubbleFlows {
            stream_id: id.to_string(),
            pairs,
            gone,
            relay,
            lost: fold.lost,
            untracked: fold.untracked,
            unreached: fold.unreached.values().cloned().collect(),
        });
    };
    send(Vec::new(), Vec::new(), Some(found.at), &fold);
    let (owners_tx, mut owners_rx) = tokio::sync::mpsc::channel::<Owners>(1);
    let read_owners = |tx: tokio::sync::mpsc::Sender<Owners>, reach: Option<Vec<String>>| {
        let (clients, cache, context) = (clients.clone(), cache.clone(), context.to_string());
        tokio::spawn(async move {
            let owners = owners_in(&clients, &cache, &context, reach.as_deref()).await;
            let _ = tx.send(owners).await;
        });
    };
    read_owners(owners_tx.clone(), scope.clone());
    let mut asked_at = now_secs();
    let mut asking = true;
    let mut asked: BTreeSet<String> = scope.iter().flatten().cloned().collect();
    let mut tick = tokio::time::interval(SEND_EVERY);
    loop {
        tokio::select! {
            biased;
            () = cancel.cancelled() => return LiveEnd::Closed,
            Some(owners) = owners_rx.recv() => {
                fold.owners_read(owners);
                asking = false;
            }
            _ = tick.tick() => {
                let now = now_secs();
                let reach = owners_reach(scope.as_deref(), &fold.owners.missing);
                let new_namespace = reach
                    .as_ref()
                    .is_some_and(|reach| reach.iter().any(|ns| !asked.contains(ns)));
                if !asking
                    && !fold.owners.missing.is_empty()
                    && (new_namespace || now.saturating_sub(asked_at) >= OWNERS_AGAIN)
                {
                    asked.extend(reach.iter().flatten().cloned());
                    read_owners(owners_tx.clone(), reach);
                    asked_at = now;
                    asking = true;
                }
                let (pairs, gone) = fold.tick(now);
                let nodes = std::mem::take(&mut fold.nodes_changed);
                for (pairs, gone) in batches(pairs, gone, nodes) {
                    send(pairs, gone, None, &fold);
                }
            }
            message = stream.message() => match message {
                Ok(Some(answer)) => match answer.response_types {
                    Some(ResponseTypes::Flow(one)) => fold.add(now_secs(), &one),
                    Some(ResponseTypes::LostEvents(lost)) => fold.lost += lost.num_events_lost,
                    Some(ResponseTypes::NodeStatus(status)) => fold.node_status(&status),
                    None => {}
                },
                Ok(None) => return LiveEnd::RelayEnded,
                Err(status) => return LiveEnd::Failed { said: status.message().to_string() },
            },
        }
    }
}

/// A tick's changes as events of at most `BATCH_PAIRS` pairs, what went with
/// the first; an empty one where only what went, or the nodes, changed.
fn batches(
    pairs: Vec<LivePair>,
    gone: Vec<LiveKey>,
    nodes: bool,
) -> Vec<(Vec<LivePair>, Vec<LiveKey>)> {
    if pairs.is_empty() {
        return if gone.is_empty() && !nodes {
            Vec::new()
        } else {
            vec![(Vec::new(), gone)]
        };
    }
    let mut gone = Some(gone);
    pairs
        .chunks(BATCH_PAIRS)
        .map(|chunk| (chunk.to_vec(), gone.take().unwrap_or_default()))
        .collect()
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// An end in another cluster of a Cluster Mesh, by the cluster its identity
/// carries: a name there is not the object of the same name here.
fn remote_of(endpoint: Option<&flow::Endpoint>, here: Option<&str>) -> Option<FlowEnd> {
    let endpoint = endpoint?;
    let cluster = endpoint.cluster_name.as_str();
    if cluster.is_empty() || here.is_none_or(|here| here == cluster) {
        return None;
    }
    let (kind, name) = endpoint
        .workloads
        .first()
        .map_or(("Pod", endpoint.pod_name.as_str()), |w| {
            (w.kind.as_str(), w.name.as_str())
        });
    (!name.is_empty()).then(|| FlowEnd::Remote {
        cluster: cluster.to_string(),
        namespace: endpoint.namespace.clone(),
        kind: kind.to_string(),
        name: name.to_string(),
    })
}

/// An end of a flow by what Hubble says it is: a workload with its kind, a
/// pod nothing owns, or a reserved identity such as `world`.
fn end_of(endpoint: Option<&flow::Endpoint>, address: &str, names: &[String]) -> FlowEnd {
    let Some(endpoint) = endpoint else {
        return FlowEnd::Unidentified {
            namespace: None,
            word: String::new(),
        };
    };
    if let Some(workload) = endpoint.workloads.first() {
        return FlowEnd::Workload {
            key: WorkloadKey {
                namespace: endpoint.namespace.clone(),
                group: facts_of(&workload.kind)
                    .map(|f| f.group.clone())
                    .unwrap_or_default(),
                kind: workload.kind.clone(),
                name: workload.name.clone(),
            },
        };
    }
    if !endpoint.pod_name.is_empty() {
        return FlowEnd::Workload {
            key: WorkloadKey {
                namespace: endpoint.namespace.clone(),
                group: String::new(),
                kind: "Pod".into(),
                name: endpoint.pod_name.clone(),
            },
        };
    }
    let reserved = endpoint
        .labels
        .iter()
        .find_map(|label| label.strip_prefix("reserved:"));
    match reserved {
        Some("world" | "world-ipv4" | "world-ipv6") if !address.is_empty() => FlowEnd::Address {
            address: names
                .first()
                .cloned()
                .unwrap_or_else(|| address.to_string()),
        },
        Some("host" | "remote-node") if !address.is_empty() => FlowEnd::Node {
            name: address.to_string(),
        },
        other => FlowEnd::Unidentified {
            namespace: (!endpoint.namespace.is_empty()).then(|| endpoint.namespace.clone()),
            word: other.unwrap_or_default().to_string(),
        },
    }
}

/// A drop's reason, and whether an L7 rule denied it.
type DropCause = (String, bool);

/// Cilium's monitor message type of a policy verdict (`pkg/monitor/api`).
const POLICY_VERDICT: i32 = 5;

/// One cause's drops. The datapath reports a denied packet twice, as a drop
/// and as a policy verdict, and only the verdict names the policy
/// (`CorrelatePolicy`): the two are counted apart and the larger kept.
#[derive(Default)]
struct Tally {
    drops: u32,
    verdicts: u32,
    policies: BTreeSet<PolicyRef>,
}

impl Tally {
    fn add(&mut self, other: &Tally) {
        self.drops += other.drops;
        self.verdicts += other.verdicts;
        self.policies.extend(other.policies.iter().cloned());
    }

    fn count(&self) -> u32 {
        self.drops.max(self.verdicts)
    }
}

#[derive(Default)]
struct Second {
    forwarded: u32,
    drops: BTreeMap<DropCause, Tally>,
    requests: u32,
    errors: u32,
    latencies: Vec<f64>,
    protocols: BTreeSet<String>,
}

type Key = (FlowEnd, FlowEnd);

/// Each pod's workload as the window's flows and Cost name it (`cost_key`),
/// for an end Hubble names by its pod alone: one workload is one node.
#[derive(Default)]
struct Owners {
    of: HashMap<(String, String), WorkloadKey>,
    /// Namespaces whose pods could not be read; `all` where none could.
    unread: BTreeSet<String>,
    all: bool,
    /// Pods named by a flow and not in the last read: a reason to read again.
    missing: BTreeSet<(String, String)>,
}

impl Owners {
    fn of(read: &ScopedPods) -> Self {
        Self {
            of: read
                .pods
                .iter()
                .filter_map(|pod| {
                    let key = cost_key(pod, &read.cron_of);
                    Some(((key.namespace.clone(), pod.metadata.name.clone()?), key))
                })
                .collect(),
            unread: read.unread.iter().map(|u| u.namespace.clone()).collect(),
            all: false,
            missing: BTreeSet::new(),
        }
    }

    fn unread() -> Self {
        Self {
            all: true,
            ..Self::default()
        }
    }

    /// A bare pod as its workload; one whose pods could not be read as not
    /// listed for that reason; one nothing owns as itself.
    fn resolve(&mut self, end: FlowEnd) -> FlowEnd {
        let FlowEnd::Workload { key } = &end else {
            return end;
        };
        if key.kind != "Pod" || !key.group.is_empty() {
            return end;
        }
        let at = (key.namespace.clone(), key.name.clone());
        if let Some(owner) = self.of.get(&at) {
            return FlowEnd::Workload { key: owner.clone() };
        }
        if self.all || self.unread.contains(&key.namespace) {
            return FlowEnd::NotListed {
                namespace: at.0,
                name: at.1,
                kind: Some("Pod".into()),
                why: NotListedWhy::PodsUnread,
            };
        }
        self.missing.insert(at);
        end
    }
}

/// Every pair seen in the window, a bucket a second, and which changed.
struct Fold {
    started: u64,
    pairs: HashMap<Key, VecDeque<(u64, Second)>>,
    touched: BTreeSet<Key>,
    lost: u64,
    untracked: u64,
    unreached: BTreeMap<String, UnreachedNode>,
    nodes_changed: bool,
    owners: Owners,
    /// Each pair as last sent, so a second that changes nothing a reader
    /// sees sends nothing.
    sent: HashMap<Key, LivePair>,
}

fn policies(denied: &[flow::Policy]) -> Vec<PolicyRef> {
    let mut out: Vec<PolicyRef> = denied
        .iter()
        .map(|p| PolicyRef {
            group: if p.kind.starts_with("Cilium") {
                "cilium.io".to_string()
            } else {
                facts_of(&p.kind)
                    .map(|f| f.group.clone())
                    .unwrap_or_default()
            },
            kind: p.kind.clone(),
            namespace: (!p.namespace.is_empty()).then(|| p.namespace.clone()),
            name: p.name.clone(),
        })
        .collect();
    out.sort();
    out.dedup();
    out
}

impl Fold {
    fn new(now: u64) -> Self {
        Self {
            started: now,
            pairs: HashMap::new(),
            touched: BTreeSet::new(),
            lost: 0,
            untracked: 0,
            unreached: BTreeMap::new(),
            nodes_changed: false,
            owners: Owners::default(),
            sent: HashMap::new(),
        }
    }

    /// A new read of the pods: pairs held under a pod it names are moved to
    /// its workload, merged with what that pair already holds.
    fn owners_read(&mut self, owners: Owners) {
        self.owners = owners;
        let held: Vec<Key> = self.pairs.keys().cloned().collect();
        for old in held {
            let new = (
                self.owners.resolve(old.0.clone()),
                self.owners.resolve(old.1.clone()),
            );
            if new == old {
                continue;
            }
            let Some(moved) = self.pairs.remove(&old) else {
                continue;
            };
            let into = self.pairs.entry(new.clone()).or_default();
            let mut by: BTreeMap<u64, Second> = into.drain(..).collect();
            for (at, second) in moved {
                by.entry(at).or_default().absorb(&second);
            }
            into.extend(by);
            self.touched.insert(old);
            self.touched.insert(new);
        }
    }

    /// Relay's word on its nodes: one it cannot reach sends no flows, so it
    /// is held until it is connected again or gone from the cluster.
    fn node_status(&mut self, status: &NodeStatusEvent) {
        let state = NodeState::try_from(status.state_change).unwrap_or(NodeState::UnknownNodeState);
        for name in &status.node_names {
            match state {
                NodeState::NodeUnavailable | NodeState::NodeError => {
                    self.unreached.insert(
                        name.clone(),
                        UnreachedNode {
                            name: name.clone(),
                            state: state.as_str_name().to_string(),
                            message: status.message.clone(),
                        },
                    );
                }
                NodeState::NodeConnected | NodeState::NodeGone => {
                    self.unreached.remove(name);
                }
                NodeState::UnknownNodeState => continue,
            }
            self.nodes_changed = true;
        }
    }

    /// One flow event. A reply is the same connection the other way and is
    /// not counted again; only forwarded, dropped and HTTP responses count.
    fn add(&mut self, now: u64, one: &flow::Flow) {
        if one.is_reply == Some(true) && one.l7.is_none() {
            return;
        }
        let response = one
            .l7
            .as_ref()
            .filter(|l7| l7.r#type == L7FlowType::Response as i32);
        // A request an L7 rule denied is logged DROPPED (seven parser's
        // decodeVerdict), and is the only L7 request counted.
        let counted = match (Verdict::try_from(one.verdict), &one.l7) {
            (verdict, Some(_)) => response.is_some() || verdict == Ok(Verdict::Dropped),
            (Ok(Verdict::Forwarded | Verdict::Dropped), None) => true,
            _ => false,
        };
        if !counted {
            return;
        }
        let ip = one.ip.as_ref();
        // A flow's node is `<cluster>/<node>` (GetAbsoluteNodeName): the
        // cluster whose relay is read.
        let here = one.node_name.split_once('/').map(|(cluster, _)| cluster);
        let from = remote_of(one.source.as_ref(), here).unwrap_or_else(|| {
            end_of(
                one.source.as_ref(),
                ip.map_or("", |i| i.source.as_str()),
                &one.source_names,
            )
        });
        let to = remote_of(one.destination.as_ref(), here).unwrap_or_else(|| {
            end_of(
                one.destination.as_ref(),
                ip.map_or("", |i| i.destination.as_str()),
                &one.destination_names,
            )
        });
        // Cilium logs an L7 response from the server to the client
        // (pkg/envoy/accesslog_server.go swaps the addresses); the pair is the caller's.
        let (from, to) = (self.owners.resolve(from), self.owners.resolve(to));
        let key = if response.is_some() {
            (to, from)
        } else {
            (from, to)
        };
        if !self.pairs.contains_key(&key) && self.pairs.len() >= MAX_LIVE_PAIRS {
            self.untracked += 1;
            return;
        }
        let seconds = self.pairs.entry(key.clone()).or_default();
        if seconds.back().is_none_or(|(at, _)| *at != now) {
            seconds.push_back((now, Second::default()));
        }
        let Some((_, second)) = seconds.back_mut() else {
            return;
        };
        if let Some(l7) = response {
            if let Some(flow::layer7::Record::Http(http)) = &l7.record {
                second.requests += 1;
                second.errors += u32::from(http.code >= 500);
                if !http.protocol.is_empty() {
                    second.protocols.insert(http.protocol.clone());
                }
                if second.latencies.len() < KEPT_LATENCIES {
                    #[allow(clippy::cast_precision_loss)]
                    second.latencies.push(l7.latency_ns as f64 / 1e6);
                }
            }
        } else if one.verdict == Verdict::Dropped as i32 {
            let reason = DropReason::try_from(one.drop_reason_desc).map_or_else(
                |_| one.drop_reason_desc.to_string(),
                |r| r.as_str_name().to_string(),
            );
            let denied = policies(
                &[
                    one.ingress_denied_by.as_slice(),
                    one.egress_denied_by.as_slice(),
                ]
                .concat(),
            );
            let tally = second.drops.entry((reason, one.l7.is_some())).or_default();
            tally.policies.extend(denied);
            if one
                .event_type
                .as_ref()
                .is_some_and(|e| e.r#type == POLICY_VERDICT)
            {
                tally.verdicts += 1;
            } else {
                tally.drops += 1;
            }
        } else {
            second.forwarded += 1;
        }
        self.touched.insert(key);
    }

    /// The pairs whose window changed since the last tick, and the pairs
    /// it emptied.
    fn tick(&mut self, now: u64) -> (Vec<LivePair>, Vec<LiveKey>) {
        let oldest = now.saturating_sub(WINDOW_SECS - 1);
        let span = now.saturating_sub(self.started).clamp(1, WINDOW_SECS);
        let mut changed = std::mem::take(&mut self.touched);
        // Until a whole window has passed every rate's divisor grows each
        // second, so every pair is said again.
        if now.saturating_sub(self.started) <= WINDOW_SECS {
            changed.extend(self.pairs.keys().cloned());
        }
        for (key, seconds) in &mut self.pairs {
            let before = seconds.len();
            while seconds.front().is_some_and(|(at, _)| *at < oldest) {
                seconds.pop_front();
            }
            if seconds.len() != before {
                changed.insert(key.clone());
            }
        }
        let mut pairs = Vec::new();
        let mut gone = Vec::new();
        for key in changed {
            match self.pairs.get(&key) {
                Some(seconds) if !seconds.is_empty() => {
                    let pair = shown(summary(&key, seconds, span));
                    if self.sent.get(&key) != Some(&pair) {
                        self.sent.insert(key, pair.clone());
                        pairs.push(pair);
                    }
                }
                _ => {
                    self.pairs.remove(&key);
                    self.sent.remove(&key);
                    gone.push(LiveKey {
                        from: key.0,
                        to: key.1,
                    });
                }
            }
        }
        (pairs, gone)
    }
}

/// A rate as the page draws it: three significant figures, whole from 100.
#[allow(clippy::cast_possible_truncation)]
fn figure(value: f64) -> f64 {
    if value == 0.0 || !value.is_finite() {
        return value;
    }
    if value.abs() >= 100.0 {
        return value.round();
    }
    let scale = 10f64.powi(2 - value.abs().log10().floor() as i32);
    (value * scale).round() / scale
}

/// A pair at the precision it is drawn at.
fn shown(pair: LivePair) -> LivePair {
    let some = |v: Option<f64>| v.map(figure);
    LivePair {
        forwarded: figure(pair.forwarded),
        dropped: figure(pair.dropped),
        drops: pair
            .drops
            .into_iter()
            .map(|drop| LiveDrop {
                rate: figure(drop.rate),
                ..drop
            })
            .collect(),
        requests: some(pair.requests),
        errors: some(pair.errors),
        p50: some(pair.p50),
        p95: some(pair.p95),
        p99: some(pair.p99),
        ..pair
    }
}

impl Second {
    fn absorb(&mut self, other: &Second) {
        self.forwarded += other.forwarded;
        self.requests += other.requests;
        self.errors += other.errors;
        for (why, tally) in &other.drops {
            self.drops.entry(why.clone()).or_default().add(tally);
        }
        self.latencies.extend_from_slice(&other.latencies);
        self.protocols.extend(other.protocols.iter().cloned());
    }
}

#[allow(clippy::cast_precision_loss)]
fn summary(key: &Key, seconds: &VecDeque<(u64, Second)>, span: u64) -> LivePair {
    let per = |n: u32| f64::from(n) / span as f64;
    let mut sum = Second::default();
    for (_, second) in seconds {
        sum.absorb(second);
    }
    sum.latencies.sort_by(f64::total_cmp);
    let latencies = &sum.latencies;
    let at = |q: f64| {
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let i = ((latencies.len().saturating_sub(1)) as f64 * q).round() as usize;
        latencies.get(i).copied()
    };
    let answered = sum.requests > 0;
    LivePair {
        from: key.0.clone(),
        to: key.1.clone(),
        forwarded: per(sum.forwarded),
        dropped: per(sum.drops.values().map(Tally::count).sum()),
        drops: sum
            .drops
            .into_iter()
            .map(|((reason, l7), tally)| LiveDrop {
                reason,
                rate: per(tally.count()),
                policies: tally.policies.into_iter().collect(),
                l7,
            })
            .collect(),
        requests: answered.then(|| per(sum.requests)),
        errors: answered.then(|| per(sum.errors)),
        p50: at(0.5),
        p95: at(0.95),
        p99: at(0.99),
        protocols: sum.protocols.into_iter().collect(),
    }
}

#[cfg(test)]
#[allow(clippy::float_cmp)]
mod tests {
    use super::*;
    use crate::client::served::test_server::{answering, failure};
    use serde_json::json;

    fn endpoint(namespace: &str, workload: Option<(&str, &str)>, pod: &str) -> flow::Endpoint {
        flow::Endpoint {
            namespace: namespace.into(),
            pod_name: pod.into(),
            workloads: workload
                .iter()
                .map(|(kind, name)| flow::Workload {
                    kind: (*kind).into(),
                    name: (*name).into(),
                })
                .collect(),
            ..Default::default()
        }
    }

    fn event(verdict: Verdict, from: &str, to: &str) -> flow::Flow {
        flow::Flow {
            verdict: verdict as i32,
            source: Some(endpoint("shop", Some(("Deployment", from)), "")),
            destination: Some(endpoint("shop", Some(("Deployment", to)), "")),
            ..Default::default()
        }
    }

    fn response(code: u32, latency_ms: u64) -> flow::Flow {
        flow::Flow {
            l7: Some(flow::Layer7 {
                r#type: L7FlowType::Response as i32,
                latency_ns: latency_ms * 1_000_000,
                record: Some(flow::layer7::Record::Http(flow::Http {
                    code,
                    protocol: "HTTP/1.1".into(),
                    ..Default::default()
                })),
            }),
            is_reply: Some(true),
            // As Cilium writes a response: from the server to the client.
            ..event(Verdict::Forwarded, "api", "web")
        }
    }

    /// A reply is the connection already counted; a drop keeps Hubble's
    /// reason and every policy that denied it, by kind, namespace and name.
    #[test]
    fn replies_are_not_counted_again_and_drops_keep_their_reason_and_policy() {
        let mut fold = Fold::new(100);
        fold.add(100, &event(Verdict::Forwarded, "web", "api"));
        fold.add(
            100,
            &flow::Flow {
                is_reply: Some(true),
                ..event(Verdict::Forwarded, "api", "web")
            },
        );
        fold.add(
            100,
            &flow::Flow {
                drop_reason_desc: DropReason::PolicyDenied as i32,
                ingress_denied_by: vec![flow::Policy {
                    name: "deny-all".into(),
                    namespace: "shop".into(),
                    kind: "NetworkPolicy".into(),
                    ..Default::default()
                }],
                ..event(Verdict::Dropped, "web", "db")
            },
        );
        fold.add(100, &event(Verdict::Traced, "web", "api"));
        let (pairs, gone) = fold.tick(101);
        assert!(gone.is_empty());
        assert_eq!(pairs.len(), 2);
        let api = pairs
            .iter()
            .find(|p| p.forwarded > 0.0)
            .expect("web to api");
        assert_eq!(api.forwarded, 1.0);
        let db = pairs.iter().find(|p| p.dropped > 0.0).expect("web to db");
        assert_eq!(db.drops[0].reason, "POLICY_DENIED");
        assert_eq!(
            db.drops[0].policies,
            vec![PolicyRef {
                group: "networking.k8s.io".into(),
                kind: "NetworkPolicy".into(),
                namespace: Some("shop".into()),
                name: "deny-all".into(),
            }]
        );
    }

    /// One denied packet is a drop notification and a policy verdict, both
    /// DROPPED: counted once, with the policy only the verdict names; with
    /// drop notifications off, the verdicts alone are the count.
    #[test]
    fn a_denied_packet_is_one_drop_named_by_its_policy_verdict() {
        let denied = |kind: i32, by: &str| flow::Flow {
            event_type: Some(flow::CiliumEventType {
                r#type: kind,
                sub_type: 0,
            }),
            drop_reason_desc: DropReason::PolicyDenied as i32,
            ingress_denied_by: if by.is_empty() {
                vec![]
            } else {
                vec![flow::Policy {
                    name: by.into(),
                    namespace: "shop".into(),
                    kind: "NetworkPolicy".into(),
                    ..Default::default()
                }]
            },
            ..event(Verdict::Dropped, "intruder", "db")
        };
        let mut fold = Fold::new(100);
        fold.add(100, &denied(POLICY_VERDICT, "db-from-caller-only"));
        fold.add(100, &denied(1, ""));
        let (pairs, _) = fold.tick(101);
        assert_eq!(pairs[0].dropped, 1.0);
        assert_eq!(pairs[0].drops.len(), 1);
        assert_eq!(pairs[0].drops[0].rate, 1.0);
        assert_eq!(pairs[0].drops[0].policies[0].name, "db-from-caller-only");

        let mut verdicts_only = Fold::new(100);
        verdicts_only.add(100, &denied(POLICY_VERDICT, "db-from-caller-only"));
        verdicts_only.add(100, &denied(POLICY_VERDICT, "db-from-caller-only"));
        assert_eq!(verdicts_only.tick(101).0[0].dropped, 2.0);
    }

    /// A request an L7 rule denied is a drop the pair carries, marked as
    /// such; a request the proxy let through is counted on its response only.
    #[test]
    fn a_request_an_l7_rule_denied_is_a_drop() {
        let mut fold = Fold::new(100);
        let request = |verdict| flow::Flow {
            l7: Some(flow::Layer7 {
                r#type: L7FlowType::Request as i32,
                record: Some(flow::layer7::Record::Http(flow::Http {
                    method: "PUT".into(),
                    ..Default::default()
                })),
                ..Default::default()
            }),
            ..event(verdict, "caller", "web")
        };
        fold.add(100, &request(Verdict::Dropped));
        fold.add(100, &request(Verdict::Forwarded));
        let (pairs, _) = fold.tick(101);
        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0].dropped, 1.0);
        assert_eq!(pairs[0].forwarded, 0.0);
        assert!(pairs[0].drops[0].l7);
        assert_eq!(pairs[0].drops[0].reason, "DROP_REASON_UNKNOWN");
    }

    /// HTTP is counted on its responses, with 5xx as errors and latency as
    /// percentiles; a pair with no HTTP has no requests, not zero.
    #[test]
    fn http_responses_give_requests_errors_and_percentiles_and_no_http_is_none() {
        let mut fold = Fold::new(100);
        for (code, ms) in [(200, 10), (200, 20), (503, 30), (200, 40)] {
            fold.add(100, &response(code, ms));
        }
        fold.add(
            100,
            &flow::Flow {
                l7: Some(flow::Layer7 {
                    r#type: L7FlowType::Request as i32,
                    record: Some(flow::layer7::Record::Http(flow::Http {
                        method: "GET".into(),
                        ..Default::default()
                    })),
                    ..Default::default()
                }),
                ..event(Verdict::Forwarded, "web", "api")
            },
        );
        fold.add(100, &event(Verdict::Forwarded, "web", "db"));
        let (pairs, _) = fold.tick(101);
        let named = |end: &FlowEnd| match end {
            FlowEnd::Workload { key } => key.name.clone(),
            _ => String::new(),
        };
        let http: Vec<_> = pairs.iter().filter(|p| p.requests.is_some()).collect();
        assert_eq!(http.len(), 1, "one pair, the caller's");
        let api = http[0];
        assert_eq!(
            (named(&api.from), named(&api.to)),
            ("web".into(), "api".into())
        );
        assert_eq!(api.requests, Some(4.0));
        assert_eq!(api.errors, Some(1.0));
        assert_eq!(api.p50, Some(30.0));
        assert_eq!(api.protocols, vec!["HTTP/1.1".to_string()]);
        let db = pairs
            .iter()
            .find(|p| p.requests.is_none())
            .expect("L4 only");
        assert_eq!(db.errors, None);
    }

    /// A tick sends only the pairs whose minute changed, and says which it
    /// emptied: one busy pair is one row, not the whole table.
    #[test]
    fn a_tick_sends_only_what_changed_and_says_what_went() {
        let mut fold = Fold::new(0);
        fold.add(100, &event(Verdict::Forwarded, "web", "api"));
        fold.add(100, &event(Verdict::Forwarded, "web", "db"));
        assert_eq!(fold.tick(101).0.len(), 2);
        fold.add(110, &event(Verdict::Forwarded, "web", "api"));
        let (again, gone) = fold.tick(111);
        assert_eq!(again.len(), 1);
        assert!(gone.is_empty());
        let (_, gone) = fold.tick(100 + WINDOW_SECS);
        assert_eq!(gone.len(), 1);
        assert!(matches!(&gone[0].to, FlowEnd::Workload { key } if key.name == "db"));
    }

    /// In the first minute a pair's rate is over the seconds so far, which
    /// grow each tick: a pair nothing touched again is still said again, or
    /// it keeps the rate of the second it was seen.
    #[test]
    fn a_quiet_pair_is_said_again_while_the_first_window_fills() {
        let mut fold = Fold::new(100);
        fold.add(102, &event(Verdict::Forwarded, "web", "api"));
        let first = fold.tick(103).0;
        assert_eq!(first[0].forwarded, 0.333);
        let later = fold.tick(150).0;
        assert_eq!(later.len(), 1);
        assert_eq!(later[0].forwarded, 1.0 / 50.0);
        assert!(
            fold.tick(161).0.is_empty(),
            "a full window: only what changed"
        );
    }

    fn deployment(name: &str) -> WorkloadKey {
        WorkloadKey {
            namespace: "shop".into(),
            group: "apps".into(),
            kind: "Deployment".into(),
            name: name.into(),
        }
    }

    /// A flow from `pod` with no workload Hubble named, to Deployment web.
    fn from_pod(pod: &str) -> flow::Flow {
        flow::Flow {
            verdict: Verdict::Forwarded as i32,
            source: Some(endpoint("shop", None, pod)),
            destination: Some(endpoint("shop", Some(("Deployment", "web")), "")),
            ..Default::default()
        }
    }

    /// Hubble names one end by its workload in one flow and by its pod alone
    /// in the next: read through the pods, both are one workload, one pair.
    #[test]
    fn a_workload_hubble_names_by_its_pod_is_one_end() {
        let mut fold = Fold::new(0);
        fold.owners_read(Owners {
            of: HashMap::from([(
                ("shop".into(), "caller-649d545b48-c74f8".into()),
                deployment("caller"),
            )]),
            ..Owners::default()
        });
        fold.add(100, &from_pod("caller-649d545b48-c74f8"));
        fold.add(100, &event(Verdict::Forwarded, "caller", "web"));
        let (pairs, _) = fold.tick(101);
        assert_eq!(pairs.len(), 1);
        assert_eq!(
            pairs[0].from,
            FlowEnd::Workload {
                key: deployment("caller")
            }
        );
        assert_eq!(pairs[0].forwarded, 0.0333);
    }

    /// Flows held under a pod before the pods were read move to its workload
    /// when they are, merged with that pair, and the pod's row goes.
    #[test]
    fn pairs_held_under_a_pod_move_to_its_workload_once_the_pods_are_read() {
        let mut fold = Fold::new(0);
        fold.add(100, &from_pod("caller-649d545b48-c74f8"));
        fold.add(100, &event(Verdict::Forwarded, "caller", "web"));
        assert!(fold
            .owners
            .missing
            .contains(&("shop".into(), "caller-649d545b48-c74f8".into())));
        fold.tick(101);
        fold.owners_read(Owners {
            of: HashMap::from([(
                ("shop".into(), "caller-649d545b48-c74f8".into()),
                deployment("caller"),
            )]),
            ..Owners::default()
        });
        let (pairs, gone) = fold.tick(102);
        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0].forwarded, 0.0333);
        assert!(
            matches!(&gone[..], [LiveKey { from: FlowEnd::Workload { key }, .. }] if key.kind == "Pod")
        );
    }

    /// A pod whose namespace's pods could not be read is not called a pod
    /// nothing owns; one the read holds no owner for stays a pod.
    #[test]
    fn a_pod_is_not_listed_where_pods_were_unread_and_itself_where_nothing_owns_it() {
        let mut unread = Fold::new(0);
        unread.owners_read(Owners::unread());
        unread.add(100, &from_pod("caller-649d545b48-c74f8"));
        assert!(matches!(
            &unread.tick(101).0[0].from,
            FlowEnd::NotListed { why: NotListedWhy::PodsUnread, kind: Some(kind), .. } if kind == "Pod"
        ));
        let mut read = Fold::new(0);
        read.owners_read(Owners::default());
        read.add(100, &from_pod("debug"));
        assert!(matches!(
            &read.tick(101).0[0].from,
            FlowEnd::Workload { key } if key.kind == "Pod" && key.name == "debug"
        ));
    }

    /// A pair whose numbers, as drawn, did not move is not sent again: an
    /// unchanged second costs the page nothing.
    #[test]
    fn a_pair_whose_drawn_numbers_did_not_move_is_not_sent_again() {
        let mut fold = Fold::new(0);
        let mut sent = Vec::new();
        for now in 100..200 {
            fold.add(now, &event(Verdict::Forwarded, "caller", "web"));
            sent.push(fold.tick(now + 1).0.len());
        }
        assert_eq!(sent[0], 1);
        assert!(sent[70..].iter().all(|n| *n == 0), "{sent:?}");
        assert_eq!(figure(4.7412), 4.74);
        assert_eq!(figure(1234.4), 1234.0);
    }

    /// A peer's pod in a namespace outside the page's scope is read in its own
    /// namespace too, for its owner and nothing else: the scope is not widened.
    #[test]
    fn a_peer_pod_outside_the_scope_is_read_in_its_own_namespace() {
        let missing = BTreeSet::from([
            (
                "kube-system".to_string(),
                "coredns-589f44dc88-5d2n7".to_string(),
            ),
            ("shop".to_string(), "caller-649d545b48-c74f8".to_string()),
        ]);
        assert_eq!(
            owners_reach(Some(&["shop".to_string()]), &missing),
            Some(vec!["kube-system".to_string(), "shop".to_string()])
        );
        assert_eq!(owners_reach(None, &missing), None);
        let mut fold = Fold::new(0);
        fold.owners_read(Owners {
            of: HashMap::from([(
                ("kube-system".into(), "coredns-589f44dc88-5d2n7".into()),
                WorkloadKey {
                    namespace: "kube-system".into(),
                    group: "apps".into(),
                    kind: "Deployment".into(),
                    name: "coredns".into(),
                },
            )]),
            ..Owners::default()
        });
        fold.add(
            100,
            &flow::Flow {
                verdict: Verdict::Forwarded as i32,
                source: Some(endpoint("shop", Some(("Deployment", "caller")), "")),
                destination: Some(endpoint("kube-system", None, "coredns-589f44dc88-5d2n7")),
                ..Default::default()
            },
        );
        assert!(matches!(
            &fold.tick(101).0[0].to,
            FlowEnd::Workload { key } if key.kind == "Deployment" && key.name == "coredns"
        ));
    }

    /// Past the cap a new pair is counted and not held.
    #[test]
    fn pairs_past_the_cap_are_counted_not_held() {
        let mut fold = Fold::new(100);
        for i in 0..=MAX_LIVE_PAIRS {
            fold.add(100, &event(Verdict::Forwarded, "web", &format!("api-{i}")));
        }
        assert_eq!(fold.pairs.len(), MAX_LIVE_PAIRS);
        assert_eq!(fold.untracked, 1);
    }

    /// A node relay cannot reach is held until it connects again, and a tick
    /// that changed only that still sends it: with no flows anywhere, the
    /// page would otherwise say none were seen.
    #[test]
    fn a_node_relay_cannot_reach_is_held_and_sent_until_it_connects() {
        let mut fold = Fold::new(0);
        fold.node_status(&NodeStatusEvent {
            state_change: NodeState::NodeUnavailable as i32,
            node_names: vec!["kind/worker".into(), "kind/worker2".into()],
            message: "connection refused".into(),
        });
        fold.node_status(&NodeStatusEvent {
            state_change: NodeState::NodeConnected as i32,
            node_names: vec!["kind/worker2".into()],
            message: String::new(),
        });
        assert_eq!(
            fold.unreached.values().cloned().collect::<Vec<_>>(),
            vec![UnreachedNode {
                name: "kind/worker".into(),
                state: "NODE_UNAVAILABLE".into(),
                message: "connection refused".into(),
            }]
        );
        let (pairs, gone) = fold.tick(100);
        let nodes = std::mem::take(&mut fold.nodes_changed);
        assert_eq!(batches(pairs, gone, nodes).len(), 1);
        let (pairs, gone) = fold.tick(101);
        assert!(batches(pairs, gone, fold.nodes_changed).is_empty());
    }

    /// Hubble's own words for an end: a workload with its kind, a pod
    /// nothing owns, an address outside by its name, and anything else
    /// kept as the identity it wrote.
    #[test]
    fn an_end_is_what_hubble_says_it_is() {
        let deployment = end_of(
            Some(&endpoint("shop", Some(("Deployment", "web")), "web-1")),
            "",
            &[],
        );
        assert!(
            matches!(deployment, FlowEnd::Workload { key } if key.group == "apps" && key.name == "web")
        );
        let bare = end_of(Some(&endpoint("shop", None, "debug")), "", &[]);
        assert!(matches!(bare, FlowEnd::Workload { key } if key.kind == "Pod"));
        let world = flow::Endpoint {
            labels: vec!["reserved:world".into()],
            ..Default::default()
        };
        assert_eq!(
            end_of(Some(&world), "93.184.216.34", &["example.com".into()]),
            FlowEnd::Address {
                address: "example.com".into()
            }
        );
        let apiserver = flow::Endpoint {
            labels: vec!["reserved:kube-apiserver".into()],
            ..Default::default()
        };
        assert_eq!(
            end_of(Some(&apiserver), "10.0.0.1", &[]),
            FlowEnd::Unidentified {
                namespace: None,
                word: "kube-apiserver".into()
            }
        );
    }

    /// In a Cluster Mesh a name in another cluster is not the workload of
    /// the same name here: it is said with its cluster, and a local or
    /// unlabelled end stays as Hubble names it.
    #[test]
    fn an_end_in_another_cluster_of_the_mesh_is_remote() {
        let mut fold = Fold::new(0);
        let at = |cluster: &str, name: &str| flow::Endpoint {
            cluster_name: cluster.into(),
            ..endpoint("shop", Some(("Deployment", name)), "")
        };
        fold.add(
            100,
            &flow::Flow {
                verdict: Verdict::Forwarded as i32,
                node_name: "east/kind-worker".into(),
                source: Some(at("west", "web")),
                destination: Some(at("east", "api")),
                ..Default::default()
            },
        );
        let (pairs, _) = fold.tick(101);
        assert_eq!(
            pairs[0].from,
            FlowEnd::Remote {
                cluster: "west".into(),
                namespace: "shop".into(),
                kind: "Deployment".into(),
                name: "web".into(),
            }
        );
        assert!(matches!(&pairs[0].to, FlowEnd::Workload { key } if key.name == "api"));
        assert_eq!(remote_of(Some(&at("", "web")), Some("east")), None);
        assert_eq!(remote_of(Some(&at("west", "web")), None), None);
    }

    #[derive(Debug)]
    struct Wrapped(&'static str, Box<dyn std::error::Error + Send + Sync>);

    impl std::fmt::Display for Wrapped {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.0)
        }
    }

    impl std::error::Error for Wrapped {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            Some(self.1.as_ref())
        }
    }

    fn buried(tls: rustls::Error) -> Wrapped {
        Wrapped(
            "transport error",
            Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, tls)),
        )
    }

    /// A certificate the CA does not vouch for is said with the verifier's
    /// words, however deep the transport buried it.
    #[test]
    fn a_certificate_that_does_not_verify_is_said_with_the_verifiers_words() {
        let unknown = buried(rustls::Error::InvalidCertificate(
            rustls::CertificateError::UnknownIssuer,
        ));
        match ended_by(&unknown, "kube-system") {
            LiveEnd::NotVerified { namespace, said } => {
                assert_eq!(namespace, "kube-system");
                assert!(said.contains("UnknownIssuer"), "{said}");
            }
            other => panic!("{other:?}"),
        }
    }

    /// A relay that answers our handshake by asking for a certificate is
    /// mutual TLS, whatever its config said or did not say.
    #[test]
    fn a_relay_asking_for_our_certificate_in_the_handshake_is_mutual_tls() {
        let asked = buried(rustls::Error::AlertReceived(
            rustls::AlertDescription::CertificateRequired,
        ));
        assert!(matches!(
            ended_by(&asked, "kube-system"),
            LiveEnd::MutualTls { .. }
        ));
    }

    /// Any other failure keeps every layer's words: "transport error" alone
    /// says nothing about what failed.
    #[test]
    fn any_other_failure_keeps_every_layers_words() {
        let refused = Wrapped("transport error", "connection refused".into());
        assert_eq!(
            ended_by(&refused, "kube-system"),
            LiveEnd::Failed {
                said: "transport error: connection refused".into()
            }
        );
    }

    /// A scope is a source-or-destination filter per namespace; no scope
    /// asks for every flow.
    #[test]
    fn a_scope_filters_flows_from_or_to_its_namespaces() {
        let made = filters(Some(&["shop".to_string()]));
        assert_eq!(made.len(), 2);
        assert_eq!(made[0].source_pod, vec!["shop/".to_string()]);
        assert_eq!(made[1].destination_pod, vec!["shop/".to_string()]);
        assert!(filters(None).is_empty());
    }

    fn relay_service(port: u16) -> String {
        json!({"kind": "ServiceList", "apiVersion": "v1", "metadata": {}, "items": [{
            "metadata": {"name": "hubble-relay", "namespace": "kube-system"},
            "spec": {"selector": {"k8s-app": "hubble-relay"}, "ports": [{"port": port, "targetPort": "grpc"}]}
        }]})
        .to_string()
    }

    fn relay_pods(ready: bool) -> String {
        json!({"kind": "PodList", "apiVersion": "v1", "metadata": {}, "items": [{
            "metadata": {"name": "hubble-relay-7f9", "namespace": "kube-system"},
            "spec": {"containers": [{"name": "relay", "ports": [{"name": "grpc", "containerPort": 4245}]}]},
            "status": {"conditions": [{"type": "Ready", "status": if ready { "True" } else { "False" }}]}
        }]})
        .to_string()
    }

    fn config(serving: Serving) -> String {
        let text = match serving {
            Serving::Plain => "disable-server-tls: true",
            Serving::Tls => "tls-relay-server-cert-file: /var/lib/hubble-relay/tls/server.crt",
            Serving::MutualTls => {
                "tls-relay-server-cert-file: /x\ntls-relay-client-ca-files: /var/lib/hubble-relay/tls/hubble-server-ca.crt"
            }
        };
        json!({"kind": "ConfigMap", "apiVersion": "v1", "metadata": {"name": CONFIG}, "data": {"config.yaml": text}})
            .to_string()
    }

    /// The chart's server Secret; `ca.crt` is "CA", the rest is never read.
    fn certs(with_ca: bool) -> String {
        let mut data = json!({"tls.crt": "Q1JU"});
        if with_ca {
            data["ca.crt"] = json!("Q0E=");
        }
        json!({"kind": "Secret", "apiVersion": "v1", "metadata": {"name": SERVER_CERTS}, "data": data})
            .to_string()
    }

    async fn found(
        answer: impl Fn(&str) -> (u16, String) + Send + Sync + 'static,
    ) -> std::result::Result<Found, LiveEnd> {
        let (client, _) = answering(move |path, _| answer(path)).await;
        find(&client).await
    }

    const SERVICES: &str = "/api/v1/services";
    const CONFIG_AT: &str = "/api/v1/namespaces/kube-system/configmaps/hubble-relay-config";
    const CERTS_AT: &str = "/api/v1/namespaces/kube-system/secrets/hubble-relay-server-certs";
    const PODS_AT: &str = "/api/v1/namespaces/kube-system/pods";

    /// Services that could not be listed are "could not look", never "not
    /// enabled"; none listed is "not enabled".
    #[tokio::test]
    async fn a_refused_list_is_not_looked_and_an_empty_one_is_not_enabled() {
        let refused = found(|_| failure(403, "Forbidden")).await;
        assert!(matches!(refused, Err(LiveEnd::NotLooked { .. })));
        let none = found(|path| {
            if path == SERVICES {
                (
                    200,
                    json!({"kind": "ServiceList", "apiVersion": "v1", "metadata": {}, "items": []})
                        .to_string(),
                )
            } else {
                failure(404, "NotFound")
            }
        })
        .await;
        assert!(matches!(none, Err(LiveEnd::NotEnabled)));
    }

    /// A TLS relay is read against its own CA, found by its config or,
    /// where that is unread, by the chart's port; the CA is all that is
    /// taken, and a CA that could not be read, or is not there, is said.
    #[tokio::test]
    async fn a_tls_relay_is_read_against_its_ca_and_a_missing_ca_is_said() {
        let tls = |port: u16, config_ok: bool, secret: (u16, String)| {
            move |path: &str| match path {
                SERVICES => (200, relay_service(port)),
                CONFIG_AT if config_ok => (200, config(Serving::Tls)),
                CONFIG_AT => failure(403, "Forbidden"),
                CERTS_AT => secret.clone(),
                PODS_AT => (200, relay_pods(true)),
                _ => failure(404, "NotFound"),
            }
        };
        let read = found(tls(80, true, (200, certs(true))))
            .await
            .expect("read over TLS");
        assert_eq!(read.ca.as_deref(), Some(b"CA".as_slice()));
        assert!(read.at.tls);
        let by_port = found(tls(443, false, (200, certs(true))))
            .await
            .expect("by port");
        assert!(by_port.at.tls);
        let refused = found(tls(80, true, failure(403, "Forbidden"))).await;
        assert!(matches!(refused, Err(LiveEnd::CaUnread { .. })));
        let missing = found(tls(80, true, (200, certs(false)))).await;
        assert!(matches!(missing, Err(LiveEnd::NoCa { .. })));
    }

    /// A relay that asks every client for a certificate is said as that, not
    /// read and not failed.
    #[tokio::test]
    async fn a_relay_asking_for_a_client_certificate_is_said() {
        let mutual = found(|path| match path {
            SERVICES => (200, relay_service(443)),
            CONFIG_AT => (200, config(Serving::MutualTls)),
            _ => failure(404, "NotFound"),
        })
        .await;
        assert!(matches!(mutual, Err(LiveEnd::MutualTls { .. })));
    }

    /// A plaintext relay is read through a ready pod on the port its named
    /// target resolves to; with none ready, that is what is said.
    #[tokio::test]
    async fn a_plaintext_relay_is_read_through_a_ready_pod_on_its_target_port() {
        let answer = |ready: bool| {
            move |path: &str| match path {
                SERVICES => (200, relay_service(80)),
                CONFIG_AT => (200, config(Serving::Plain)),
                PODS_AT => (200, relay_pods(ready)),
                _ => failure(404, "NotFound"),
            }
        };
        let relay = found(answer(true)).await.expect("a relay");
        assert_eq!(relay.at.pod, "hubble-relay-7f9");
        assert_eq!(relay.remote, 4245);
        assert!(!relay.at.tls && relay.ca.is_none());
        assert!(matches!(
            found(answer(false)).await,
            Err(LiveEnd::NoPod { .. })
        ));
    }

    /// A relay that stops answering without closing, as a port-forward does
    /// when the laptop sleeps, ends the call instead of leaving it to wait
    /// forever while the page empties into "saw no flows".
    #[tokio::test]
    async fn a_relay_gone_silent_ends_the_call_instead_of_hanging_it() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("a port");
        let at = listener.local_addr().expect("its address");
        let held = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.expect("a connection");
            tokio::time::sleep(Duration::from_secs(60)).await;
            drop(socket);
        });
        let connector = tower::service_fn(move |_: http::Uri| async move {
            tokio::net::TcpStream::connect(at).await.map(TokioIo::new)
        });
        let channel = kept_alive(
            tonic::transport::Endpoint::from_static("http://hubble-relay"),
            Duration::from_millis(200),
        )
        .connect_with_connector(connector)
        .await
        .expect("connected");
        let mut observer = ObserverClient::new(channel);
        let call = observer.get_flows(proto::observer::GetFlowsRequest {
            follow: true,
            ..Default::default()
        });
        let answered = tokio::time::timeout(Duration::from_secs(10), call).await;
        assert!(answered.is_ok_and(|call| call.is_err()), "the call hung");
        held.abort();
    }
}
