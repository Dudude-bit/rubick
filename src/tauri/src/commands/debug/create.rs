//! Tauri commands that create a debug session: ephemeral / copy-pod /
//! node-debug.

use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

use k8s_openapi::api::core::v1::{
    Capabilities, Container, HostPathVolumeSource, Pod, PodSpec, SecurityContext, Toleration,
    Volume, VolumeMount,
};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
use kube::api::{Api, Patch, PatchParams, PostParams};
use tauri::State;

use crate::commands::helpers::ResourceContext;
use crate::error::{Error, Result};
use crate::state::AppState;
use crate::utils::require_namespace;

use super::types::{
    generate_debug_pod_name, generate_debugger_name, DebugConfig, DebugOperation,
    DebugOperationType,
};

const TRACE: &str = "SYS_PTRACE";

/// The ephemeral container as the API takes it. It states no security
/// context unless the reader asked to trace processes: the capability is
/// outside Pod Security baseline, and added always it had every Debug in a
/// namespace enforcing that level refused.
fn ephemeral_container(name: &str, config: &DebugConfig) -> serde_json::Value {
    let mut container = serde_json::json!({
        "name": name,
        "image": config.image,
        "stdin": true,
        "tty": true,
    });
    if config.trace_processes {
        container["securityContext"] = serde_json::json!({ "capabilities": { "add": [TRACE] } });
    }
    // Add target container if specified (for process namespace sharing)
    if let Some(ref target) = config.target_container {
        container["targetContainerName"] = serde_json::json!(target);
    }
    // Add custom command if specified
    if let Some(ref cmd) = config.command {
        if !cmd.is_empty() {
            container["command"] = serde_json::json!(cmd);
        }
    }
    container
}

/// The debugger container of a pod copy, under the same rule.
fn debugger_container(name: &str, config: &DebugConfig) -> Container {
    Container {
        name: name.to_string(),
        image: Some(config.image.clone()),
        stdin: Some(true),
        tty: Some(true),
        command: config.command.clone(),
        security_context: config.trace_processes.then(|| SecurityContext {
            capabilities: Some(Capabilities {
                add: Some(vec![TRACE.to_string()]),
                ..Default::default()
            }),
            ..Default::default()
        }),
        ..Default::default()
    }
}

/// Create a pod this app makes for a debug session. A create nobody
/// answered may have been stored all the same, and the operation that would
/// remember its name is never recorded: it is asked to go at once.
async fn create_made(api: &Api<Pod>, pod: &Pod) -> Result<()> {
    let Err(err) = api.create(&PostParams::default(), pod).await else {
        return Ok(());
    };
    let err = Error::from(err);
    if err.is_unanswered() {
        let (api, name) = (api.clone(), pod.metadata.name.clone().unwrap_or_default());
        tokio::spawn(async move {
            let _ = api.delete(&name, &kube::api::DeleteParams::default()).await;
        });
    }
    Err(err)
}

/// Add an ephemeral debug container to an existing pod
#[tauri::command]
pub async fn debug_pod_ephemeral(
    pod_name: String,
    namespace: Option<String>,
    config: DebugConfig,
    state: State<'_, AppState>,
) -> Result<DebugOperation> {
    crate::validation::validate_name::<Pod>(&pod_name)?;

    let ctx = ResourceContext::for_command(&state, namespace)?;
    let api: Api<Pod> = ctx.namespaced_api();
    let ns = require_namespace(ctx.namespace.clone(), "default".to_string())?;

    // Verify pod exists
    let _pod = api.get(&pod_name).await?;

    let container_name = generate_debugger_name();

    // Create the patch
    let patch = serde_json::json!({
        "spec": {
            "ephemeralContainers": [ephemeral_container(&container_name, &config)]
        }
    });

    // Apply the patch using the ephemeralcontainers subresource
    let patch_params = PatchParams::default();
    api.patch_subresource(
        "ephemeralcontainers",
        &pod_name,
        &patch_params,
        &Patch::Strategic(&patch),
    )
    .await
    .map_err(|e| {
        // Provide helpful error message for unsupported clusters
        if e.to_string().contains("not found")
            || e.to_string().contains("ephemeralContainers")
            || e.to_string().contains("404")
        {
            Error::InvalidInput(
                "Ephemeral containers are not supported on this cluster. \
                 Requires Kubernetes 1.25+. Try using 'Copy Pod' mode instead."
                    .to_string(),
            )
        } else {
            Error::from(e)
        }
    })?;

    // Create and store the debug operation
    let operation_id = crate::utils::generate_id("debug");
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let timeout_seconds = config.timeout_seconds.unwrap_or(120);

    let operation = DebugOperation {
        id: operation_id.clone(),
        operation_type: DebugOperationType::Ephemeral,
        pod_name,
        container_name,
        namespace: ns,
        created_at,
        timeout_seconds,
    };

    state
        .debug_operations
        .insert(operation_id, operation.clone());

    Ok(operation)
}

/// Create a copy of a pod with a debug container
#[tauri::command]
pub async fn debug_pod_copy(
    pod_name: String,
    namespace: Option<String>,
    config: DebugConfig,
    state: State<'_, AppState>,
) -> Result<DebugOperation> {
    crate::validation::validate_name::<Pod>(&pod_name)?;

    let ctx = ResourceContext::for_command(&state, namespace)?;
    let api: Api<Pod> = ctx.namespaced_api();
    let ns = require_namespace(ctx.namespace.clone(), "default".to_string())?;

    let original_pod = api.get(&pod_name).await?;

    let debug_pod_name = generate_debug_pod_name(&pod_name);
    let container_name = generate_debugger_name();

    let debug_container = debugger_container(&container_name, &config);

    // Clone and modify the pod spec
    let mut new_spec = original_pod.spec.clone().unwrap_or_default();

    // Clear ephemeral containers - cannot be set on pod creation
    new_spec.ephemeral_containers = None;

    // Clear scheduling constraints to allow rescheduling
    new_spec.node_name = None;
    new_spec.node_selector = None;

    // Enable process namespace sharing if requested
    if config.share_processes {
        new_spec.share_process_namespace = Some(true);
    }

    new_spec.containers.push(debug_container);

    // Set restart policy to Never for debug pods
    new_spec.restart_policy = Some("Never".to_string());

    // Add TTL - auto-terminate after 1 hour
    new_spec.active_deadline_seconds = Some(3600);

    // Get current timestamp for labels
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    // Create labels for the debug pod
    let mut labels = BTreeMap::new();
    labels.insert("k8s-gui/debug-pod".to_string(), "true".to_string());
    labels.insert("k8s-gui/created-at".to_string(), created_at.to_string());
    // An annotation: a pod's name can pass the 63 characters a label holds.
    let annotations = BTreeMap::from([("k8s-gui/debug-source".to_string(), pod_name.clone())]);

    let debug_pod = Pod {
        metadata: ObjectMeta {
            name: Some(debug_pod_name.clone()),
            namespace: Some(ns.clone()),
            labels: Some(labels),
            annotations: Some(annotations),
            // Don't copy owner references - we don't want controllers managing this pod
            ..Default::default()
        },
        spec: Some(new_spec),
        ..Default::default()
    };

    create_made(&api, &debug_pod).await?;

    // Create and store the debug operation
    let operation_id = crate::utils::generate_id("debug");
    let timeout_seconds = config.timeout_seconds.unwrap_or(120);

    let operation = DebugOperation {
        id: operation_id.clone(),
        operation_type: DebugOperationType::CopyPod,
        pod_name: debug_pod_name,
        container_name,
        namespace: ns,
        created_at,
        timeout_seconds,
    };

    state
        .debug_operations
        .insert(operation_id, operation.clone());

    Ok(operation)
}

/// Create a privileged debug pod on a specific node
#[tauri::command]
pub async fn debug_node(
    node_name: String,
    namespace: Option<String>,
    config: DebugConfig,
    state: State<'_, AppState>,
) -> Result<DebugOperation> {
    crate::validation::validate_name::<k8s_openapi::api::core::v1::Node>(&node_name)?;

    let ctx = ResourceContext::for_command(&state, namespace)?;
    let api: Api<Pod> = ctx.namespaced_api();
    let ns = require_namespace(ctx.namespace.clone(), "default".to_string())?;

    let debug_pod_name = generate_debug_pod_name(&format!("node-{node_name}"));
    let container_name = "debugger".to_string();

    // Build command - default to shell if not specified
    let command = config
        .command
        .unwrap_or_else(|| vec!["/bin/sh".to_string()]);

    // Get current timestamp for labels and operation tracking
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    // Create labels
    let mut labels = BTreeMap::new();
    labels.insert("k8s-gui/debug-pod".to_string(), "true".to_string());
    labels.insert("k8s-gui/created-at".to_string(), created_at.to_string());
    // An annotation: a node's name runs to 253 characters, a label to 63.
    let annotations = BTreeMap::from([("k8s-gui/debug-node".to_string(), node_name.clone())]);

    // Create the privileged debug pod
    let debug_pod = Pod {
        metadata: ObjectMeta {
            name: Some(debug_pod_name.clone()),
            namespace: Some(ns.clone()),
            labels: Some(labels),
            annotations: Some(annotations),
            ..Default::default()
        },
        spec: Some(PodSpec {
            node_name: Some(node_name),
            host_pid: Some(true),
            host_network: Some(true),
            host_ipc: Some(true),
            containers: vec![Container {
                name: container_name.clone(),
                image: Some(config.image),
                stdin: Some(true),
                tty: Some(true),
                command: Some(command),
                security_context: Some(SecurityContext {
                    privileged: Some(true),
                    ..Default::default()
                }),
                volume_mounts: Some(vec![VolumeMount {
                    name: "host-root".to_string(),
                    mount_path: "/host".to_string(),
                    read_only: Some(false),
                    ..Default::default()
                }]),
                ..Default::default()
            }],
            volumes: Some(vec![Volume {
                name: "host-root".to_string(),
                host_path: Some(HostPathVolumeSource {
                    path: "/".to_string(),
                    type_: Some("Directory".to_string()),
                }),
                ..Default::default()
            }]),
            restart_policy: Some("Never".to_string()),
            // Add TTL - auto-terminate after 1 hour
            active_deadline_seconds: Some(3600),
            // Tolerate all taints to run on any node
            tolerations: Some(vec![Toleration {
                operator: Some("Exists".to_string()),
                ..Default::default()
            }]),
            ..Default::default()
        }),
        ..Default::default()
    };

    create_made(&api, &debug_pod).await?;

    // Create and store the debug operation
    let operation_id = crate::utils::generate_id("debug");
    let timeout_seconds = config.timeout_seconds.unwrap_or(120);

    let operation = DebugOperation {
        id: operation_id.clone(),
        operation_type: DebugOperationType::NodeDebug,
        pod_name: debug_pod_name,
        container_name,
        namespace: ns,
        created_at,
        timeout_seconds,
    };

    state
        .debug_operations
        .insert(operation_id, operation.clone());

    Ok(operation)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(trace_processes: bool) -> DebugConfig {
        DebugConfig {
            image: "busybox".into(),
            target_container: Some("app".into()),
            command: None,
            share_processes: true,
            trace_processes,
            timeout_seconds: None,
        }
    }

    /// A namespace enforcing Pod Security baseline refuses a container that
    /// adds `SYS_PTRACE`, and both modes added it always: Debug could not
    /// be used there at all, where `kubectl debug` works.
    #[test]
    fn a_debug_container_asks_for_no_capability_the_reader_did_not() {
        let ephemeral = ephemeral_container("debugger-1", &config(false));
        assert_eq!(ephemeral.get("securityContext"), None, "{ephemeral}");
        assert_eq!(ephemeral["targetContainerName"], "app");
        assert_eq!(
            debugger_container("debugger-1", &config(false)).security_context,
            None
        );
    }

    /// The answer to a create can be lost after the pod was stored, and the
    /// operation that would remember the pod is recorded only after it: a
    /// copy of the workload then ran its hour with nothing knowing its name.
    #[tokio::test]
    async fn a_pod_whose_create_nobody_answered_is_asked_to_go() {
        use crate::client::served::test_server::answering;
        const MADE: &str = "/api/v1/namespaces/shop/pods/orders-debug-1";
        let (client, hits) = answering(|path, _| match path {
            "/api/v1/namespaces/shop/pods" => (500, "{}".into()),
            _ => (200, "{}".into()),
        })
        .await;
        let api: Api<Pod> = Api::namespaced(client, "shop");
        let mut pod = Pod::default();
        pod.metadata.name = Some("orders-debug-1".into());

        let err = create_made(&api, &pod).await.expect_err("nobody answered");

        assert!(err.is_unanswered(), "{err}");
        let asked = || hits.lock().unwrap().get(MADE).copied().unwrap_or(0);
        for _ in 0..40 {
            if asked() > 0 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert_eq!(asked(), 1, "the delete was never sent");
    }

    /// A refusal is the cluster's own no: nothing was stored, nothing to remove.
    #[tokio::test]
    async fn a_refused_create_leaves_nothing_to_remove() {
        use crate::client::served::test_server::{answering, failure};
        let (client, hits) = answering(|path, _| match path {
            "/api/v1/namespaces/shop/pods" => failure(403, "Forbidden"),
            _ => (200, "{}".into()),
        })
        .await;
        let api: Api<Pod> = Api::namespaced(client, "shop");
        let mut pod = Pod::default();
        pod.metadata.name = Some("orders-debug-1".into());

        let err = create_made(&api, &pod).await.expect_err("refused");

        assert!(err.is_refusal(), "{err}");
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert_eq!(hits.lock().unwrap().len(), 1, "only the create was sent");
    }

    /// Asked for, it is the one capability and nothing beside it.
    #[test]
    fn process_tracing_adds_sys_ptrace_when_the_reader_asks_for_it() {
        let ephemeral = ephemeral_container("debugger-1", &config(true));
        assert_eq!(
            ephemeral["securityContext"],
            serde_json::json!({ "capabilities": { "add": ["SYS_PTRACE"] } })
        );
        let copied = debugger_container("debugger-1", &config(true));
        let context = copied.security_context.expect("a security context");
        assert_eq!(
            context.capabilities.and_then(|c| c.add),
            Some(vec!["SYS_PTRACE".to_string()])
        );
        assert_eq!(context.privileged, None);
    }
}
