//! What an object is connected to, and where a path into it stops.
//!
//! Every edge here is one Kubernetes states outright — an owner reference, a
//! label selector that matches, a volume or env source in a pod spec, an
//! Ingress backend naming a Service, `spec.nodeName`, a claim's volume and
//! storage class. Nothing is inferred from a shared label, a similar name or
//! a common Helm release: a guessed edge is a dead link that the reader
//! cannot tell from a real one.
//!
//! Field names inside the enum variants below carry explicit
//! `#[serde(rename)]`. Serde's container-level `rename_all` does not reach
//! the fields of a variant, and the TS generator honours nothing but an
//! explicit rename there, so the wire format and the bindings only agree
//! when it is spelled out.

use std::collections::BTreeMap;

use k8s_openapi::api::core::v1::PodSpec;
use serde::{Deserialize, Serialize};

use super::types::{mounts_of, volume_source, ServicePortInfo};

/// Whether the app looked, told apart from what it found.
///
/// An object that was never queried and an object that is not there are
/// different claims, and only one of them is the app's to make.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Existence {
    /// Read back from the API server during this call.
    Present,
    /// Named by another object, and the API server does not have it.
    Missing,
    /// Named by another object; the app never asked.
    NotChecked,
}

/// One end of an edge.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectRef {
    pub kind: String,
    pub name: String,
    /// `None` for the cluster-scoped kinds — a Node has no namespace, and a
    /// claim's PersistentVolume is not in the claim's.
    pub namespace: Option<String>,
    pub existence: Existence,
    /// What the object itself says, where the far end is only reachable
    /// through this edge and the reader needs it to draw the hop.
    pub facts: Option<ObjectFacts>,
}

impl ObjectRef {
    #[must_use]
    pub fn new(kind: &str, name: &str, namespace: Option<String>, existence: Existence) -> Self {
        Self {
            kind: kind.to_string(),
            name: name.to_string(),
            namespace,
            existence,
            facts: None,
        }
    }

    /// A name another object stated, which this call did not go and read.
    #[must_use]
    pub fn unchecked(kind: &str, name: &str, namespace: Option<String>) -> Self {
        Self::new(kind, name, namespace, Existence::NotChecked)
    }

    #[must_use]
    pub fn with_facts(mut self, facts: ObjectFacts) -> Self {
        self.facts = Some(facts);
        self
    }

    #[must_use]
    pub fn same_object(&self, other: &Self) -> bool {
        self.kind == other.kind && self.name == other.name && self.namespace == other.namespace
    }
}

/// What an object says about itself, in the terms the far end of an edge is
/// drawn in.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ObjectFacts {
    Service {
        #[serde(rename = "type")]
        type_: String,
        #[serde(rename = "clusterIp")]
        cluster_ip: Option<String>,
        #[serde(rename = "externalName")]
        external_name: Option<String>,
        /// `spec.selector` as text. `None` where the Service has none at all
        /// — an ExternalName, or one whose endpoints are kept by hand.
        selector: Option<String>,
        ports: Vec<ServicePortInfo>,
    },
    Ingress {
        #[serde(rename = "className")]
        class_name: Option<String>,
    },
    Pod {
        phase: String,
        /// What `kubectl get pod` prints in STATUS.
        display: String,
        /// The `Ready` condition, which is what decides whether the Service
        /// puts this pod in its endpoints — the difference between reachable
        /// and merely running.
        ready: bool,
    },
    Workload {
        replicas: i32,
        #[serde(rename = "readyReplicas")]
        ready_replicas: i32,
        /// `deployment.kubernetes.io/revision`, on the kinds that carry it.
        revision: Option<String>,
        /// Whether this is the highest revision among the siblings this call
        /// listed. `None` where the kind has no siblings to be newest of.
        current: Option<bool>,
    },
    Claim {
        phase: String,
        capacity: String,
        #[serde(rename = "storageClass")]
        storage_class: String,
    },
}

/// How a pod spec draws on a ConfigMap, a Secret, a claim or an identity.
///
/// The phrasing the reader sees — "mounted at /etc/app, and APP_MESSAGE
/// reads app.conf" — comes straight off these; nothing downstream has to
/// re-derive it from a volume list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "how", rename_all = "camelCase")]
pub enum Usage {
    /// A declared volume, mounted into a container at a path.
    Mount {
        container: String,
        path: String,
        #[serde(rename = "readOnly")]
        read_only: bool,
        #[serde(rename = "subPath")]
        sub_path: Option<String>,
        /// The `spec.volumes` entry it came through.
        volume: String,
        /// Reached through a `projected` volume rather than named directly.
        projected: bool,
    },
    /// A volume declared from this object that no container mounts. A real
    /// state, and the silent mistake the YAML does not point at.
    Unmounted { volume: String, projected: bool },
    /// One environment variable reading one key.
    Env {
        container: String,
        name: String,
        key: String,
    },
    /// Every key becomes an environment variable.
    EnvFrom { container: String },
    /// `spec.imagePullSecrets`.
    ImagePullSecret,
    /// `spec.serviceAccountName` — the identity the containers hold.
    Identity,
    /// The certificate an Ingress serves for these hosts.
    IngressTls { hosts: Vec<String> },
}

/// The verb, and what states it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "verb", rename_all = "camelCase")]
pub enum Relation {
    /// `metadata.ownerReferences` on `to` names `from`.
    Owns { controller: bool },
    /// `from`'s label selector matches `to`'s labels.
    Selects { selector: String },
    /// `from`'s pod spec names `to` in a volume, an env source, or as its
    /// identity.
    Uses { usages: Vec<Usage> },
    /// An Ingress backend names a Service.
    Routes {
        host: Option<String>,
        path: String,
        #[serde(rename = "pathType")]
        path_type: String,
        /// `None` for a `resource` backend, which names no port.
        port: Option<String>,
        /// Whether the Ingress's `spec.tls` covers this host.
        tls: bool,
    },
    /// `spec.nodeName`.
    RunsOn,
    /// A claim's `spec.volumeName` or `spec.storageClassName`.
    Binds,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionEdge {
    pub from: ObjectRef,
    pub to: ObjectRef,
    pub relation: Relation,
}

/// Where a path into the subject stops, named.
///
/// The three are different repairs, and the third is the one every list page
/// in the app draws as healthy.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "reason", rename_all = "camelCase")]
pub enum ChainStop {
    /// An Ingress backend names a Service the API server does not have.
    BackendMissing {
        ingress: ObjectRef,
        service: ObjectRef,
    },
    /// A Service's selector matches no pod in its namespace.
    SelectsNothing {
        service: ObjectRef,
        selector: String,
    },
    /// The Service's pods exist and not one of them is ready, so it has no
    /// endpoints and the address refuses connections.
    NoneReady {
        service: ObjectRef,
        selector: String,
        pods: i32,
    },
}

/// One object's whole neighbourhood, in one answer.
///
/// Typed edges, not the reader's groups: "needs to run" and "runs on" are
/// questions a page asks, and grouping by them is the page's decision.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceConnections {
    pub subject: ObjectRef,
    pub edges: Vec<ConnectionEdge>,
    /// Where a path into the subject stops. Empty means every path this call
    /// followed reaches a ready pod.
    pub stops: Vec<ChainStop>,
    pub not_looked_at: Vec<UnexploredKind>,
}

/// A kind the app never queried, and what asking would have added.
///
/// An empty section that is simply not drawn reads as "there is none",
/// which is a claim this app cannot make about a kind it has never read.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnexploredKind {
    pub kind: String,
    pub why: String,
}

impl UnexploredKind {
    fn new(kind: &str, why: &str) -> Self {
        Self {
            kind: kind.to_string(),
            why: why.to_string(),
        }
    }

    /// The kinds a workload's neighbourhood would gain, and that the backend
    /// does not read.
    #[must_use]
    pub fn for_workload() -> Vec<Self> {
        vec![
            Self::new(
                "HorizontalPodAutoscaler",
                "the app does not read HorizontalPodAutoscalers, so it cannot say whether one scales this",
            ),
            Self::new(
                "PodDisruptionBudget",
                "the app does not read PodDisruptionBudgets, so it cannot say what protects this during a drain",
            ),
        ]
    }

    /// The kind that would replace pod-by-pod readiness with the endpoints
    /// the Service actually publishes.
    #[must_use]
    pub fn endpoint_slice() -> Self {
        Self::new(
            "EndpointSlice",
            "readiness here is each pod's own Ready condition; the app does not read EndpointSlices, which is what the Service publishes",
        )
    }
}

/// A selector matches when every label it names is on the object with that
/// value.
///
/// An empty selector matches nothing. That is the API server's own rule for
/// a Service — an ExternalName selects no pods, it does not select all of
/// them — and the opposite of what a plain subset test would answer.
#[must_use]
pub fn selector_matches(
    selector: &BTreeMap<String, String>,
    labels: &BTreeMap<String, String>,
) -> bool {
    !selector.is_empty() && selector.iter().all(|(k, v)| labels.get(k) == Some(v))
}

/// Every way a pod spec draws on one named object.
///
/// `target_kind` is `ConfigMap`, `Secret`, `PersistentVolumeClaim` or
/// `ServiceAccount`. Volumes are read through the same `volume_source` the
/// pod detail page uses, so a claim and a projected source count here exactly
/// as they do there — which is how a claim in use stopped reporting that
/// nothing uses it.
#[must_use]
pub fn usages_in_pod_spec(spec: &PodSpec, target_kind: &str, target_name: &str) -> Vec<Usage> {
    let mut usages = Vec::new();

    for volume in spec.volumes.iter().flatten() {
        let (source, refs) = volume_source(volume);
        if !refs
            .iter()
            .any(|r| r.kind == target_kind && r.name == target_name)
        {
            continue;
        }
        let projected = source == "projected";
        let mounts = mounts_of(spec, &volume.name);
        if mounts.is_empty() {
            usages.push(Usage::Unmounted {
                volume: volume.name.clone(),
                projected,
            });
            continue;
        }
        usages.extend(mounts.into_iter().map(|mount| Usage::Mount {
            container: mount.container,
            path: mount.path,
            read_only: mount.read_only,
            sub_path: mount.sub_path,
            volume: volume.name.clone(),
            projected,
        }));
    }

    let containers = spec
        .init_containers
        .iter()
        .flatten()
        .chain(&spec.containers);
    for container in containers {
        for env in container.env.iter().flatten() {
            let Some(from) = &env.value_from else {
                continue;
            };
            let key = match target_kind {
                "ConfigMap" => from
                    .config_map_key_ref
                    .as_ref()
                    .filter(|r| r.name == target_name)
                    .map(|r| r.key.clone()),
                "Secret" => from
                    .secret_key_ref
                    .as_ref()
                    .filter(|r| r.name == target_name)
                    .map(|r| r.key.clone()),
                _ => None,
            };
            if let Some(key) = key {
                usages.push(Usage::Env {
                    container: container.name.clone(),
                    name: env.name.clone(),
                    key,
                });
            }
        }

        for env_from in container.env_from.iter().flatten() {
            let matches = match target_kind {
                "ConfigMap" => env_from
                    .config_map_ref
                    .as_ref()
                    .is_some_and(|r| r.name == target_name),
                "Secret" => env_from
                    .secret_ref
                    .as_ref()
                    .is_some_and(|r| r.name == target_name),
                _ => false,
            };
            if matches {
                usages.push(Usage::EnvFrom {
                    container: container.name.clone(),
                });
            }
        }
    }

    if target_kind == "Secret"
        && spec
            .image_pull_secrets
            .iter()
            .flatten()
            .any(|s| s.name == target_name)
    {
        usages.push(Usage::ImagePullSecret);
    }

    if target_kind == "ServiceAccount" && spec.service_account_name.as_deref() == Some(target_name)
    {
        usages.push(Usage::Identity);
    }

    usages
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::api::core::v1::{
        ConfigMapKeySelector, ConfigMapVolumeSource, Container, EnvVar, EnvVarSource,
        PersistentVolumeClaimVolumeSource, Volume, VolumeMount,
    };

    fn labels(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    #[test]
    fn an_empty_selector_matches_nothing() {
        assert!(!selector_matches(
            &BTreeMap::new(),
            &labels(&[("app", "log-demo")])
        ));
    }

    #[test]
    fn a_selector_matches_only_when_every_label_agrees() {
        let pod = labels(&[("app", "log-demo"), ("pod-template-hash", "abc")]);
        assert!(selector_matches(&labels(&[("app", "log-demo")]), &pod));
        assert!(!selector_matches(&labels(&[("app", "other")]), &pod));
        assert!(!selector_matches(
            &labels(&[("app", "log-demo"), ("tier", "web")]),
            &pod
        ));
    }

    fn spec_with_claim() -> PodSpec {
        PodSpec {
            volumes: Some(vec![Volume {
                name: "data".to_string(),
                persistent_volume_claim: Some(PersistentVolumeClaimVolumeSource {
                    claim_name: "pvc-demo".to_string(),
                    read_only: None,
                }),
                ..Default::default()
            }]),
            containers: vec![Container {
                name: "app".to_string(),
                volume_mounts: Some(vec![VolumeMount {
                    name: "data".to_string(),
                    mount_path: "/var/lib/data".to_string(),
                    ..Default::default()
                }]),
                ..Default::default()
            }],
            ..Default::default()
        }
    }

    #[test]
    fn a_claim_in_use_reports_the_container_that_mounts_it() {
        let usages = usages_in_pod_spec(&spec_with_claim(), "PersistentVolumeClaim", "pvc-demo");
        assert_eq!(
            usages,
            vec![Usage::Mount {
                container: "app".to_string(),
                path: "/var/lib/data".to_string(),
                read_only: false,
                sub_path: None,
                volume: "data".to_string(),
                projected: false,
            }]
        );
    }

    #[test]
    fn a_volume_nothing_mounts_is_still_a_use() {
        let mut spec = spec_with_claim();
        spec.containers[0].volume_mounts = None;
        let usages = usages_in_pod_spec(&spec, "PersistentVolumeClaim", "pvc-demo");
        assert_eq!(
            usages,
            vec![Usage::Unmounted {
                volume: "data".to_string(),
                projected: false,
            }]
        );
    }

    #[test]
    fn an_env_var_reports_the_key_it_reads() {
        let spec = PodSpec {
            volumes: Some(vec![Volume {
                name: "app-config".to_string(),
                config_map: Some(ConfigMapVolumeSource {
                    name: "demo-config".to_string(),
                    ..Default::default()
                }),
                ..Default::default()
            }]),
            containers: vec![Container {
                name: "app".to_string(),
                env: Some(vec![EnvVar {
                    name: "APP_MESSAGE".to_string(),
                    value_from: Some(EnvVarSource {
                        config_map_key_ref: Some(ConfigMapKeySelector {
                            name: "demo-config".to_string(),
                            key: "app.conf".to_string(),
                            optional: None,
                        }),
                        ..Default::default()
                    }),
                    ..Default::default()
                }]),
                volume_mounts: Some(vec![VolumeMount {
                    name: "app-config".to_string(),
                    mount_path: "/etc/app".to_string(),
                    read_only: Some(true),
                    ..Default::default()
                }]),
                ..Default::default()
            }],
            ..Default::default()
        };

        let usages = usages_in_pod_spec(&spec, "ConfigMap", "demo-config");
        assert_eq!(
            usages,
            vec![
                Usage::Mount {
                    container: "app".to_string(),
                    path: "/etc/app".to_string(),
                    read_only: true,
                    sub_path: None,
                    volume: "app-config".to_string(),
                    projected: false,
                },
                Usage::Env {
                    container: "app".to_string(),
                    name: "APP_MESSAGE".to_string(),
                    key: "app.conf".to_string(),
                }
            ]
        );
    }

    #[test]
    fn the_wire_names_stay_camel_case_inside_the_variants() {
        let json = serde_json::to_value(Usage::Mount {
            container: "app".to_string(),
            path: "/etc/app".to_string(),
            read_only: true,
            sub_path: Some("app.conf".to_string()),
            volume: "app-config".to_string(),
            projected: false,
        })
        .expect("serialize");
        assert_eq!(json["how"], "mount");
        assert_eq!(json["readOnly"], true);
        assert_eq!(json["subPath"], "app.conf");
    }
}
