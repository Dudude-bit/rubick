//! Tauri commands for the resource-watch subsystem.
//!
//! Pattern mirrors `commands/logs.rs`: a typed `subscribe_*_watch`
//! command per resource kind returns a stream id; a generic
//! `resource_watch_subscribed` releases the deferred-start gate; a
//! generic `unsubscribe_resource_watch` cancels.
//!
//! Each typed command is ~10 lines because all the heavy lifting
//! lives in `WatchManager::subscribe` / `subscribe_cluster`.
//! Adding a new kind:
//!   1. import `K8sType` from `k8s_openapi` and `KindInfo` from
//!      `crate::resources`
//!   2. write `subscribe_<kind>_watch(...)` calling
//!      `state.watch_manager.subscribe[_cluster]::<K8sType, _, _>(...)`
//!   3. register in main.rs `invoke_handler`
//!   4. add binding to `src/ui/generated/commands.ts`
//!   5. set `watch:` field on the page's `createResourceListPage`
//!      / `createWorkloadListPage` config.

use crate::error::{Error, Result};
use crate::resources::Selector;
use crate::resources::{
    ConfigMapInfo, CronJobInfo, DaemonSetInfo, DeploymentInfo, EndpointsInfo, EventInfo,
    IngressInfo, JobInfo, NamespaceInfo, NodeInfo, PersistentVolumeClaimInfo, PersistentVolumeInfo,
    PodInfo, PodRow, SecretInfo, ServiceInfo, StatefulSetInfo, StorageClassInfo,
};
use crate::state::AppState;
use crate::watch::Narrow;
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, ReplicaSet, StatefulSet};
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{
    ConfigMap, Endpoints, Event, Namespace, Node, PersistentVolume, PersistentVolumeClaim, Pod,
    Secret, Service,
};
use k8s_openapi::api::networking::v1::Ingress;
use k8s_openapi::api::storage::v1::StorageClass;
use tauri::State;

/// The client for a watch command, or the error saying why there is none, so
/// the frontend hook reports a real failure instead of a wedged stream.
fn current_client(state: &State<'_, AppState>) -> Result<kube::Client> {
    Ok((*state.current_client()?).clone())
}

/// Macro to stamp out a typed namespace-scoped subscribe command.
/// Each `KindInfo` impl provides `From<&K>`, so the transform is
/// just `|k| Some(KindInfo::from(k))`. The macro keeps every command
/// to 6 lines and avoids 11 near-identical copies.
macro_rules! subscribe_namespaced {
    (
        $cmd_name:ident,
        $k8s_type:ty,
        $info_type:ty,
        $kind_label:literal $(,)?
    ) => {
        // `async` is load-bearing: the subscribe call spawns the watcher
        // task, and Tauri only runs async commands on its Tokio runtime.
        // A sync command lands on a plain worker thread with no reactor,
        // where `tokio::spawn` panics — and, being called across the IPC
        // FFI boundary, that panic aborts the process instead of unwinding.
        //
        // `scope` is the list command's: `None` for the whole cluster, or
        // the namespaces, several of them watched behind one barrier.
        #[tauri::command]
        pub async fn $cmd_name(
            scope: Option<Vec<String>>,
            state: State<'_, AppState>,
        ) -> Result<String> {
            let client = current_client(&state)?;
            state
                .watch_manager
                .subscribe::<$k8s_type, _, _>(client, $kind_label, scope, |o| {
                    Some(<$info_type>::from(o))
                })
        }
    };
}

/// Macro for cluster-scoped resources (no namespace argument).
macro_rules! subscribe_cluster {
    (
        $cmd_name:ident,
        $k8s_type:ty,
        $info_type:ty,
        $kind_label:literal $(,)?
    ) => {
        // Async for the same reason as `subscribe_namespaced!`.
        #[tauri::command]
        pub async fn $cmd_name(state: State<'_, AppState>) -> Result<String> {
            let client = current_client(&state)?;
            Ok(state
                .watch_manager
                .subscribe_cluster::<$k8s_type, _, _>(client, $kind_label, |o| {
                    Some(<$info_type>::from(o))
                }))
        }
    };
}

// ----- Namespace-scoped -----

subscribe_namespaced!(
    subscribe_configmap_watch,
    ConfigMap,
    ConfigMapInfo,
    "ConfigMap"
);
subscribe_namespaced!(subscribe_secret_watch, Secret, SecretInfo, "Secret");
subscribe_namespaced!(subscribe_service_watch, Service, ServiceInfo, "Service");
subscribe_namespaced!(
    subscribe_endpoints_watch,
    Endpoints,
    EndpointsInfo,
    "Endpoints"
);
subscribe_namespaced!(subscribe_ingress_watch, Ingress, IngressInfo, "Ingress");
subscribe_namespaced!(
    subscribe_pvc_watch,
    PersistentVolumeClaim,
    PersistentVolumeClaimInfo,
    "PersistentVolumeClaim"
);
subscribe_namespaced!(subscribe_pod_row_watch, Pod, PodRow, "Pod");
subscribe_namespaced!(
    subscribe_deployment_watch,
    Deployment,
    DeploymentInfo,
    "Deployment"
);
subscribe_namespaced!(
    subscribe_statefulset_watch,
    StatefulSet,
    StatefulSetInfo,
    "StatefulSet"
);
subscribe_namespaced!(
    subscribe_daemonset_watch,
    DaemonSet,
    DaemonSetInfo,
    "DaemonSet"
);
subscribe_namespaced!(subscribe_job_watch, Job, JobInfo, "Job");
subscribe_namespaced!(subscribe_cronjob_watch, CronJob, CronJobInfo, "CronJob");
subscribe_namespaced!(subscribe_event_watch, Event, EventInfo, "Event");

// ----- Cluster-scoped -----

subscribe_cluster!(
    subscribe_namespace_watch,
    Namespace,
    NamespaceInfo,
    "Namespace"
);
subscribe_cluster!(subscribe_node_watch, Node, NodeInfo, "Node");
subscribe_cluster!(
    subscribe_persistentvolume_watch,
    PersistentVolume,
    PersistentVolumeInfo,
    "PersistentVolume"
);
subscribe_cluster!(
    subscribe_storageclass_watch,
    StorageClass,
    StorageClassInfo,
    "StorageClass"
);

// ----- Custom resources (runtime-discovered CRDs) -----

/// Subscribe to changes on a custom resource defined by a CRD.
/// Caller passes the resolved group/version/kind/plural — the same
/// quartet the existing `list_custom_resources` command uses.
/// Each event payload is the same `CustomResourceInfo` shape that
/// command returns, so the frontend hook plugs directly into the
/// existing `["custom-resources", crdName, namespace]` query cache.
// Async for the same reason as `subscribe_namespaced!`.
#[tauri::command]
pub async fn subscribe_custom_resource_watch(
    group: String,
    version: String,
    kind: String,
    plural: String,
    scope: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<String> {
    let client = current_client(&state)?;

    let api_resource = kube::discovery::ApiResource::from_gvk_with_plural(
        &kube::api::GroupVersionKind::gvk(&group, &version, &kind),
        &plural,
    );

    state
        .watch_manager
        .subscribe_custom_list(client, &api_resource, &kind, scope, |obj| {
            Some(crate::commands::crds::dynamic_object_to_custom_resource_info(obj))
        })
}

// ----- One object -----

/// Watch a single built-in object by name, for "tell me when" on it, and for
/// a page whose object is gone to see it created again under that name.
///
/// The kinds are the ones a person waits on: a rollout, a pod, a job, a node,
/// a Service. Anything else is refused by name rather than watched as the
/// wrong type.
#[tauri::command]
pub async fn subscribe_object_watch(
    kind: String,
    namespace: Option<String>,
    name: String,
    state: State<'_, AppState>,
) -> Result<String> {
    crate::validation::validate_dns_subdomain(&name)?;
    let client = current_client(&state)?;
    let namespaced = |ns: Option<String>| -> Result<String> {
        let ns = ns.ok_or_else(|| {
            Error::Internal(format!("{kind} is namespaced; a namespace is required"))
        })?;
        crate::validation::validate_namespace(&ns)?;
        Ok(ns)
    };
    let manager = &state.watch_manager;
    let id = match kind.as_str() {
        "Pod" => manager.subscribe_object::<Pod, _, _>(
            client,
            "Pod",
            &namespaced(namespace)?,
            name,
            |o| Some(PodInfo::from(o)),
        ),
        "Deployment" => manager.subscribe_object::<Deployment, _, _>(
            client,
            "Deployment",
            &namespaced(namespace)?,
            name,
            |o| Some(DeploymentInfo::from(o)),
        ),
        "StatefulSet" => manager.subscribe_object::<StatefulSet, _, _>(
            client,
            "StatefulSet",
            &namespaced(namespace)?,
            name,
            |o| Some(StatefulSetInfo::from(o)),
        ),
        "DaemonSet" => manager.subscribe_object::<DaemonSet, _, _>(
            client,
            "DaemonSet",
            &namespaced(namespace)?,
            name,
            |o| Some(DaemonSetInfo::from(o)),
        ),
        "Job" => manager.subscribe_object::<Job, _, _>(
            client,
            "Job",
            &namespaced(namespace)?,
            name,
            |o| Some(JobInfo::from(o)),
        ),
        "Service" => manager.subscribe_object::<Service, _, _>(
            client,
            "Service",
            &namespaced(namespace)?,
            name,
            |o| Some(ServiceInfo::from(o)),
        ),
        "Node" => manager.subscribe_cluster_object::<Node, _, _>(client, "Node", name, |o| {
            Some(NodeInfo::from(o))
        }),
        other => {
            return Err(Error::Internal(format!(
                "no single-object watch for kind {other}"
            )))
        }
    };
    Ok(id)
}

/// The pods one page lists: a controller's, by the selector it claims them
/// with, or a node's, by where they run. The API server narrows the watch, so
/// a page follows its own pods and not every pod in their namespace.
#[tauri::command]
pub async fn subscribe_owned_pod_watch(
    kind: String,
    namespace: Option<String>,
    name: String,
    state: State<'_, AppState>,
) -> Result<String> {
    let client = current_client(&state)?;
    let (namespace, narrow) = pods_of(&client, &kind, namespace, &name).await?;
    Ok(state.watch_manager.subscribe_narrowed::<Pod, _, _>(
        client,
        "Pod",
        namespace.as_deref(),
        narrow,
        |o| Some(PodInfo::from(o)),
    ))
}

/// Where the pods of `kind` `name` are watched, and by what. Every selector
/// these kinds carry is immutable, so it is read once, at subscribe.
async fn pods_of(
    client: &kube::Client,
    kind: &str,
    namespace: Option<String>,
    name: &str,
) -> Result<(Option<String>, Narrow)> {
    crate::validation::validate_dns_subdomain(name)?;
    if kind == "Node" {
        return Ok((None, Narrow::fields(format!("spec.nodeName={name}"))));
    }
    let namespace = namespace
        .ok_or_else(|| Error::Internal(format!("{kind} is namespaced; a namespace is required")))?;
    crate::validation::validate_namespace(&namespace)?;
    let selector = match kind {
        "Deployment" => {
            let owner: Deployment = kube::Api::namespaced(client.clone(), &namespace)
                .get(name)
                .await?;
            Selector::Query(owner.spec.as_ref().map(|s| &s.selector)).query_text()
        }
        "ReplicaSet" => {
            let owner: ReplicaSet = kube::Api::namespaced(client.clone(), &namespace)
                .get(name)
                .await?;
            Selector::Query(owner.spec.as_ref().map(|s| &s.selector)).query_text()
        }
        "StatefulSet" => {
            let owner: StatefulSet = kube::Api::namespaced(client.clone(), &namespace)
                .get(name)
                .await?;
            Selector::Query(owner.spec.as_ref().map(|s| &s.selector)).query_text()
        }
        "DaemonSet" => {
            let owner: DaemonSet = kube::Api::namespaced(client.clone(), &namespace)
                .get(name)
                .await?;
            Selector::Query(owner.spec.as_ref().map(|s| &s.selector)).query_text()
        }
        "Job" => {
            let owner: Job = kube::Api::namespaced(client.clone(), &namespace)
                .get(name)
                .await?;
            Selector::Query(owner.spec.as_ref().and_then(|s| s.selector.as_ref())).query_text()
        }
        other => {
            return Err(Error::Internal(format!(
                "no owned-pod watch for kind {other}"
            )))
        }
    };
    let selector =
        selector.ok_or_else(|| Error::InvalidInput(format!("{kind} {name} has no selector")))?;
    Ok((Some(namespace), Narrow::labels(selector)))
}

/// Watch a single custom resource by name; the CRD coordinates come from
/// the integration that knows them.
#[tauri::command]
pub async fn subscribe_custom_object_watch(
    group: String,
    version: String,
    kind: String,
    plural: String,
    namespace: Option<String>,
    name: String,
    state: State<'_, AppState>,
) -> Result<String> {
    crate::validation::validate_path_segment(&name)?;
    if let Some(ns) = &namespace {
        crate::validation::validate_namespace(ns)?;
    }
    let client = current_client(&state)?;
    let api_resource = kube::discovery::ApiResource::from_gvk_with_plural(
        &kube::api::GroupVersionKind::gvk(&group, &version, &kind),
        &plural,
    );
    Ok(state.watch_manager.subscribe_custom_resource(
        client,
        &api_resource,
        &kind,
        namespace,
        Some(name),
        |obj| Some(crate::commands::crds::dynamic_object_to_custom_resource_info(obj)),
    ))
}

// ----- Lifecycle -----

/// Signal that the frontend has registered its `resource-event`
/// listener. The watcher task is gated on this signal so the very
/// first `restarted` + applied-burst aren't lost. Idempotent.
#[tauri::command]
pub fn resource_watch_subscribed(stream_id: String, state: State<'_, AppState>) -> Result<()> {
    state.watch_manager.mark_subscribed(&stream_id)
}

/// Cancel a watch session. Idempotent — unsubscribing twice is a
/// no-op so racing cleanup paths don't fail.
#[tauri::command]
pub fn unsubscribe_resource_watch(stream_id: String, state: State<'_, AppState>) {
    state.watch_manager.unsubscribe(&stream_id);
}

// ----- Gateway API (runtime-discovered served versions) -----

/// Subscribe to one route kind, `RouteInfo` payload — the shape all five
/// list pages share.
#[tauri::command]
pub async fn subscribe_gateway_route_watch(
    kind: String,
    scope: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<String> {
    crate::commands::gateway::require_route_kind(&kind)?;
    let client = current_client(&state)?;
    let api_resource = crate::commands::gateway::served_api_resource(&kind, &state).await?;
    let stamp = api_resource.clone();
    state
        .watch_manager
        .subscribe_custom_list(client, &api_resource, &kind, scope, move |obj| {
            Some(crate::resources::RouteInfo::read(
                &crate::commands::gateway::with_types(obj.clone(), &stamp),
            ))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::served::test_server::server;

    fn deployment() -> String {
        serde_json::json!({
            "apiVersion": "apps/v1", "kind": "Deployment",
            "metadata": { "name": "checkout", "namespace": "shop" },
            "spec": {
                "selector": {
                    "matchLabels": { "app": "checkout" },
                    "matchExpressions": [{ "key": "tier", "operator": "In", "values": ["web"] }],
                },
                "template": { "metadata": { "labels": { "app": "checkout", "tier": "web" } } },
            },
        })
        .to_string()
    }

    /// The Deployment's Pods tab follows the pods its own read lists. Fails if
    /// the watch drops the set-based half of the selector, or watches the
    /// whole namespace instead.
    #[tokio::test]
    async fn a_deployments_pods_are_watched_by_its_whole_selector() {
        let (client, _) = server(vec![(
            "/apis/apps/v1/namespaces/shop/deployments/checkout",
            200,
            deployment(),
        )])
        .await;

        let watched = pods_of(&client, "Deployment", Some("shop".into()), "checkout")
            .await
            .expect("a selector");

        assert_eq!(
            watched,
            (
                Some("shop".to_string()),
                Narrow::labels("app=checkout,tier in (web)".into())
            )
        );
    }

    /// A Job is read by the selector the controller gave it, so its pods are
    /// followed whatever they are named. Fails if a Job resolves to nothing.
    #[tokio::test]
    async fn a_jobs_pods_are_watched_by_the_selector_its_controller_set() {
        let job = serde_json::json!({
            "apiVersion": "batch/v1", "kind": "Job",
            "metadata": { "name": "migrate", "namespace": "shop" },
            "spec": {
                "selector": { "matchLabels": { "batch.kubernetes.io/controller-uid": "u1" } },
                "template": { "spec": { "containers": [] } },
            },
        })
        .to_string();
        let (client, _) = server(vec![(
            "/apis/batch/v1/namespaces/shop/jobs/migrate",
            200,
            job,
        )])
        .await;

        let watched = pods_of(&client, "Job", Some("shop".into()), "migrate")
            .await
            .expect("a selector");

        assert_eq!(
            watched.1,
            Narrow::labels("batch.kubernetes.io/controller-uid=u1".into())
        );
    }

    /// A node's pods live in every namespace. Fails if the node page's watch is
    /// scoped to one, or narrowed by labels a node does not have.
    #[tokio::test]
    async fn a_nodes_pods_are_watched_across_the_cluster_by_where_they_run() {
        let (client, hits) = server(vec![]).await;

        let watched = pods_of(&client, "Node", None, "k3d-rubick-live-server-0")
            .await
            .expect("a node narrows by field");

        assert_eq!(
            watched,
            (
                None,
                Narrow::fields("spec.nodeName=k3d-rubick-live-server-0".into())
            )
        );
        assert!(hits.lock().unwrap().is_empty(), "a node needs no read");
    }

    /// An owner the cluster refuses to show leaves nothing to narrow by, and
    /// says so rather than watching every pod in the namespace.
    #[tokio::test]
    async fn an_owner_that_cannot_be_read_is_not_watched_as_its_namespace() {
        let (client, _) = server(vec![(
            "/apis/apps/v1/namespaces/shop/deployments/checkout",
            403,
            serde_json::json!({
                "kind": "Status", "apiVersion": "v1", "status": "Failure",
                "reason": "Forbidden", "code": 403,
            })
            .to_string(),
        )])
        .await;

        let refused = pods_of(&client, "Deployment", Some("shop".into()), "checkout").await;

        assert!(refused.is_err(), "got {refused:?}");
    }

    /// Fails if a kind with no pods of its own is watched as if it had some.
    #[tokio::test]
    async fn a_kind_that_owns_no_pods_is_refused_by_name() {
        let (client, _) = server(vec![]).await;

        let refused = pods_of(&client, "ConfigMap", Some("shop".into()), "settings").await;

        assert!(
            matches!(&refused, Err(Error::Internal(message)) if message.contains("ConfigMap")),
            "got {refused:?}"
        );
    }
}
