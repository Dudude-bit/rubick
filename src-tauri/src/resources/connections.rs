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

use chrono::{DateTime, Utc};
use k8s_openapi::api::core::v1::PodSpec;
use serde::{Deserialize, Serialize};

use super::published::ServicePublished;
use super::types::{mounts_of, volume_source, ConditionInfo, ServicePortInfo};

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
    /// claim's `PersistentVolume` is not in the claim's.
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
        /// — an `ExternalName`, or one whose endpoints are kept by hand.
        selector: Option<String>,
        ports: Vec<ServicePortInfo>,
    },
    Ingress {
        #[serde(rename = "className")]
        class_name: Option<String>,
    },
    /// A Gateway API Gateway, by the claim that decides whose it is.
    Gateway {
        #[serde(rename = "className")]
        class_name: String,
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
    /// A Node, in the terms the pods on it are read against.
    ///
    /// What the scheduler may hand out rather than what is installed:
    /// `status.allocatable` is the number a pod is placed against, and
    /// `capacity` is the machine's own claim with the kubelet's reservations
    /// still in it.
    Node {
        /// `spec.unschedulable` inverted — a cordoned node is where a drain
        /// leaves one, and it is why nothing new arrives here.
        schedulable: bool,
        /// `status.allocatable.pods`. `None` where the node states none,
        /// which is not the same as a limit of zero.
        #[serde(rename = "podCapacity")]
        pod_capacity: Option<i32>,
        cpu: Option<String>,
        /// As the node writes it — `16305236Ki` — and formatted where it is
        /// read, the same as every other quantity in this app.
        memory: Option<String>,
    },
    /// A `HorizontalPodAutoscaler`, in the terms the workload it scales needs.
    ///
    /// The whole status travels, conditions included, because the finding
    /// worth the read is a condition rather than a number:
    /// `ScalingLimited=True` says the autoscaler wants more replicas than
    /// `maxReplicas` allows, and both replica counts read as the healthy
    /// steady state while it does.
    Autoscaler {
        /// `spec.minReplicas` defaults to 1 when it is left out.
        #[serde(rename = "minReplicas")]
        min_replicas: i32,
        #[serde(rename = "maxReplicas")]
        max_replicas: i32,
        #[serde(rename = "currentReplicas")]
        current_replicas: i32,
        #[serde(rename = "desiredReplicas")]
        desired_replicas: i32,
        metrics: Vec<AutoscalerMetric>,
        conditions: Vec<ConditionInfo>,
        #[serde(rename = "lastScaleTime")]
        last_scale_time: Option<DateTime<Utc>>,
    },
    /// A `PodDisruptionBudget`, and how much room it is leaving right now.
    Budget {
        /// As written, `Some("1")` or `Some("50%")`. Exactly one of the two
        /// is set on any budget the API server accepted.
        #[serde(rename = "minAvailable")]
        min_available: Option<String>,
        #[serde(rename = "maxUnavailable")]
        max_unavailable: Option<String>,
        /// How many pods may be evicted right now. Zero blocks a drain.
        #[serde(rename = "disruptionsAllowed")]
        disruptions_allowed: i32,
        #[serde(rename = "currentHealthy")]
        current_healthy: i32,
        #[serde(rename = "desiredHealthy")]
        desired_healthy: i32,
        #[serde(rename = "expectedPods")]
        expected_pods: i32,
        conditions: Vec<ConditionInfo>,
    },
}

/// One thing an autoscaler watches, with the reading against the target.
///
/// Spec and status are paired here rather than shipped as two lists: the
/// pairing is what makes the pair readable — "cpu 210% of 50%" — and an
/// unpaired `current` is exactly the state that has to be drawn as an
/// absence rather than as a zero.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoscalerMetric {
    /// `cpu`, `memory`, or the custom metric's own name.
    pub name: String,
    /// Which of the five metric shapes it is: `resource`,
    /// `containerResource`, `pods`, `object` or `external`.
    pub source: String,
    /// The target as the spec states it — `50%` for a utilisation target,
    /// a bare quantity otherwise.
    pub target: String,
    /// The reading, or `None` where the autoscaler has published none. An
    /// HPA that cannot reach its metrics publishes nothing at all, and a
    /// zero there would be a reading it never took.
    pub current: Option<String>,
}

/// How a pod spec draws on a `ConfigMap`, a Secret, a claim or an identity.
///
/// The phrasing the reader sees — "mounted at /etc/app, and `APP_MESSAGE`
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
    /// A Gateway API route rule's `backendRefs[]` names a Service.
    ///
    /// The Gateway API cousin of [`Relation::Routes`], carrying the route's
    /// own vocabulary: hostnames rather than one host, and a weight because
    /// `0` is a backend deliberately taken out of traffic — configuration,
    /// not an outage.
    RuleRoutes {
        hostnames: Vec<String>,
        /// The backend port the rule sends to, where it names one.
        port: Option<String>,
        weight: Option<i32>,
    },
    /// A route's `parentRefs[]` names a Gateway.
    ///
    /// Stated by the route — the Gateway consents through the route's
    /// `Accepted` condition, and the refusal is a [`ChainStop`], not this
    /// edge's business.
    AttachesTo {
        #[serde(rename = "sectionName")]
        section_name: Option<String>,
    },
    /// `spec.nodeName`.
    RunsOn,
    /// A claim's `spec.volumeName` or `spec.storageClassName`.
    Binds,
    /// `from` acts on `to` of its own accord — an autoscaler whose
    /// `scaleTargetRef` names it, a `PodDisruptionBudget` whose selector
    /// matches its pods.
    ///
    /// A verb of its own rather than `Selects` or `Uses`, and the direction
    /// of consent is why. Every other verb here is stated by the object that
    /// wants something: a pod spec names the `ConfigMap` it needs, a claim
    /// names its class. These two are stated *about* an object, by a third
    /// one, and nothing on the governed side records that it happened — a
    /// Deployment's YAML says nothing about the HPA that overwrites its
    /// `spec.replicas` fifteen seconds after you set it. Filing that under
    /// `Selects` would put a `PodDisruptionBudget` in the same group as the
    /// Service that routes traffic, which answers a different question.
    Governs {
        /// The selector that matched, where the edge came from one. `None`
        /// where the governor names its target outright, as an HPA does.
        selector: Option<String>,
    },
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
/// The four are different repairs, and the last two are the ones every list
/// page in the app draws as healthy.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "reason", rename_all = "camelCase")]
pub enum ChainStop {
    /// An Ingress backend names a Service the API server does not have.
    BackendMissing {
        ingress: ObjectRef,
        service: ObjectRef,
    },
    /// A route's controller wrote `Accepted: False` for this parent — the
    /// Gateway is refusing the route, in the cluster's own words
    /// (`NoMatchingListenerHostname`, `NotAllowedByListeners`, …).
    RouteNotAccepted {
        route: ObjectRef,
        gateway: ObjectRef,
        /// The condition's own `reason` — named apart because this enum's
        /// serde tag already spends the word.
        #[serde(rename = "conditionReason")]
        condition_reason: Option<String>,
        message: Option<String>,
    },
    /// A route's controller wrote `ResolvedRefs: False` — a reference it
    /// refused or could not resolve. `RefNotPermitted` is the
    /// missing-ReferenceGrant spelling, and the spec obliges the
    /// implementation to fail the affected traffic, so this is a stop and
    /// not a footnote.
    RouteRefsUnresolved {
        route: ObjectRef,
        #[serde(rename = "conditionReason")]
        condition_reason: Option<String>,
        message: Option<String>,
    },
    /// A `parentRefs[]` entry of kind Gateway names one the API server does
    /// not have. No controller will ever write status for that parent —
    /// this is the structurally silent case, detected by lookup because
    /// nothing else will say it.
    GatewayMissing {
        route: ObjectRef,
        gateway: ObjectRef,
    },
    /// A Service's selector matches no pod in its namespace.
    ///
    /// Only a reader that listed the pods may say this. A reader holding the
    /// endpoints alone must say [`ChainStop::PublishesNothingYet`] instead:
    /// a pod that is Pending, unscheduled or still creating carries the
    /// selector and has no address, so it writes no endpoint — and "no pod
    /// carries this selector" sends the reader to check their labels for a
    /// problem that is in the scheduler.
    SelectsNothing {
        service: ObjectRef,
        selector: String,
    },
    /// The Service publishes no endpoint, and this reader cannot say why.
    ///
    /// The honest stop for a surface built from the endpoints alone. It knows
    /// nothing arrives; it does not know whether that is a selector matching
    /// nothing or pods that have not got an address yet.
    PublishesNothingYet {
        service: ObjectRef,
        selector: String,
    },
    /// The Service's pods exist and not one of them is ready, so nothing it
    /// publishes takes traffic and the address refuses connections.
    ///
    /// Judged on what the slices publish rather than on each pod's own
    /// condition, which is the difference between a restart and an outage: a
    /// pod draining with `serving: true, ready: false` is not ready and is
    /// still the address kube-proxy sends to.
    NoneReady {
        service: ObjectRef,
        selector: String,
        pods: i32,
    },
    /// Ready pods match the selector and the Service publishes not one
    /// address:port pair — the case with a healthy selector, healthy pods, a
    /// green everything and no traffic at all.
    PublishesNothing {
        service: ObjectRef,
        selector: String,
        /// Pods the selector matches, and how many of them are Ready.
        pods: i32,
        #[serde(rename = "readyPods")]
        ready_pods: i32,
        /// The `targetPort` names no matching container declares. Empty where
        /// the app cannot say why, and it then says only that it cannot.
        #[serde(rename = "unnamedPorts")]
        unnamed_ports: Vec<String>,
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
    /// followed reaches something the Service publishes.
    pub stops: Vec<ChainStop>,
    /// What each Service in this answer publishes, as its own `EndpointSlices`
    /// state it. One entry per Service the call touched; the endpoint rows
    /// and the second list are filled only for a Service the reader opened,
    /// because a chain hop elsewhere needs a count and one name.
    pub published: Vec<ServicePublished>,
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
    pub why: Unread,
}

/// Why a kind went unread, named rather than written.
///
/// The sentence belongs to the reader's language and this runs before the
/// backend knows what that is. `Unanswered` carries the API server's own
/// refusal inside it — that half stays exactly as the cluster wrote it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "says", rename_all = "camelCase")]
pub enum Unread {
    /// The app asked for this version and got no usable answer.
    Unanswered { version: String, said: String },
    /// The claims held by the pods on a node — one list per namespace, not
    /// made here.
    NodeClaimsNotRead,
    /// What mounts a volume's claim — one list in the claim's namespace,
    /// which is the claim's own page.
    VolumeMountsNotRead,
}

impl UnexploredKind {
    fn new(kind: &str, why: Unread) -> Self {
        Self {
            kind: kind.to_string(),
            why,
        }
    }

    /// A kind this call did ask for and got no answer to.
    ///
    /// Different from a kind nobody ever queried, and drawn in the same
    /// group for the same reason: an autoscaler list that 404s on a cluster
    /// serving only `autoscaling/v2beta2`, or that RBAC refuses, must not
    /// come back as "nothing scales this". The app asked; it has no answer.
    #[must_use]
    pub fn unanswered(kind: &str, version: &str, why: &str) -> Self {
        Self::new(
            kind,
            Unread::Unanswered {
                version: version.to_string(),
                said: why.to_string(),
            },
        )
    }

    /// What a workload's neighbourhood still cannot answer once the two
    /// governing kinds have been read, given the reason each read failed.
    ///
    /// Empty for both `None`, and that is the point of the function: the app
    /// reads both kinds now, and a row still saying "the app does not read
    /// `HorizontalPodAutoscalers`" would be a worse lie than the gap it
    /// replaced.
    #[must_use]
    pub fn governance(autoscalers: Option<&str>, budgets: Option<&str>) -> Vec<Self> {
        [
            autoscalers
                .map(|why| Self::unanswered("HorizontalPodAutoscaler", "autoscaling/v2", why)),
            budgets.map(|why| Self::unanswered("PodDisruptionBudget", "policy/v1", why)),
        ]
        .into_iter()
        .flatten()
        .collect()
    }

    /// What a Node's neighbourhood still cannot say, once its pods and every
    /// namespace's budgets have been read.
    ///
    /// The claims are the gap a drain feels. A `ReadWriteOnce` volume has to
    /// detach from this node before the replacement pod starts anywhere else,
    /// and that detach is where a drain spends its time — but the claims of
    /// the pods here are one list per namespace with a pod on this node, and
    /// the app does not make it. A "Bound to" group that is simply absent
    /// would read as "these pods hold no volumes".
    #[must_use]
    pub fn on_a_node(budgets: Option<&str>) -> Vec<Self> {
        let mut unread = Self::governance(None, budgets);
        unread.push(Self::new(
            "PersistentVolumeClaim",
            Unread::NodeClaimsNotRead,
        ));
        unread
    }

    /// The same, for a `PersistentVolume`: its claim is read, and what mounts
    /// that claim is not.
    ///
    /// "Is anything still writing to this volume" is the question asked
    /// before a volume is released, and the answer is one list in the claim's
    /// namespace — which is the claim's own page, one click away, rather than
    /// a read made here on every open.
    #[must_use]
    pub fn on_a_volume() -> Vec<Self> {
        vec![Self::new("Pod", Unread::VolumeMountsNotRead)]
    }
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

    /// The gap this feature closed. Both kinds are read, so neither may be
    /// named as unread — a page that says "the app does not read
    /// `HorizontalPodAutoscalers`" beside a block drawn from one is worse than
    /// the honest gap it replaced.
    #[test]
    fn a_kind_the_app_now_reads_is_not_listed_as_unread() {
        let unread = UnexploredKind::governance(None, None);
        assert!(
            unread.is_empty(),
            "both governing kinds are read, so nothing is left unasked: {:?}",
            unread.iter().map(|k| &k.kind).collect::<Vec<_>>()
        );
    }

    /// The same rule, for the kind this feature turned from a to-do into a
    /// read one. Nothing may name `EndpointSlice` as unread now that the
    /// Service's own bookkeeping is what the chain's last hop is built from.
    #[test]
    fn the_kind_that_became_read_is_never_named_as_unread() {
        let named: Vec<String> = UnexploredKind::governance(Some("404"), Some("403"))
            .into_iter()
            .map(|kind| kind.kind)
            .collect();
        assert!(
            !named.iter().any(|kind| kind == "EndpointSlice"),
            "EndpointSlices are read; naming them unread is worse than the gap: {named:?}"
        );
    }

    /// The other half: a read that failed is not silence. A cluster serving
    /// only `autoscaling/v2beta2` answers the v2 list with a 404, and "no
    /// autoscaler scales this" is not what that means.
    #[test]
    fn a_read_that_failed_says_so_rather_than_claiming_there_is_none() {
        let unread = UnexploredKind::governance(Some("404 Not Found"), None);
        assert_eq!(unread.len(), 1);
        assert_eq!(unread[0].kind, "HorizontalPodAutoscaler");
        assert_eq!(
            unread[0].why,
            Unread::Unanswered {
                version: "autoscaling/v2".to_string(),
                said: "404 Not Found".to_string(),
            }
        );
    }

    #[test]
    fn a_governing_edge_states_which_selector_matched() {
        let json = serde_json::to_value(Relation::Governs {
            selector: Some("app=log-demo".to_string()),
        })
        .expect("serialize");
        assert_eq!(json["verb"], "governs");
        assert_eq!(json["selector"], "app=log-demo");

        let named = serde_json::to_value(Relation::Governs { selector: None }).expect("serialize");
        assert_eq!(named["selector"], serde_json::Value::Null);
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
