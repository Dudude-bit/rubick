//! Which pod a forward's bytes go to, and what happens when that pod goes.
//!
//! A forward is pinned to one pod name, and a rollout replaces every pod
//! under a new one. Left alone, the forward kept listening and answered
//! nothing: green in the Activity panel, a hung `curl` on the port. So the
//! pod is looked at while the forward runs, and when it leaves the forward
//! moves to a ready pod of whatever it came from, or ends and says why.

use std::sync::Arc;
use std::time::{Duration, Instant};

use dashmap::DashMap;
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, ReplicaSet};
use k8s_openapi::api::batch::v1::Job;
use k8s_openapi::api::core::v1::{Pod, Service};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::{LabelSelector, OwnerReference};
use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
use kube::api::{Api, ListParams};
use kube::ResourceExt;
use tokio::sync::{watch, Notify};

use crate::client::K8sClientManager;
use crate::error::Error;
use crate::resources::Selector;
use crate::state::PortForwardSession;

use super::types::{ForwardNote, ForwardVia, Reporter};

/// Where a forward's bytes go right now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Target {
    pub pod: String,
    pub remote_port: u16,
}

/// The client to forward through, looked up fresh.
///
/// Not the client the session started with. A `kube::Client` carries the
/// credentials it was built with, and a GKE token lasts about an hour. Asked
/// for per attempt, a reconnect or `auth::renew` heals the forward instead of
/// leaving it to retry a dead credential.
pub(super) fn current_client(
    manager: &K8sClientManager,
    context: &str,
) -> std::result::Result<kube::Client, Error> {
    manager
        .get_client(context)
        .map(|client| (*client).clone())
        .ok_or_else(|| Error::NotConnected(context.to_string()))
}

fn controller(owners: &[OwnerReference]) -> Option<&OwnerReference> {
    owners.iter().find(|owner| owner.controller == Some(true))
}

/// What puts this pod back when it goes: the top of its controller chain.
///
/// A pod a `ReplicaSet` owns is followed through the Deployment above it,
/// because a restart replaces the `ReplicaSet` too. Any other controller is
/// named as it is: an operator's pod comes back under its own name, and is
/// waited for. Only a pod nothing owns, or an unreadable one, is on its own.
pub(super) async fn owner_of(client: &kube::Client, namespace: &str, pod: &str) -> ForwardVia {
    let Ok(found) = Api::<Pod>::namespaced(client.clone(), namespace)
        .get(pod)
        .await
    else {
        return ForwardVia::Pod;
    };
    let Some(owner) = controller(found.owner_references()) else {
        return ForwardVia::Pod;
    };
    if owner.kind == "ReplicaSet" {
        if let Ok(set) = Api::<ReplicaSet>::namespaced(client.clone(), namespace)
            .get(&owner.name)
            .await
        {
            if let Some(top) =
                controller(set.owner_references()).filter(|top| top.kind == "Deployment")
            {
                return ForwardVia::Owner {
                    owner_kind: top.kind.clone(),
                    name: top.name.clone(),
                };
            }
        }
    }
    ForwardVia::Owner {
        owner_kind: owner.kind.clone(),
        name: owner.name.clone(),
    }
}

/// Deleted, or finished: either way it will not answer much longer.
fn leaving(pod: &Pod) -> bool {
    pod.metadata.deletion_timestamp.is_some()
        || matches!(
            pod.status
                .as_ref()
                .and_then(|status| status.phase.as_deref()),
            Some("Succeeded" | "Failed")
        )
}

fn ready(pod: &Pod) -> bool {
    !leaving(pod)
        && pod
            .status
            .as_ref()
            .and_then(|status| status.conditions.as_ref())
            .is_some_and(|conditions| {
                conditions
                    .iter()
                    .any(|condition| condition.type_ == "Ready" && condition.status == "True")
            })
}

/// A container of its own is running. `Ready` is a whole-pod verdict, and a
/// pod whose sidecar cannot pull its image still serves from the one that is
/// up; `kubectl port-forward svc/...` takes such a pod too. A crash-looping
/// container is waiting, and init containers are listed elsewhere.
fn up(pod: &Pod) -> bool {
    !leaving(pod)
        && pod
            .status
            .as_ref()
            .and_then(|status| status.container_statuses.as_ref())
            .is_some_and(|containers| {
                containers.iter().any(|container| {
                    container
                        .state
                        .as_ref()
                        .is_some_and(|state| state.running.is_some())
                })
            })
}

/// The pod a forward is leaving. The default is no pod at all: a start.
#[derive(Default)]
pub(super) struct Left<'a> {
    pub pod: &'a str,
    /// Where it was last seen running.
    pub node: Option<&'a str>,
    /// Still answering, so only a ready pod is worth leaving it for.
    pub serving: bool,
}

/// Pods the selector matches, other than the one left: ready ones first, then,
/// where nothing is serving, ones merely up. Newest first within each, so a
/// rollout lands the forward on its own new pods.
fn candidates<'a>(pods: &'a [Pod], selector: Selector<'_>, left: &Left<'_>) -> Vec<&'a Pod> {
    let mut found: Vec<&Pod> = pods
        .iter()
        .filter(|pod| {
            pod.name_any() != left.pod
                && (ready(pod) || !left.serving && up(pod))
                && selector.matches(pod.labels()) == Some(true)
        })
        .collect();
    found.sort_by(|a, b| {
        ready(b)
            .cmp(&ready(a))
            .then_with(|| b.creation_timestamp().cmp(&a.creation_timestamp()))
            .then_with(|| a.name_any().cmp(&b.name_any()))
    });
    found
}

/// The pod-side port a Service port lands on in this pod, resolved the way
/// kube-proxy resolves it: `targetPort` by number, by the container port's
/// name, or the Service port itself where none is set.
pub(super) fn pod_port(service: &Service, port: u16, pod: &Pod) -> Option<u16> {
    let entry = service
        .spec
        .as_ref()?
        .ports
        .as_ref()?
        .iter()
        .find(|entry| entry.port == i32::from(port))?;
    match &entry.target_port {
        None => Some(port),
        Some(IntOrString::Int(number)) => u16::try_from(*number).ok(),
        Some(IntOrString::String(name)) => {
            let spec = pod.spec.as_ref()?;
            spec.containers
                .iter()
                .chain(spec.init_containers.iter().flatten())
                .flat_map(|container| container.ports.iter().flatten())
                .find(|declared| declared.name.as_deref() == Some(name.as_str()))
                .and_then(|declared| u16::try_from(declared.container_port).ok())
        }
    }
}

fn list_params(labels: Option<&std::collections::BTreeMap<String, String>>) -> ListParams {
    let narrowed = labels.filter(|labels| !labels.is_empty()).map(|labels| {
        labels
            .iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect::<Vec<_>>()
            .join(",")
    });
    match narrowed {
        Some(selector) => ListParams::default().labels(&selector),
        None => ListParams::default(),
    }
}

/// The selector of an owner whose pods stand in for one another.
///
/// `None` for every other kind, a `StatefulSet` among them: its pods are not
/// interchangeable (`pg-1` is a different database from `pg-0`), and the one
/// that went comes back under its own name.
async fn owner_selector(
    client: &kube::Client,
    namespace: &str,
    kind: &str,
    name: &str,
) -> std::result::Result<Option<LabelSelector>, Error> {
    let client = client.clone();
    Ok(match kind {
        "Deployment" => Api::<Deployment>::namespaced(client, namespace)
            .get(name)
            .await?
            .spec
            .map(|spec| spec.selector),
        "DaemonSet" => Api::<DaemonSet>::namespaced(client, namespace)
            .get(name)
            .await?
            .spec
            .map(|spec| spec.selector),
        "ReplicaSet" => Api::<ReplicaSet>::namespaced(client, namespace)
            .get(name)
            .await?
            .spec
            .map(|spec| spec.selector),
        "Job" => Api::<Job>::namespaced(client, namespace)
            .get(name)
            .await?
            .spec
            .and_then(|spec| spec.selector),
        _ => None,
    })
}

/// The pod `via` would send a new connection to, other than the one left.
///
/// `Ok(None)` is an answer, nothing to move to; `Err` is not having been able to
/// look, which is never reported as nothing ready.
pub(super) async fn replacement(
    client: &kube::Client,
    namespace: &str,
    via: &ForwardVia,
    left: &Left<'_>,
    remote_port: u16,
) -> std::result::Result<Option<Target>, Error> {
    let pods = Api::<Pod>::namespaced(client.clone(), namespace);
    match via {
        ForwardVia::Pod => Ok(None),
        ForwardVia::Owner { owner_kind, name } => {
            let Some(selector) = owner_selector(client, namespace, owner_kind, name).await? else {
                return Ok(None);
            };
            let listed = pods
                .list(&list_params(selector.match_labels.as_ref()))
                .await?;
            // A DaemonSet's pod is its node's: the one on another node is a
            // different agent, and a node not known is not any node.
            let here = |pod: &&Pod| {
                owner_kind != "DaemonSet"
                    || left.node.is_some()
                        && pod.spec.as_ref().and_then(|spec| spec.node_name.as_deref()) == left.node
            };
            Ok(
                candidates(&listed.items, Selector::Query(Some(&selector)), left)
                    .into_iter()
                    .find(here)
                    .map(|pod| Target {
                        pod: pod.name_any(),
                        remote_port,
                    }),
            )
        }
        ForwardVia::Service { name, port } => {
            let service = Api::<Service>::namespaced(client.clone(), namespace)
                .get(name)
                .await?;
            let Some(selector) = service
                .spec
                .as_ref()
                .and_then(|spec| spec.selector.as_ref())
                .filter(|selector| !selector.is_empty())
            else {
                return Ok(None);
            };
            let listed = pods.list(&list_params(Some(selector))).await?;
            Ok(
                candidates(&listed.items, Selector::Equality(selector), left)
                    .into_iter()
                    .find_map(|pod| {
                        pod_port(&service, *port, pod).map(|remote_port| Target {
                            pod: pod.name_any(),
                            remote_port,
                        })
                    }),
            )
        }
    }
}

/// The pod as the last look found it.
#[derive(Debug, PartialEq, Eq)]
enum PodNow {
    Serving,
    /// There, and nothing of its own running yet.
    Starting,
    Leaving,
    Gone,
    /// Not asked, or the asking failed: never read as gone.
    Unknown,
}

/// The pod now, and the node it is on where the look could tell.
async fn pod_now(
    clients: &K8sClientManager,
    context: &str,
    namespace: &str,
    pod: &str,
) -> (PodNow, Option<String>) {
    let Ok(client) = current_client(clients, context) else {
        return (PodNow::Unknown, None);
    };
    let found = match Api::<Pod>::namespaced(client, namespace).get_opt(pod).await {
        Ok(None) => return (PodNow::Gone, None),
        Ok(Some(found)) => found,
        Err(_) => return (PodNow::Unknown, None),
    };
    let now = if leaving(&found) {
        PodNow::Leaving
    } else if ready(&found) || up(&found) {
        PodNow::Serving
    } else {
        PodNow::Starting
    };
    (now, found.spec.and_then(|spec| spec.node_name))
}

/// What one forward follows, and how long it waits for a replacement.
pub(super) struct Follow {
    pub clients: Arc<K8sClientManager>,
    pub context: String,
    pub namespace: String,
    pub via: ForwardVia,
    pub auto_reconnect: bool,
    /// How often the pod is looked at when nothing prompts a look sooner.
    pub every: Duration,
    /// How long a gone pod's owner gets to put a ready one up.
    pub patience: Duration,
}

/// Watches the forward's pod and moves the forward when it goes.
///
/// Returns only when the forward has to end, with the reason: the pod is gone
/// and nothing names another, reconnecting is off, or no ready pod came within
/// `patience`. A connection that found the pod gone prompts a look at once
/// through `suspect` rather than waiting out `every`.
pub(super) async fn follow(
    spec: &Follow,
    report: &Reporter,
    sessions: &DashMap<String, PortForwardSession>,
    target: &watch::Sender<Target>,
    suspect: &Notify,
) -> ForwardNote {
    let mut gone_since: Option<Instant> = None;
    let mut node: Option<String> = None;
    loop {
        tokio::select! {
            () = tokio::time::sleep(spec.every) => {}
            () = suspect.notified() => {}
        }
        let current = target.borrow().clone();
        let (now, seen_on) =
            pod_now(&spec.clients, &spec.context, &spec.namespace, &current.pod).await;
        node = seen_on.or(node);
        match now {
            // Back under its own name: the wait that was announced is over,
            // and nothing else would take "reconnecting" off the row.
            PodNow::Serving => {
                if gone_since.take().is_some() {
                    report.say(&current.pod, current.remote_port, "reconnected", None, None);
                }
                continue;
            }
            PodNow::Unknown => continue,
            PodNow::Starting if gone_since.is_none() => continue,
            PodNow::Starting | PodNow::Leaving | PodNow::Gone => {}
        }
        let gone = now != PodNow::Leaving;
        let Some((kind, name)) = spec.via.names().filter(|_| spec.auto_reconnect) else {
            if gone {
                return ForwardNote::PodGone { pod: current.pod };
            }
            continue;
        };

        let found = match current_client(&spec.clients, &spec.context) {
            Ok(client) => {
                replacement(
                    &client,
                    &spec.namespace,
                    &spec.via,
                    &Left {
                        pod: &current.pod,
                        node: node.as_deref(),
                        serving: !gone,
                    },
                    current.remote_port,
                )
                .await
            }
            Err(err) => Err(err),
        };
        match found {
            Ok(Some(next)) => {
                if let Some(mut session) = sessions.get_mut(&report.id) {
                    session.pod.clone_from(&next.pod);
                    session.remote_port = next.remote_port;
                }
                target.send_replace(next.clone());
                report.say(
                    &next.pod,
                    next.remote_port,
                    "moved",
                    Some(ForwardNote::Moved { from: current.pod }),
                    None,
                );
                gone_since = None;
            }
            // Still answering on its way out: it serves until a ready pod is there.
            _ if !gone => {}
            found => {
                let since = gone_since.get_or_insert_with(|| {
                    report.say(
                        &current.pod,
                        current.remote_port,
                        "reconnecting",
                        Some(ForwardNote::Waiting {
                            pod: current.pod.clone(),
                            kind: kind.to_string(),
                            name: name.to_string(),
                        }),
                        None,
                    );
                    Instant::now()
                });
                // Back under its name: its owner has put it up, and how long
                // it takes to start is not what the patience is for.
                if now == PodNow::Starting {
                    *since = Instant::now();
                }
                if since.elapsed() >= spec.patience {
                    return match found {
                        Err(err) => ForwardNote::SearchFailed {
                            pod: current.pod,
                            text: err.to_string(),
                        },
                        Ok(_) => ForwardNote::NoReplacement {
                            pod: current.pod,
                            kind: kind.to_string(),
                            name: name.to_string(),
                        },
                    };
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::served::test_server::{connected, failure, server};
    use crate::client::served::ServedIndex;
    use crate::state::AppEvent;
    use serde_json::{json, Value};

    fn pod(name: &str, created: &str, ready: bool, labels: Value) -> Value {
        json!({
            "metadata": {
                "name": name, "namespace": "shop", "labels": labels,
                "creationTimestamp": created,
            },
            "spec": { "containers": [{ "name": "app", "ports": [
                { "name": "http", "containerPort": 8080 }
            ] }] },
            "status": { "phase": "Running", "conditions": [
                { "type": "Ready", "status": if ready { "True" } else { "False" } }
            ] },
        })
    }

    fn listing(items: &[Value]) -> String {
        json!({ "apiVersion": "v1", "kind": "PodList", "metadata": {}, "items": items }).to_string()
    }

    fn deployment() -> String {
        json!({
            "apiVersion": "apps/v1", "kind": "Deployment",
            "metadata": { "name": "api", "namespace": "shop" },
            "spec": {
                "selector": { "matchLabels": { "app": "api" } },
                "template": { "metadata": { "labels": { "app": "api" } }, "spec": { "containers": [] } },
            },
        })
        .to_string()
    }

    fn api() -> Value {
        json!({ "app": "api" })
    }

    /// A rollout's new pods are the newest; one not ready yet, one on its
    /// way out and the pod being left are never chosen.
    #[test]
    fn the_newest_ready_pod_is_chosen() {
        let mut leaving_one: Pod =
            serde_json::from_value(pod("api-3", "2026-10-04T00:03:00Z", true, api())).unwrap();
        leaving_one.metadata.deletion_timestamp = leaving_one.metadata.creation_timestamp.clone();
        let pods: Vec<Pod> = [
            pod("api-0", "2026-10-04T00:00:00Z", true, api()),
            pod("api-1", "2026-10-04T00:01:00Z", true, api()),
            pod("api-2", "2026-10-04T00:02:00Z", false, api()),
            pod(
                "api-4",
                "2026-10-04T00:04:00Z",
                true,
                json!({ "app": "web" }),
            ),
        ]
        .into_iter()
        .map(|value| serde_json::from_value(value).unwrap())
        .chain([leaving_one])
        .collect();
        let labels = std::collections::BTreeMap::from([("app".to_string(), "api".to_string())]);
        let chosen: Vec<String> = candidates(
            &pods,
            Selector::Equality(&labels),
            &Left {
                pod: "api-0",
                node: None,
                serving: true,
            },
        )
        .iter()
        .map(|pod| pod.name_any())
        .collect();
        assert_eq!(chosen, ["api-1"]);
    }

    /// `kubectl port-forward svc/x 80` lands on the container port the
    /// Service's targetPort names, not on 80.
    #[test]
    fn a_service_port_lands_on_the_target_port_its_pod_declares() {
        let service: Service = serde_json::from_value(json!({
            "metadata": { "name": "api" },
            "spec": { "ports": [
                { "port": 80, "targetPort": "http" },
                { "port": 9090, "targetPort": 9091 },
                { "port": 7000 },
            ] },
        }))
        .unwrap();
        let pod: Pod =
            serde_json::from_value(pod("api-0", "2026-10-04T00:00:00Z", true, api())).unwrap();
        assert_eq!(pod_port(&service, 80, &pod), Some(8080));
        assert_eq!(pod_port(&service, 9090, &pod), Some(9091));
        assert_eq!(pod_port(&service, 7000, &pod), Some(7000));
        assert_eq!(pod_port(&service, 443, &pod), None);
    }

    /// A pod a `ReplicaSet` owns is followed through its Deployment: a restart
    /// replaces the `ReplicaSet` too, and following that would find nothing.
    #[tokio::test]
    async fn a_deployment_pod_is_followed_through_the_deployment() {
        let owned = json!({
            "metadata": { "name": "api-7f9-x", "namespace": "shop", "ownerReferences": [
                { "apiVersion": "apps/v1", "kind": "ReplicaSet", "name": "api-7f9", "uid": "r", "controller": true }
            ] },
        });
        let set = json!({
            "metadata": { "name": "api-7f9", "namespace": "shop", "ownerReferences": [
                { "apiVersion": "apps/v1", "kind": "Deployment", "name": "api", "uid": "d", "controller": true }
            ] },
        });
        let (client, _) = server(vec![
            (
                "/api/v1/namespaces/shop/pods/api-7f9-x",
                200,
                owned.to_string(),
            ),
            (
                "/apis/apps/v1/namespaces/shop/replicasets/api-7f9",
                200,
                set.to_string(),
            ),
            (
                "/api/v1/namespaces/shop/pods/bare",
                200,
                json!({ "metadata": { "name": "bare" } }).to_string(),
            ),
            (
                "/api/v1/namespaces/shop/pods/pg-1",
                200,
                json!({ "metadata": { "name": "pg-1", "ownerReferences": [
                    { "apiVersion": "postgresql.cnpg.io/v1", "kind": "Cluster", "name": "pg", "uid": "c", "controller": true }
                ] } })
                .to_string(),
            ),
        ])
        .await;
        assert_eq!(
            owner_of(&client, "shop", "api-7f9-x").await,
            ForwardVia::Owner {
                owner_kind: "Deployment".into(),
                name: "api".into()
            }
        );
        assert_eq!(owner_of(&client, "shop", "bare").await, ForwardVia::Pod);
        assert_eq!(
            owner_of(&client, "shop", "pg-1").await,
            ForwardVia::Owner {
                owner_kind: "Cluster".into(),
                name: "pg".into()
            },
            "an operator puts its pod back, so the forward waits for it"
        );
    }

    /// Not being allowed to look is not "nothing ready": the answer is an error.
    #[tokio::test]
    async fn a_refused_owner_is_an_error_not_an_empty_answer() {
        let (code, body) = failure(403, "Forbidden");
        let (client, _) = server(vec![(
            "/apis/apps/v1/namespaces/shop/deployments/api",
            code,
            body,
        )])
        .await;
        let via = ForwardVia::Owner {
            owner_kind: "Deployment".into(),
            name: "api".into(),
        };
        assert!(replacement(
            &client,
            "shop",
            &via,
            &Left {
                pod: "api-0",
                node: None,
                serving: false
            },
            8080
        )
        .await
        .is_err());
    }

    /// A forward to a Service starts on a ready pod behind it, on the port
    /// its targetPort names there; with nothing ready the answer is nothing,
    /// not an error.
    #[tokio::test]
    async fn a_service_forward_lands_on_a_ready_pod_and_its_target_port() {
        let service = json!({
            "metadata": { "name": "api", "namespace": "shop" },
            "spec": { "selector": { "app": "api" }, "ports": [{ "port": 80, "targetPort": "http" }] },
        });
        let via = ForwardVia::Service {
            name: "api".into(),
            port: 80,
        };
        let (client, _) = server(vec![
            (
                "/api/v1/namespaces/shop/services/api",
                200,
                service.to_string(),
            ),
            (
                "/api/v1/namespaces/shop/pods",
                200,
                listing(&[
                    pod("api-0", "2026-10-04T00:00:00Z", false, api()),
                    pod("api-1", "2026-10-04T00:01:00Z", true, api()),
                ]),
            ),
        ])
        .await;
        assert_eq!(
            replacement(&client, "shop", &via, &Left::default(), 80)
                .await
                .unwrap(),
            Some(Target {
                pod: "api-1".into(),
                remote_port: 8080
            })
        );

        let (client, _) = server(vec![
            (
                "/api/v1/namespaces/shop/services/api",
                200,
                service.to_string(),
            ),
            ("/api/v1/namespaces/shop/pods", 200, listing(&[])),
        ])
        .await;
        assert_eq!(
            replacement(&client, "shop", &via, &Left::default(), 80)
                .await
                .unwrap(),
            None
        );
    }

    /// The pod with its own container running, whatever `Ready` says.
    fn running(mut pod: Value) -> Value {
        pod["status"]["containerStatuses"] = json!([{ "name": "app", "state": { "running": {} } }]);
        pod
    }

    fn service() -> String {
        json!({
            "metadata": { "name": "api", "namespace": "shop" },
            "spec": { "selector": { "app": "api" }, "ports": [{ "port": 80, "targetPort": "http" }] },
        })
        .to_string()
    }

    fn service_via() -> ForwardVia {
        ForwardVia::Service {
            name: "api".into(),
            port: 80,
        }
    }

    async fn behind_the_service(pods: &[Value]) -> Option<Target> {
        let (client, _) = server(vec![
            ("/api/v1/namespaces/shop/services/api", 200, service()),
            ("/api/v1/namespaces/shop/pods", 200, listing(pods)),
        ])
        .await;
        replacement(&client, "shop", &service_via(), &Left::default(), 80)
            .await
            .unwrap()
    }

    /// A pod whose sidecar is broken is not Ready and still serves from its
    /// own container: a Service with nothing ready forwards there instead of
    /// refusing. A ready pod wins over it, and a pod with nothing running,
    /// crash-looping or still in its init containers, is never settled for.
    #[tokio::test]
    async fn a_service_forward_settles_for_a_pod_whose_own_container_runs() {
        let mut crashing = pod("api-2", "2026-10-04T00:02:00Z", false, api());
        crashing["status"]["containerStatuses"] = json!([
            { "name": "app", "state": { "waiting": { "reason": "CrashLoopBackOff" } } }
        ]);
        let mut initialising = pod("api-3", "2026-10-04T00:03:00Z", false, api());
        initialising["status"]["initContainerStatuses"] =
            json!([{ "name": "init", "state": { "running": {} } }]);
        let sidecar_broken = running(pod("api-1", "2026-10-04T00:01:00Z", false, api()));

        let settled = behind_the_service(&[
            sidecar_broken.clone(),
            crashing.clone(),
            initialising.clone(),
        ])
        .await;
        assert_eq!(settled.map(|target| target.pod), Some("api-1".into()));

        let ready = pod("api-0", "2026-10-04T00:00:00Z", true, api());
        let preferred = behind_the_service(&[sidecar_broken, ready]).await;
        assert_eq!(preferred.map(|target| target.pod), Some("api-0".into()));

        assert_eq!(behind_the_service(&[crashing, initialising]).await, None);
    }

    struct Followed {
        target: watch::Receiver<Target>,
        events: tokio::sync::broadcast::Receiver<AppEvent>,
        sessions: Arc<DashMap<String, PortForwardSession>>,
        ended: tokio::task::JoinHandle<ForwardNote>,
    }

    async fn following(
        via: ForwardVia,
        auto_reconnect: bool,
        answer: impl Fn(&str, usize) -> (u16, String) + Send + Sync + 'static,
    ) -> Followed {
        let (state, _) = connected(ServedIndex::default(), answer).await;
        let events = state.event_tx.subscribe();
        let sessions = state.port_forward_sessions.clone();
        sessions.insert(
            "pf-1".into(),
            PortForwardSession {
                id: "pf-1".into(),
                context: "fake".into(),
                pod: "api-0".into(),
                namespace: "shop".into(),
                local_port: 18951,
                remote_port: 8080,
                auto_reconnect,
                created_at: chrono::Utc::now(),
                via: via.clone(),
            },
        );
        let (target_tx, target) = watch::channel(Target {
            pod: "api-0".into(),
            remote_port: 8080,
        });
        let spec = Follow {
            clients: state.client_manager.clone(),
            context: "fake".into(),
            namespace: "shop".into(),
            via,
            auto_reconnect,
            every: Duration::from_millis(20),
            patience: Duration::from_millis(300),
        };
        let report = Reporter {
            event_tx: state.event_tx.clone(),
            id: "pf-1".into(),
            namespace: "shop".into(),
            local_port: 18951,
        };
        let held = sessions.clone();
        let ended = tokio::spawn(async move {
            let _state = state;
            follow(&spec, &report, &held, &target_tx, &Notify::new()).await
        });
        Followed {
            target,
            events,
            sessions,
            ended,
        }
    }

    fn deployment_via() -> ForwardVia {
        ForwardVia::Owner {
            owner_kind: "Deployment".into(),
            name: "api".into(),
        }
    }

    /// After a restart the forward moves to the new pod, says so, and the
    /// row the Activity panel lists names the new pod.
    #[tokio::test]
    async fn a_forward_moves_to_a_ready_pod_of_its_deployment() {
        let mut followed = following(deployment_via(), true, |path, _| match path {
            "/apis/apps/v1/namespaces/shop/deployments/api" => (200, deployment()),
            "/api/v1/namespaces/shop/pods" => (
                200,
                listing(&[pod("api-new", "2026-10-04T00:05:00Z", true, api())]),
            ),
            _ => failure(404, "NotFound"),
        })
        .await;

        let event = tokio::time::timeout(Duration::from_secs(5), followed.events.recv())
            .await
            .unwrap()
            .unwrap();
        let AppEvent::PortForwardStatus {
            status, pod, note, ..
        } = event
        else {
            panic!("a port-forward status");
        };
        assert_eq!(status, "moved");
        assert_eq!(pod, "api-new");
        assert_eq!(
            note,
            Some(ForwardNote::Moved {
                from: "api-0".into()
            })
        );
        assert_eq!(followed.target.borrow().pod, "api-new");
        assert_eq!(followed.sessions.get("pf-1").unwrap().pod, "api-new");
        assert!(
            !followed.ended.is_finished(),
            "a moved forward keeps running"
        );
        followed.ended.abort();
    }

    /// Reconnect off means the pod going is the end, even with a replacement.
    #[tokio::test]
    async fn a_forward_told_not_to_reconnect_ends_when_its_pod_goes() {
        let followed = following(deployment_via(), false, |path, _| match path {
            "/apis/apps/v1/namespaces/shop/deployments/api" => (200, deployment()),
            "/api/v1/namespaces/shop/pods" => (
                200,
                listing(&[pod("api-new", "2026-10-04T00:05:00Z", true, api())]),
            ),
            _ => failure(404, "NotFound"),
        })
        .await;
        let note = tokio::time::timeout(Duration::from_secs(5), followed.ended)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            note,
            ForwardNote::PodGone {
                pod: "api-0".into()
            }
        );
    }

    /// A Deployment with no ready pod is waited for, said as waiting, and
    /// then the forward ends naming who had nothing ready.
    #[tokio::test]
    async fn a_forward_with_no_replacement_waits_then_ends() {
        let mut followed = following(deployment_via(), true, |path, _| match path {
            "/apis/apps/v1/namespaces/shop/deployments/api" => (200, deployment()),
            "/api/v1/namespaces/shop/pods" => (
                200,
                listing(&[pod("api-new", "2026-10-04T00:05:00Z", false, api())]),
            ),
            _ => failure(404, "NotFound"),
        })
        .await;
        let AppEvent::PortForwardStatus { status, note, .. } =
            tokio::time::timeout(Duration::from_secs(5), followed.events.recv())
                .await
                .unwrap()
                .unwrap()
        else {
            panic!("a port-forward status");
        };
        assert_eq!(status, "reconnecting");
        assert!(matches!(note, Some(ForwardNote::Waiting { .. })));

        let note = tokio::time::timeout(Duration::from_secs(5), followed.ended)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            note,
            ForwardNote::NoReplacement {
                pod: "api-0".into(),
                kind: "Deployment".into(),
                name: "api".into()
            }
        );
    }

    /// A pod the forward may not read is not a pod that is gone.
    #[tokio::test]
    async fn a_pod_that_cannot_be_read_is_not_taken_for_gone() {
        let followed = following(ForwardVia::Pod, true, |path, _| match path {
            "/api/v1/namespaces/shop/pods/api-0" => failure(403, "Forbidden"),
            _ => failure(404, "NotFound"),
        })
        .await;
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert!(!followed.ended.is_finished());
        followed.ended.abort();
    }

    /// A Service forward whose pod went moves to another pod behind the
    /// Service, on the port the targetPort names in that pod.
    #[tokio::test]
    async fn a_service_forward_moves_to_another_pod_behind_its_service() {
        let mut next = pod("api-new", "2026-10-04T00:05:00Z", true, api());
        next["spec"]["containers"][0]["ports"][0]["containerPort"] = json!(9090);
        let mut followed = following(service_via(), true, move |path, _| match path {
            "/api/v1/namespaces/shop/services/api" => (200, service()),
            "/api/v1/namespaces/shop/pods" => (200, listing(std::slice::from_ref(&next))),
            _ => failure(404, "NotFound"),
        })
        .await;
        let AppEvent::PortForwardStatus { status, pod, .. } =
            tokio::time::timeout(Duration::from_secs(5), followed.events.recv())
                .await
                .unwrap()
                .unwrap()
        else {
            panic!("a port-forward status");
        };
        assert_eq!((status.as_str(), pod.as_str()), ("moved", "api-new"));
        assert_eq!(
            *followed.target.borrow(),
            Target {
                pod: "api-new".into(),
                remote_port: 9090
            }
        );
        assert_eq!(followed.sessions.get("pf-1").unwrap().remote_port, 9090);
        followed.ended.abort();
    }

    /// A terminating pod still answers, so it is left only for a ready pod:
    /// one merely up may be seconds from serving, or never.
    #[tokio::test]
    async fn a_terminating_pod_is_not_left_for_one_that_is_not_ready() {
        let mut leaving = pod("api-0", "2026-10-04T00:00:00Z", true, api());
        leaving["metadata"]["deletionTimestamp"] = json!("2026-10-04T00:06:00Z");
        let followed = following(deployment_via(), true, move |path, _| match path {
            "/api/v1/namespaces/shop/pods/api-0" => (200, leaving.to_string()),
            "/apis/apps/v1/namespaces/shop/deployments/api" => (200, deployment()),
            "/api/v1/namespaces/shop/pods" => (
                200,
                listing(&[running(pod(
                    "api-new",
                    "2026-10-04T00:05:00Z",
                    false,
                    api(),
                ))]),
            ),
            _ => failure(404, "NotFound"),
        })
        .await;
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(followed.target.borrow().pod, "api-0");
        followed.ended.abort();
    }

    fn stateful_via() -> ForwardVia {
        ForwardVia::Owner {
            owner_kind: "StatefulSet".into(),
            name: "api".into(),
        }
    }

    /// The first two looks find `api-0` deleted, the third is refused, and
    /// from then on it is `back`.
    fn restarted(back: Value) -> impl Fn(&str, usize) -> (u16, String) + Send + Sync + 'static {
        move |path, nth| match path {
            "/api/v1/namespaces/shop/pods/api-0" => match nth {
                1 | 2 => failure(404, "NotFound"),
                3 => failure(403, "Forbidden"),
                _ => (200, back.to_string()),
            },
            "/apis/apps/v1/namespaces/shop/statefulsets/api" => {
                (200, deployment().replace("Deployment", "StatefulSet"))
            }
            "/api/v1/namespaces/shop/pods" => (
                200,
                listing(&[pod("api-1", "2026-10-04T00:01:00Z", true, api())]),
            ),
            _ => failure(404, "NotFound"),
        }
    }

    /// A restarted `StatefulSet` pod returns under its own name. The row said
    /// "reconnecting" when it went and kept saying it over a working forward;
    /// a look that could not read the pod in between must not lose that.
    #[tokio::test]
    async fn a_pod_back_under_its_own_name_ends_the_wait_out_loud() {
        let back = pod("api-0", "2026-10-04T00:07:00Z", true, api());
        let mut followed = following(stateful_via(), true, restarted(back)).await;
        let mut said = Vec::new();
        for _ in 0..2 {
            let AppEvent::PortForwardStatus { status, pod, .. } =
                tokio::time::timeout(Duration::from_secs(5), followed.events.recv())
                    .await
                    .expect("a status within five seconds")
                    .unwrap()
            else {
                panic!("a port-forward status");
            };
            said.push((status, pod));
        }
        assert_eq!(
            said,
            [
                ("reconnecting".to_string(), "api-0".to_string()),
                ("reconnected".to_string(), "api-0".to_string())
            ]
        );
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert!(!followed.ended.is_finished(), "the forward goes on");
        assert_eq!(
            followed.target.borrow().pod,
            "api-0",
            "the ready sibling api-1 is another instance, not a replacement"
        );
        followed.ended.abort();
    }

    fn on_node(mut pod: Value, node: &str) -> Value {
        pod["spec"]["nodeName"] = json!(node);
        pod
    }

    async fn daemon_forward_after(others: Vec<Value>) -> Followed {
        let mut leaving = on_node(pod("api-0", "2026-10-04T00:00:00Z", true, api()), "node-a");
        leaving["metadata"]["deletionTimestamp"] = json!("2026-10-04T00:06:00Z");
        let via = ForwardVia::Owner {
            owner_kind: "DaemonSet".into(),
            name: "api".into(),
        };
        following(via, true, move |path, nth| match path {
            "/api/v1/namespaces/shop/pods/api-0" if nth == 1 => (200, leaving.to_string()),
            "/apis/apps/v1/namespaces/shop/daemonsets/api" => {
                (200, deployment().replace("Deployment", "DaemonSet"))
            }
            "/api/v1/namespaces/shop/pods" => (200, listing(&others)),
            _ => failure(404, "NotFound"),
        })
        .await
    }

    /// A `DaemonSet` forward is to one node's agent. Its pod is replaced by
    /// the new pod on that node, never by the ready pod of another node,
    /// newer though that one is.
    #[tokio::test]
    async fn a_daemonset_forward_stays_on_its_node() {
        let elsewhere = on_node(pod("api-b", "2026-10-04T00:09:00Z", true, api()), "node-b");
        let here = on_node(pod("api-a", "2026-10-04T00:08:00Z", true, api()), "node-a");

        let mut followed = daemon_forward_after(vec![elsewhere.clone(), here]).await;
        tokio::time::timeout(Duration::from_secs(5), followed.target.changed())
            .await
            .expect("a move within five seconds")
            .unwrap();
        assert_eq!(followed.target.borrow().pod, "api-a");
        followed.ended.abort();

        let followed = daemon_forward_after(vec![elsewhere]).await;
        let note = tokio::time::timeout(Duration::from_secs(5), followed.ended)
            .await
            .unwrap()
            .unwrap();
        assert!(
            matches!(note, ForwardNote::NoReplacement { .. }),
            "{note:?}"
        );
        assert_eq!(followed.target.borrow().pod, "api-0");
    }

    /// A pod object that is back with nothing running answers no connection:
    /// it is not announced as reconnected. It is not given up on either: a
    /// `StatefulSet` pod re-attaching its volume for longer than the wait
    /// ended the forward with "no ready pod" while it was coming up. Fails if
    /// the wait for a deleted pod runs out on one that is back and starting.
    #[tokio::test]
    async fn a_pod_back_with_nothing_running_is_still_waited_for() {
        let back = pod("api-0", "2026-10-04T00:07:00Z", false, api());
        let mut followed = following(stateful_via(), true, restarted(back)).await;
        tokio::time::sleep(Duration::from_millis(900)).await;
        assert!(
            !followed.ended.is_finished(),
            "three times the patience, and still waiting"
        );
        let mut statuses = Vec::new();
        while let Ok(AppEvent::PortForwardStatus { status, .. }) = followed.events.try_recv() {
            statuses.push(status);
        }
        assert_eq!(statuses, ["reconnecting"]);
        followed.ended.abort();
    }

    /// The other side of the wait above. Fails if a pod that came back and
    /// went again is waited for without end: the patience runs from when it
    /// was last there.
    #[tokio::test]
    async fn a_pod_that_came_back_and_went_again_is_given_up_on() {
        /// The last look that finds the pod; each takes 20 ms and the server's 50.
        const LAST: usize = 12;
        let back = pod("api-0", "2026-10-04T00:07:00Z", false, api()).to_string();
        let followed = following(stateful_via(), true, move |path, nth| match path {
            "/api/v1/namespaces/shop/pods/api-0" if (3..=LAST).contains(&nth) => {
                (200, back.clone())
            }
            _ => failure(404, "NotFound"),
        })
        .await;
        let started = Instant::now();
        let note = tokio::time::timeout(Duration::from_secs(5), followed.ended)
            .await
            .expect("the wait ends")
            .unwrap();
        assert!(
            matches!(note, ForwardNote::NoReplacement { .. }),
            "{note:?}"
        );
        assert!(
            started.elapsed() >= Duration::from_millis(LAST as u64 * 70 + 300 - 50),
            "the patience ran from the last look that found it, not the first"
        );
    }

    /// A pod on its way out keeps serving until a ready one is there; it is
    /// not failed for terminating.
    #[tokio::test]
    async fn a_terminating_pod_with_nothing_ready_is_kept() {
        let mut leaving = pod("api-0", "2026-10-04T00:00:00Z", true, api());
        leaving["metadata"]["deletionTimestamp"] = json!("2026-10-04T00:06:00Z");
        let followed = following(deployment_via(), true, move |path, _| match path {
            "/api/v1/namespaces/shop/pods/api-0" => (200, leaving.to_string()),
            "/apis/apps/v1/namespaces/shop/deployments/api" => (200, deployment()),
            "/api/v1/namespaces/shop/pods" => (200, listing(&[])),
            _ => failure(404, "NotFound"),
        })
        .await;
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(!followed.ended.is_finished());
        followed.ended.abort();
    }
}
