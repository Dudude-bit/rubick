//! DTOs for port-forward sessions and saved configs, plus the
//! shared helpers used by both the live-session and saved-config
//! commands.

use crate::config::PortForwardConfig as StoredPortForwardConfig;
use crate::error::{Error, Result};
use crate::state::AppEvent;
use serde::{Deserialize, Serialize};

/// Port-forward request payload
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardRequest {
    pub local_port: u16,
    pub remote_port: u16,
    pub auto_reconnect: bool,
}

/// Active port-forward session info
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardSessionInfo {
    pub id: String,
    pub context: String,
    pub pod: String,
    pub namespace: String,
    pub local_port: u16,
    pub remote_port: u16,
    pub auto_reconnect: bool,
    pub created_at: String,
}

/// Saved port-forward config payload
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardConfigPayload {
    pub context: String,
    pub name: String,
    pub pod: String,
    pub namespace: String,
    pub local_port: u16,
    pub remote_port: u16,
    pub auto_reconnect: bool,
    pub auto_start: bool,
}

/// Saved port-forward config info
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardConfigInfo {
    pub id: String,
    pub context: String,
    pub name: String,
    pub pod: String,
    pub namespace: String,
    pub local_port: u16,
    pub remote_port: u16,
    pub auto_reconnect: bool,
    pub auto_start: bool,
    pub created_at: String,
}

pub(super) fn normalize_port_forward_config(
    payload: &PortForwardConfigPayload,
    id: String,
    created_at: String,
) -> Result<StoredPortForwardConfig> {
    let context = payload.context.trim();
    if context.is_empty() {
        return Err(Error::InvalidInput("Context is required".to_string()));
    }
    let pod = payload.pod.trim();
    if pod.is_empty() {
        return Err(Error::InvalidInput("Pod name is required".to_string()));
    }
    let namespace = payload.namespace.trim();
    if namespace.is_empty() {
        return Err(Error::InvalidInput("Namespace is required".to_string()));
    }
    if payload.local_port == 0 || payload.remote_port == 0 {
        return Err(Error::InvalidInput(
            "Ports must be greater than 0".to_string(),
        ));
    }

    let name = payload.name.trim();
    let name = if name.is_empty() {
        format!("{pod}:{}", payload.remote_port)
    } else {
        name.to_string()
    };

    Ok(StoredPortForwardConfig {
        id,
        context: context.to_string(),
        name,
        pod: pod.to_string(),
        namespace: namespace.to_string(),
        local_port: payload.local_port,
        remote_port: payload.remote_port,
        auto_reconnect: payload.auto_reconnect,
        auto_start: payload.auto_start,
        created_at,
    })
}

pub(super) fn map_config(config: &StoredPortForwardConfig) -> PortForwardConfigInfo {
    PortForwardConfigInfo {
        id: config.id.clone(),
        context: config.context.clone(),
        name: config.name.clone(),
        pod: config.pod.clone(),
        namespace: config.namespace.clone(),
        local_port: config.local_port,
        remote_port: config.remote_port,
        auto_reconnect: config.auto_reconnect,
        auto_start: config.auto_start,
        created_at: config.created_at.clone(),
    }
}

pub(super) fn config_key(config: &StoredPortForwardConfig) -> String {
    format!(
        "{}:{}:{}:{}:{}",
        config.context, config.namespace, config.pod, config.local_port, config.remote_port
    )
}

/// Helper for emitting port-forward status events
#[allow(clippy::too_many_arguments)]
pub(super) fn emit_port_forward_status(
    event_tx: &tokio::sync::broadcast::Sender<AppEvent>,
    session_id: &str,
    pod: &str,
    namespace: &str,
    local_port: u16,
    remote_port: u16,
    status: &str,
    message: Option<String>,
    attempt: Option<u32>,
) {
    let _ = event_tx.send(AppEvent::PortForwardStatus {
        id: session_id.to_string(),
        pod: pod.to_string(),
        namespace: namespace.to_string(),
        local_port,
        remote_port,
        status: status.to_string(),
        message,
        attempt,
    });
}
