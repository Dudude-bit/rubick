//! Service-specific types: `ServiceInfo`, `ServicePortInfo`.

use chrono::{DateTime, Utc};
use k8s_openapi::api::core::v1::Service;
use kube::ResourceExt;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Service information for frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceInfo {
    pub name: String,
    pub namespace: String,
    pub uid: String,
    pub type_: String,
    pub session_affinity: String,
    pub cluster_ip: Option<String>,
    pub external_ips: Vec<String>,
    pub load_balancer_ips: Vec<String>,
    pub ports: Vec<ServicePortInfo>,
    pub selector: BTreeMap<String, String>,
    pub labels: BTreeMap<String, String>,
    pub annotations: BTreeMap<String, String>,
    pub created_at: Option<DateTime<Utc>>,
}

/// Service port information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServicePortInfo {
    pub name: Option<String>,
    pub port: i32,
    pub target_port: String,
    pub node_port: Option<i32>,
    pub protocol: String,
}

impl From<&Service> for ServiceInfo {
    fn from(service: &Service) -> Self {
        let spec = service.spec.as_ref();
        let status = service.status.as_ref();

        let load_balancer_ips = status
            .and_then(|s| s.load_balancer.as_ref())
            .and_then(|lb| lb.ingress.as_ref())
            .map(|ingresses| {
                ingresses
                    .iter()
                    .filter_map(|i| i.ip.clone().or_else(|| i.hostname.clone()))
                    .collect()
            })
            .unwrap_or_default();

        let ports = spec
            .and_then(|s| s.ports.as_ref())
            .map(|ps| {
                ps.iter()
                    .map(|p| ServicePortInfo {
                        name: p.name.clone(),
                        port: p.port,
                        target_port: p
                            .target_port
                            .as_ref()
                            .map(|tp| match tp {
                                k8s_openapi::apimachinery::pkg::util::intstr::IntOrString::Int(i) => {
                                    i.to_string()
                                }
                                k8s_openapi::apimachinery::pkg::util::intstr::IntOrString::String(s) => {
                                    s.clone()
                                }
                            })
                            .unwrap_or_default(),
                        node_port: p.node_port,
                        protocol: p.protocol.clone().unwrap_or_else(|| "TCP".to_string()),
                    })
                    .collect()
            })
            .unwrap_or_default();

        Self {
            name: service.name_any(),
            namespace: service.namespace().unwrap_or_default(),
            uid: service.uid().unwrap_or_default(),
            type_: spec
                .and_then(|s| s.type_.clone())
                .unwrap_or_else(|| "ClusterIP".to_string()),
            session_affinity: spec
                .and_then(|s| s.session_affinity.clone())
                .unwrap_or_else(|| "None".to_string()),
            cluster_ip: spec.and_then(|s| s.cluster_ip.clone()),
            external_ips: spec
                .and_then(|s| s.external_ips.clone())
                .unwrap_or_default(),
            load_balancer_ips,
            ports,
            selector: spec.and_then(|s| s.selector.clone()).unwrap_or_default(),
            labels: service.labels().clone(),
            annotations: service.annotations().clone(),
            created_at: service.creation_timestamp().map(|t| t.0),
        }
    }
}
