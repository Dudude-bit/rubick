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
//!   1. import `K8sType` from k8s_openapi and `KindInfo` from
//!      `crate::resources`
//!   2. write `subscribe_<kind>_watch(...)` calling
//!      `state.watch_manager.subscribe[_cluster]::<K8sType, _, _>(...)`
//!   3. register in main.rs invoke_handler
//!   4. add binding to `src/generated/commands.ts`
//!   5. set `watch:` field on the page's `createResourceListPage`
//!      / `createWorkloadListPage` config.

use crate::error::{Error, Result};
use crate::resources::{
    ConfigMapInfo, CronJobInfo, DaemonSetInfo, DeploymentInfo, EndpointsInfo, IngressInfo, JobInfo,
    NamespaceInfo, NodeInfo, PersistentVolumeClaimInfo, PersistentVolumeInfo, PodInfo, SecretInfo,
    ServiceInfo, StatefulSetInfo, StorageClassInfo,
};
use crate::state::AppState;
use crate::utils::normalize_optional_namespace;
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, StatefulSet};
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{
    ConfigMap, Endpoints, Namespace, Node, PersistentVolume, PersistentVolumeClaim, Pod, Secret,
    Service,
};
use k8s_openapi::api::networking::v1::Ingress;
use k8s_openapi::api::storage::v1::StorageClass;
use tauri::State;

/// Resolve the `(context, client)` pair for a watch command. Returns
/// the standard NO_CLUSTER / NO_CLIENT errors so the frontend hook
/// can report a real failure instead of a wedged stream.
fn current_client(state: &State<'_, AppState>) -> Result<kube::Client> {
    let context = state
        .get_current_context()
        .ok_or_else(|| Error::Internal(crate::error::messages::NO_CLUSTER.to_string()))?;
    let client = state
        .client_manager
        .get_client(&context)
        .ok_or_else(|| Error::Internal(crate::error::messages::NO_CLIENT.to_string()))?;
    Ok((*client).clone())
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
        #[tauri::command]
        pub async fn $cmd_name(
            namespace: Option<String>,
            state: State<'_, AppState>,
        ) -> Result<String> {
            let client = current_client(&state)?;
            let namespace = normalize_optional_namespace(namespace);
            Ok(state.watch_manager.subscribe::<$k8s_type, _, _>(
                client,
                $kind_label,
                namespace,
                |o| Some(<$info_type>::from(o)),
            ))
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
subscribe_namespaced!(subscribe_pod_watch, Pod, PodInfo, "Pod");
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
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<String> {
    let client = current_client(&state)?;
    let namespace = normalize_optional_namespace(namespace);

    let api_resource = kube::discovery::ApiResource {
        group: group.clone(),
        version: version.clone(),
        api_version: if group.is_empty() {
            version.clone()
        } else {
            format!("{group}/{version}")
        },
        kind: kind.clone(),
        plural,
    };

    Ok(state.watch_manager.subscribe_custom_resource(
        client,
        api_resource,
        &kind,
        namespace,
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
