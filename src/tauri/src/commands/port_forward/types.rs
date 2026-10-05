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
    pub via: ForwardVia,
}

/// What a forward follows when its pod goes away.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ForwardVia {
    /// Nothing puts this pod back: no controller owns it, or none could be read.
    Pod,
    /// The controller at the top of the pod's owner chain.
    Owner {
        #[serde(rename = "ownerKind")]
        owner_kind: String,
        name: String,
    },
    /// A Service, and the port on it that was asked for.
    Service { name: String, port: u16 },
}

impl ForwardVia {
    /// The kind and name a reader would look for a replacement under.
    #[must_use]
    pub fn names(&self) -> Option<(&str, &str)> {
        match self {
            Self::Pod => None,
            Self::Owner { owner_kind, name } => Some((owner_kind, name)),
            Self::Service { name, .. } => Some(("Service", name)),
        }
    }
}

/// Why a forward's status changed, worded by the frontend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "says", rename_all = "camelCase")]
pub enum ForwardNote {
    /// The cluster's or the network's own words.
    Said { text: String },
    /// An attempt failed; the next is `after_secs` away.
    Retrying { text: String, after_secs: u64 },
    /// `attempts` failures in a row, and this connection stopped trying.
    GaveUp { text: String, attempts: u32 },
    /// The pod was deleted and nothing names another to move to.
    PodGone { pod: String },
    /// The pod was deleted and `kind`/`name` has no ready pod yet.
    Waiting {
        pod: String,
        kind: String,
        name: String,
    },
    /// The wait ran out with no ready pod behind `kind`/`name`.
    NoReplacement {
        pod: String,
        kind: String,
        name: String,
    },
    /// The pod was deleted and looking for another failed.
    SearchFailed { pod: String, text: String },
    /// The forward left `from` for the pod the event names.
    Moved { from: String },
    /// The pod answered and opened no stream for the port.
    NoStream,
    /// The local port stopped accepting connections.
    ListenerFailed { text: String },
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

/// Says what happened to one forward, against the pod it now points at.
#[derive(Clone)]
pub(super) struct Reporter {
    pub event_tx: tokio::sync::broadcast::Sender<AppEvent>,
    pub id: String,
    pub namespace: String,
    pub local_port: u16,
}

impl Reporter {
    pub fn say(
        &self,
        pod: &str,
        remote_port: u16,
        status: &str,
        note: Option<ForwardNote>,
        attempt: Option<u32>,
    ) {
        let _ = self.event_tx.send(AppEvent::PortForwardStatus {
            id: self.id.clone(),
            pod: pod.to_string(),
            namespace: self.namespace.clone(),
            local_port: self.local_port,
            remote_port,
            status: status.to_string(),
            note,
            attempt,
        });
    }
}
