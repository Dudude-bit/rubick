//! Node-specific types: `NodeInfo`, `NodeStatusInfo`, `NodeAddressInfo`,
//! `TaintInfo`, `ResourceQuantities`.

use chrono::{DateTime, Utc};
use k8s_openapi::api::core::v1::Node;
use kube::ResourceExt;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use super::common::ConditionInfo;

/// Node information for frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeInfo {
    pub name: String,
    pub uid: String,
    pub status: NodeStatusInfo,
    pub roles: Vec<String>,
    pub version: String,
    pub os: String,
    pub arch: String,
    pub container_runtime: String,
    pub labels: BTreeMap<String, String>,
    pub taints: Vec<TaintInfo>,
    pub capacity: ResourceQuantities,
    pub allocatable: ResourceQuantities,
    /// The cloud's own name for this machine, e.g. `gce://project/zone/name`.
    /// Its scheme is the only unambiguous statement of which cloud a node is
    /// on — a node pool label can be applied by anyone.
    pub provider_id: Option<String>,
    pub created_at: Option<DateTime<Utc>>,
}

/// Node status information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeStatusInfo {
    pub ready: bool,
    pub conditions: Vec<ConditionInfo>,
    pub addresses: Vec<NodeAddressInfo>,
}

/// Node address information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeAddressInfo {
    pub type_: String,
    pub address: String,
}

/// Taint information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaintInfo {
    pub key: String,
    pub value: Option<String>,
    pub effect: String,
}

/// Resource quantities
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ResourceQuantities {
    pub cpu: Option<String>,
    pub memory: Option<String>,
    pub pods: Option<String>,
    pub ephemeral_storage: Option<String>,
}

impl From<&Node> for NodeInfo {
    fn from(node: &Node) -> Self {
        let status = node.status.as_ref();
        let spec = node.spec.as_ref();

        let node_info = status.and_then(|s| s.node_info.as_ref());

        let ready = status
            .and_then(|s| s.conditions.as_ref())
            .is_some_and(|conds| {
                conds
                    .iter()
                    .any(|c| c.type_ == "Ready" && c.status == "True")
            });

        let conditions = status
            .and_then(|s| s.conditions.as_ref())
            .map(|conds| conds.iter().map(ConditionInfo::from).collect())
            .unwrap_or_default();

        let addresses = status
            .and_then(|s| s.addresses.as_ref())
            .map(|addrs| {
                addrs
                    .iter()
                    .map(|a| NodeAddressInfo {
                        type_: a.type_.clone(),
                        address: a.address.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default();

        let roles: Vec<String> = node
            .labels()
            .keys()
            .filter_map(|k| {
                if k.starts_with("node-role.kubernetes.io/") {
                    Some(k.trim_start_matches("node-role.kubernetes.io/").to_string())
                } else {
                    None
                }
            })
            .collect();

        let taints = spec
            .and_then(|s| s.taints.as_ref())
            .map(|ts| {
                ts.iter()
                    .map(|t| TaintInfo {
                        key: t.key.clone(),
                        value: t.value.clone(),
                        effect: t.effect.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default();

        let capacity = status
            .and_then(|s| s.capacity.as_ref())
            .map(|c| ResourceQuantities {
                cpu: c.get("cpu").map(|q| q.0.clone()),
                memory: c.get("memory").map(|q| q.0.clone()),
                pods: c.get("pods").map(|q| q.0.clone()),
                ephemeral_storage: c.get("ephemeral-storage").map(|q| q.0.clone()),
            })
            .unwrap_or_default();

        let allocatable = status
            .and_then(|s| s.allocatable.as_ref())
            .map(|a| ResourceQuantities {
                cpu: a.get("cpu").map(|q| q.0.clone()),
                memory: a.get("memory").map(|q| q.0.clone()),
                pods: a.get("pods").map(|q| q.0.clone()),
                ephemeral_storage: a.get("ephemeral-storage").map(|q| q.0.clone()),
            })
            .unwrap_or_default();

        Self {
            name: node.name_any(),
            uid: node.uid().unwrap_or_default(),
            status: NodeStatusInfo {
                ready,
                conditions,
                addresses,
            },
            roles,
            version: node_info
                .map(|ni| ni.kubelet_version.clone())
                .unwrap_or_default(),
            os: node_info.map(|ni| ni.os_image.clone()).unwrap_or_default(),
            arch: node_info
                .map(|ni| ni.architecture.clone())
                .unwrap_or_default(),
            container_runtime: node_info
                .map(|ni| ni.container_runtime_version.clone())
                .unwrap_or_default(),
            labels: node.labels().clone(),
            taints,
            capacity,
            allocatable,
            provider_id: spec.and_then(|s| s.provider_id.clone()),
            created_at: node.creation_timestamp().map(|t| t.0),
        }
    }
}
