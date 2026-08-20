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

/// Add an ephemeral debug container to an existing pod
#[tauri::command]
pub async fn debug_pod_ephemeral(
    pod_name: String,
    namespace: Option<String>,
    config: DebugConfig,
    state: State<'_, AppState>,
) -> Result<DebugOperation> {
    crate::validation::validate_dns_label(&pod_name)?;

    let ctx = ResourceContext::for_command(&state, namespace)?;
    let api: Api<Pod> = ctx.namespaced_api();
    let ns = require_namespace(ctx.namespace.clone(), "default".to_string())?;

    // Verify pod exists
    let _pod = api.get(&pod_name).await?;

    let container_name = generate_debugger_name();

    // Build ephemeral container spec
    let mut ephemeral_container = serde_json::json!({
        "name": container_name,
        "image": config.image,
        "stdin": true,
        "tty": true,
        "securityContext": {
            "capabilities": {
                "add": ["SYS_PTRACE"]
            }
        }
    });

    // Add target container if specified (for process namespace sharing)
    if let Some(ref target) = config.target_container {
        ephemeral_container["targetContainerName"] = serde_json::json!(target);
    }

    // Add custom command if specified
    if let Some(ref cmd) = config.command {
        if !cmd.is_empty() {
            ephemeral_container["command"] = serde_json::json!(cmd);
        }
    }

    // Create the patch
    let patch = serde_json::json!({
        "spec": {
            "ephemeralContainers": [ephemeral_container]
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
    crate::validation::validate_dns_label(&pod_name)?;

    let ctx = ResourceContext::for_command(&state, namespace)?;
    let api: Api<Pod> = ctx.namespaced_api();
    let ns = require_namespace(ctx.namespace.clone(), "default".to_string())?;

    // Get the original pod
    let original_pod = api.get(&pod_name).await?;

    let debug_pod_name = generate_debug_pod_name(&pod_name);
    let container_name = generate_debugger_name();

    // Build the debug container
    let debug_container = Container {
        name: container_name.clone(),
        image: Some(config.image.clone()),
        stdin: Some(true),
        tty: Some(true),
        command: config.command.clone(),
        security_context: Some(SecurityContext {
            capabilities: Some(Capabilities {
                add: Some(vec!["SYS_PTRACE".to_string()]),
                ..Default::default()
            }),
            ..Default::default()
        }),
        ..Default::default()
    };

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

    // Add the debug container
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
    labels.insert("k8s-gui/debug-source".to_string(), pod_name.clone());
    labels.insert("k8s-gui/created-at".to_string(), created_at.to_string());

    // Create the debug pod
    let debug_pod = Pod {
        metadata: ObjectMeta {
            name: Some(debug_pod_name.clone()),
            namespace: Some(ns.clone()),
            labels: Some(labels),
            // Don't copy owner references - we don't want controllers managing this pod
            ..Default::default()
        },
        spec: Some(new_spec),
        ..Default::default()
    };

    // Create the pod
    api.create(&PostParams::default(), &debug_pod).await?;

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
    crate::validation::validate_dns_label(&node_name)?;

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
    labels.insert("k8s-gui/debug-node".to_string(), node_name.clone());
    labels.insert("k8s-gui/created-at".to_string(), created_at.to_string());

    // Create the privileged debug pod
    let debug_pod = Pod {
        metadata: ObjectMeta {
            name: Some(debug_pod_name.clone()),
            namespace: Some(ns.clone()),
            labels: Some(labels),
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

    // Create the pod
    api.create(&PostParams::default(), &debug_pod).await?;

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
