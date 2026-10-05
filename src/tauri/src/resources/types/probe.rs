//! A container's probes as its template declares them, with the defaults the
//! API server applies filled in, so a revision without a field and one that
//! spells out the default compare equal.

use k8s_openapi::api::core::v1::{Container, Probe};
use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ProbeHandler {
    HttpGet {
        path: String,
        port: String,
        scheme: String,
        host: Option<String>,
    },
    TcpSocket {
        port: String,
    },
    Exec {
        command: Vec<String>,
    },
    Grpc {
        port: i32,
        service: Option<String>,
    },
    /// A probe with no handler the API knows, which validation should refuse.
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeInfo {
    pub handler: ProbeHandler,
    pub initial_delay_seconds: i32,
    pub period_seconds: i32,
    pub timeout_seconds: i32,
    pub success_threshold: i32,
    pub failure_threshold: i32,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerProbes {
    pub readiness: Option<ProbeInfo>,
    pub liveness: Option<ProbeInfo>,
    pub startup: Option<ProbeInfo>,
}

fn port(value: &IntOrString) -> String {
    match value {
        IntOrString::Int(n) => n.to_string(),
        IntOrString::String(name) => name.clone(),
    }
}

impl ProbeInfo {
    #[must_use]
    pub fn of(probe: &Probe) -> Self {
        let handler = if let Some(http) = &probe.http_get {
            ProbeHandler::HttpGet {
                path: http.path.clone().unwrap_or_else(|| "/".to_string()),
                port: port(&http.port),
                scheme: http.scheme.clone().unwrap_or_else(|| "HTTP".to_string()),
                host: http.host.clone(),
            }
        } else if let Some(tcp) = &probe.tcp_socket {
            ProbeHandler::TcpSocket {
                port: port(&tcp.port),
            }
        } else if let Some(exec) = &probe.exec {
            ProbeHandler::Exec {
                command: exec.command.clone().unwrap_or_default(),
            }
        } else if let Some(grpc) = &probe.grpc {
            ProbeHandler::Grpc {
                port: grpc.port,
                service: grpc.service.clone(),
            }
        } else {
            ProbeHandler::Unknown
        };
        Self {
            handler,
            initial_delay_seconds: probe.initial_delay_seconds.unwrap_or(0),
            period_seconds: probe.period_seconds.unwrap_or(10),
            timeout_seconds: probe.timeout_seconds.unwrap_or(1),
            success_threshold: probe.success_threshold.unwrap_or(1),
            failure_threshold: probe.failure_threshold.unwrap_or(3),
        }
    }
}

impl ContainerProbes {
    #[must_use]
    pub fn of(container: &Container) -> Self {
        Self {
            readiness: container.readiness_probe.as_ref().map(ProbeInfo::of),
            liveness: container.liveness_probe.as_ref().map(ProbeInfo::of),
            startup: container.startup_probe.as_ref().map(ProbeInfo::of),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::api::core::v1::HTTPGetAction;

    /// The `search` probe as revision 2 declared it: a named port, and the
    /// timings the API server would have defaulted.
    #[test]
    fn an_http_probe_keeps_its_path_and_named_port_and_gets_the_defaults() {
        let container = Container {
            readiness_probe: Some(Probe {
                http_get: Some(HTTPGetAction {
                    path: Some("/healthz".to_string()),
                    port: IntOrString::String("http".to_string()),
                    ..Default::default()
                }),
                period_seconds: Some(5),
                ..Default::default()
            }),
            ..Default::default()
        };
        let probes = ContainerProbes::of(&container);
        assert_eq!(
            probes.readiness,
            Some(ProbeInfo {
                handler: ProbeHandler::HttpGet {
                    path: "/healthz".to_string(),
                    port: "http".to_string(),
                    scheme: "HTTP".to_string(),
                    host: None,
                },
                initial_delay_seconds: 0,
                period_seconds: 5,
                timeout_seconds: 1,
                success_threshold: 1,
                failure_threshold: 3,
            })
        );
        assert_eq!(probes.liveness, None);
    }
}
