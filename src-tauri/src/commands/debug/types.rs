//! Shared types for debug commands.

use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

/// Configuration for debug session
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugConfig {
    /// Debug container image
    pub image: String,
    /// Target container name (for ephemeral mode - to share process namespace)
    pub target_container: Option<String>,
    /// Custom command to run in debug container
    pub command: Option<Vec<String>>,
    /// Share process namespace with target container (for copy mode)
    pub share_processes: bool,
    /// Timeout waiting for container readiness (seconds), default 120
    pub timeout_seconds: Option<u32>,
}

/// Result of debug operation
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugResult {
    /// Name of the pod to connect to
    pub pod_name: String,
    /// Container name for exec
    pub container_name: String,
    /// Namespace
    pub namespace: String,
    /// Whether this is a newly created pod (copy/node) or existing (ephemeral)
    pub is_new_pod: bool,
}

/// Debug operation for tracking container readiness
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugOperation {
    /// Unique operation ID
    pub id: String,
    /// Operation type
    pub operation_type: DebugOperationType,
    /// Pod name (target or being created)
    pub pod_name: String,
    /// Container name
    pub container_name: String,
    /// Namespace
    pub namespace: String,
    /// Creation time (unix timestamp)
    pub created_at: u64,
    /// Readiness timeout (seconds)
    pub timeout_seconds: u32,
}

/// Type of debug operation
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DebugOperationType {
    Ephemeral,
    CopyPod,
    NodeDebug,
}

/// Status of debug operation
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(tag = "type")]
pub enum DebugStatus {
    /// Waiting for container to be ready
    Pending { reason: String },
    /// Container is ready
    Ready { result: DebugResult },
    /// Container failed to start
    Failed { error: String },
    /// Timeout waiting for container
    Timeout,
}

/// Generate a unique debugger container name
pub(super) fn generate_debugger_name() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("debugger-{timestamp}")
}

/// Generate a unique debug pod name
pub(super) fn generate_debug_pod_name(base_name: &str) -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // Truncate base name if too long to fit within 63 char limit
    let max_base_len = 63 - 7 - 10; // -debug- (7) + timestamp (10)
    let truncated = if base_name.len() > max_base_len {
        &base_name[..max_base_len]
    } else {
        base_name
    };
    format!("{truncated}-debug-{timestamp}")
}
