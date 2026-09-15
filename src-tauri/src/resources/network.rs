//! Network resource types

use k8s_openapi::api::core::v1::Endpoints;
use k8s_openapi::api::networking::v1::{
    Ingress, IngressBackend, NetworkPolicyPeer, NetworkPolicyPort,
};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::LabelSelector;
use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
use kube::ResourceExt;
use serde::{Deserialize, Serialize};

use super::selector::Selector;
use super::OptionTimeExt;

/// Information about an Ingress rule path
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngressPath {
    pub path: String,
    pub path_type: String,
    pub backend_service: String,
    pub backend_port: String,
    /// Resource backend (e.g., "StorageBucket/my-bucket") if service backend is not used
    pub resource_backend: Option<String>,
}

/// Information about an Ingress rule
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngressRule {
    pub host: String,
    pub paths: Vec<IngressPath>,
}

/// Information about an Ingress TLS configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngressTlsConfig {
    pub hosts: Vec<String>,
    pub secret_name: Option<String>,
    pub is_catch_all: bool,
}

/// The Ingress's `spec.defaultBackend`, where one is set.
///
/// A defaultBackend-only Ingress is how a cloud load balancer fronts an
/// in-cluster proxy — no `rules` at all, everything to one Service. Read
/// only through `rules`, such an Ingress looks like it serves nothing,
/// which is how two routing pages came to call an edge-terminated cluster
/// "served in the clear" on every host.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngressDefaultBackend {
    pub backend_service: String,
    pub backend_port: String,
    /// `Kind/name` where it routes to an API object rather than a Service.
    pub resource_backend: Option<String>,
}

/// Information about an Ingress
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngressInfo {
    pub name: String,
    pub namespace: String,
    pub class_name: Option<String>,
    pub rules: Vec<IngressRule>,
    pub default_backend: Option<IngressDefaultBackend>,
    pub load_balancer_ips: Vec<String>,
    pub tls_hosts: Vec<String>,
    pub tls_configs: Vec<IngressTlsConfig>,
    pub has_catch_all_tls: bool,
    pub labels: std::collections::BTreeMap<String, String>,
    pub annotations: std::collections::BTreeMap<String, String>,
    pub created_at: Option<String>,
}

/// A backend's three spellings, shared by `rules[].paths[]` and
/// `spec.defaultBackend` — the same `IngressBackend` object in both places.
fn read_backend(backend: &IngressBackend) -> (String, String, Option<String>) {
    let resource_backend = backend
        .resource
        .as_ref()
        .map(|r| format!("{}/{}", r.kind, r.name));

    let backend_service = backend
        .service
        .as_ref()
        .map_or_else(String::new, |s| s.name.clone());

    let backend_port = backend
        .service
        .as_ref()
        .and_then(|s| s.port.as_ref())
        .map_or_else(
            || "?".to_string(),
            |p| {
                p.name
                    .clone()
                    .unwrap_or_else(|| p.number.map_or_else(|| "?".to_string(), |n| n.to_string()))
            },
        );

    (backend_service, backend_port, resource_backend)
}

impl From<&Ingress> for IngressInfo {
    fn from(ingress: &Ingress) -> Self {
        let spec = ingress.spec.as_ref();
        let status = ingress.status.as_ref();

        // Parse rules
        let rules = spec
            .and_then(|s| s.rules.as_ref())
            .map(|spec_rules| {
                spec_rules
                    .iter()
                    .map(|rule| {
                        let host = rule.host.clone().unwrap_or_else(|| "*".to_string());
                        let paths = rule
                            .http
                            .as_ref()
                            .map(|http| {
                                http.paths
                                    .iter()
                                    .map(|path| {
                                        let (backend_service, backend_port, resource_backend) =
                                            read_backend(&path.backend);

                                        IngressPath {
                                            path: path
                                                .path
                                                .clone()
                                                .unwrap_or_else(|| "/".to_string()),
                                            path_type: path.path_type.clone(),
                                            backend_service,
                                            backend_port,
                                            resource_backend,
                                        }
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();

                        IngressRule { host, paths }
                    })
                    .collect()
            })
            .unwrap_or_default();

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

        let tls_hosts = spec
            .and_then(|s| s.tls.as_ref())
            .map(|tls_list| {
                tls_list
                    .iter()
                    .flat_map(|tls| tls.hosts.clone().unwrap_or_default())
                    .collect()
            })
            .unwrap_or_default();

        // Parse TLS configs with secret names
        let tls_configs: Vec<IngressTlsConfig> = spec
            .and_then(|s| s.tls.as_ref())
            .map(|tls_list| {
                tls_list
                    .iter()
                    .map(|tls| {
                        let hosts = tls.hosts.clone().unwrap_or_default();
                        let is_catch_all = hosts.is_empty();
                        IngressTlsConfig {
                            hosts,
                            secret_name: tls.secret_name.clone(),
                            is_catch_all,
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();

        let has_catch_all_tls = tls_configs.iter().any(|c| c.is_catch_all);

        let default_backend = spec
            .and_then(|s| s.default_backend.as_ref())
            .map(|backend| {
                let (backend_service, backend_port, resource_backend) = read_backend(backend);
                IngressDefaultBackend {
                    backend_service,
                    backend_port,
                    resource_backend,
                }
            });

        // Extract labels and annotations
        let labels = ingress.metadata.labels.clone().unwrap_or_default();
        let annotations = ingress.metadata.annotations.clone().unwrap_or_default();

        Self {
            name: ingress.name_any(),
            namespace: ingress.namespace().unwrap_or_default(),
            class_name: spec.and_then(|s| s.ingress_class_name.clone()),
            rules,
            default_backend,
            load_balancer_ips,
            tls_hosts,
            tls_configs,
            has_catch_all_tls,
            labels,
            annotations,
            created_at: ingress
                .metadata
                .creation_timestamp
                .as_ref()
                .to_rfc3339_opt(),
        }
    }
}

/// Target reference for an endpoint address
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointTargetRef {
    pub kind: String,
    pub name: String,
    pub namespace: String,
}

/// Address in an endpoint subset
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointAddress {
    pub ip: String,
    pub hostname: Option<String>,
    pub node_name: Option<String>,
    pub target_ref: Option<EndpointTargetRef>,
}

/// Port in an endpoint subset
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointPort {
    pub name: Option<String>,
    pub port: i32,
    pub protocol: String,
}

/// Subset of endpoints
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointSubset {
    pub addresses: Vec<EndpointAddress>,
    pub not_ready_addresses: Vec<EndpointAddress>,
    pub ports: Vec<EndpointPort>,
}

/// Information about Endpoints
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointsInfo {
    pub name: String,
    pub namespace: String,
    pub subsets: Vec<EndpointSubset>,
    pub created_at: Option<String>,
    /// The control plane's own admission that it dropped addresses from this
    /// object. It holds 1000 and stops, so past that the list below is not
    /// the answer and a page drawing it as one is showing 1000 of however
    /// many there really are.
    pub over_capacity: bool,
}

impl From<&Endpoints> for EndpointsInfo {
    fn from(ep: &Endpoints) -> Self {
        let name = ep.name_any();
        let ns = ep.namespace().unwrap_or_default();
        let created_at = ep.metadata.creation_timestamp.as_ref().to_rfc3339_opt();

        let subsets = ep
            .subsets
            .clone() // Endpoints subsets are already structured, but we need to map to our structs
            .unwrap_or_default()
            .into_iter()
            .map(|subset| {
                let addresses = subset
                    .addresses
                    .unwrap_or_default()
                    .iter()
                    .map(|addr| EndpointAddress {
                        ip: addr.ip.clone(),
                        hostname: addr.hostname.clone(),
                        node_name: addr.node_name.clone(),
                        target_ref: addr.target_ref.as_ref().map(|tr| EndpointTargetRef {
                            kind: tr.kind.clone().unwrap_or_default(),
                            name: tr.name.clone().unwrap_or_default(),
                            namespace: tr.namespace.clone().unwrap_or_default(),
                        }),
                    })
                    .collect();

                let not_ready_addresses = subset
                    .not_ready_addresses
                    .unwrap_or_default()
                    .iter()
                    .map(|addr| EndpointAddress {
                        ip: addr.ip.clone(),
                        hostname: addr.hostname.clone(),
                        node_name: addr.node_name.clone(),
                        target_ref: addr.target_ref.as_ref().map(|tr| EndpointTargetRef {
                            kind: tr.kind.clone().unwrap_or_default(),
                            name: tr.name.clone().unwrap_or_default(),
                            namespace: tr.namespace.clone().unwrap_or_default(),
                        }),
                    })
                    .collect();

                let ports = subset
                    .ports
                    .unwrap_or_default()
                    .iter()
                    .map(|port| EndpointPort {
                        name: port.name.clone(),
                        port: port.port,
                        protocol: port.protocol.clone().unwrap_or_else(|| "TCP".to_string()),
                    })
                    .collect();

                EndpointSubset {
                    addresses,
                    not_ready_addresses,
                    ports,
                }
            })
            .collect();

        Self {
            name,
            namespace: ns,
            subsets,
            created_at,
            over_capacity: super::published::legacy_over_capacity(ep),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::api::networking::v1::{
        IngressBackend, IngressServiceBackend, IngressSpec, ServiceBackendPort,
    };
    use kube::core::ObjectMeta;

    fn ingress_with_default_backend() -> Ingress {
        Ingress {
            metadata: ObjectMeta {
                name: Some("traefik-ingress".into()),
                namespace: Some("traefik".into()),
                ..Default::default()
            },
            spec: Some(IngressSpec {
                default_backend: Some(IngressBackend {
                    service: Some(IngressServiceBackend {
                        name: "traefik".into(),
                        port: Some(ServiceBackendPort {
                            number: Some(80),
                            ..Default::default()
                        }),
                    }),
                    resource: None,
                }),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    #[test]
    fn default_backend_is_read() {
        let info = IngressInfo::from(&ingress_with_default_backend());
        let backend = info.default_backend.expect("spec.defaultBackend was set");
        assert_eq!(backend.backend_service, "traefik");
        assert_eq!(backend.backend_port, "80");
        assert_eq!(backend.resource_backend, None);
    }

    #[test]
    fn missing_default_backend_is_none() {
        assert!(IngressInfo::from(&Ingress::default())
            .default_backend
            .is_none());
    }
}

/// One peer a rule names, with the two selectors kept apart.
///
/// The single most misread thing in a `NetworkPolicy`: `podSelector` and
/// `namespaceSelector` **inside one list element** are an AND — those pods,
/// in those namespaces — and as **separate elements** they are an OR. A
/// renderer that flattens the list into one set of selectors turns a narrow
/// rule into a wide one, in the direction that opens the cluster.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PolicyPeer {
    pub pods: PolicySelects,
    /// Absent means this policy's own namespace, and empty means every
    /// namespace in the cluster. The same three states, and the same gap
    /// between them.
    pub namespaces: PolicySelects,
    pub ip_block: Option<PolicyIpBlock>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PolicyIpBlock {
    pub cidr: String,
    pub except: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PolicyPort {
    /// Written by the API server, which defaults it to TCP on the way in.
    pub protocol: String,
    /// A number or a named port, and `None` for a rule that names no port —
    /// which is every port, not none of them.
    pub port: Option<String>,
    pub end_port: Option<i32>,
}

/// One entry of `ingress` or `egress`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PolicyRule {
    /// Empty means the rule named no peers, which allows every source.
    pub peers: Vec<PolicyPeer>,
    /// Empty means the rule named no ports, which allows all of them.
    pub ports: Vec<PolicyPort>,
}

/// What a policy does in one direction.
///
/// Three states, not two, and the one people are caught by is the third.
/// A policy that *governs* a direction and lists no rules for it denies
/// everything in that direction; a rule that lists no peers allows
/// everything. The two are one character apart in YAML — `ingress: []`
/// against `ingress: [{}]` — and they are opposites.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PolicyDirection {
    /// Whether `policyTypes` names this direction at all. Where it does not,
    /// the policy says nothing about it and some other policy may.
    pub governed: bool,
    pub rules: Vec<PolicyRule>,
    /// Some rule names no peers: everything is allowed this way.
    pub opens_to_everything: bool,
    /// Governed, with no rules at all: nothing is allowed this way.
    pub denies_everything: bool,
}

/// What the policy picks, in the three shapes a `podSelector` comes in.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PolicySelects {
    /// An empty selector. Every pod in scope, which is the widest thing a
    /// `NetworkPolicy` can say and must never draw as a blank cell.
    Everything,
    /// The query as `metav1.LabelSelectorAsSelector` writes it. The
    /// cluster's own words, so they are shipped rather than composed.
    Written { query: String },
    /// The field was not on the object. Not everything, and not nothing.
    NotSaid,
}

impl PolicySelects {
    fn read(selector: Option<&LabelSelector>) -> Self {
        match Selector::Query(selector).query_text() {
            None => Self::NotSaid,
            Some(query) if query.is_empty() => Self::Everything,
            Some(query) => Self::Written { query },
        }
    }
}

/// A `networking.k8s.io/v1` `NetworkPolicy`, read as what it does.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkPolicyInfo {
    pub name: String,
    pub namespace: String,
    pub selects: PolicySelects,
    /// How many pods in scope it actually picks, and `None` where the pods
    /// were not read. A policy that selects nothing protects nothing, and no
    /// other screen in this app says so.
    pub selected: Option<usize>,
    pub ingress: PolicyDirection,
    pub egress: PolicyDirection,
    pub labels: std::collections::BTreeMap<String, String>,
    pub created_at: Option<String>,
}

fn direction_of(
    policy_types: Option<&Vec<String>>,
    which: &str,
    rules: Option<Vec<PolicyRule>>,
    written: bool,
) -> PolicyDirection {
    // Absent `policyTypes` is not "neither": the API server fills it in from
    // the rules that are present, and ingress is always one of them.
    let governed = match policy_types {
        Some(types) => types.iter().any(|t| t == which),
        None => which == "Ingress" || written,
    };
    let rules = rules.unwrap_or_default();
    PolicyDirection {
        governed,
        opens_to_everything: rules.iter().any(|rule| rule.peers.is_empty()),
        denies_everything: governed && rules.is_empty(),
        rules,
    }
}

fn port_of(port: &NetworkPolicyPort) -> PolicyPort {
    PolicyPort {
        protocol: port.protocol.clone().unwrap_or_else(|| "TCP".to_string()),
        port: port.port.as_ref().map(|value| match value {
            IntOrString::Int(number) => number.to_string(),
            IntOrString::String(name) => name.clone(),
        }),
        end_port: port.end_port,
    }
}

fn peer_of(peer: &NetworkPolicyPeer) -> PolicyPeer {
    PolicyPeer {
        pods: PolicySelects::read(peer.pod_selector.as_ref()),
        namespaces: PolicySelects::read(peer.namespace_selector.as_ref()),
        ip_block: peer.ip_block.as_ref().map(|block| PolicyIpBlock {
            cidr: block.cidr.clone(),
            except: block.except.clone().unwrap_or_default(),
        }),
    }
}

impl From<&k8s_openapi::api::networking::v1::NetworkPolicy> for NetworkPolicyInfo {
    fn from(policy: &k8s_openapi::api::networking::v1::NetworkPolicy) -> Self {
        let spec = policy.spec.as_ref();
        let ingress = spec.and_then(|s| s.ingress.as_ref()).map(|rules| {
            rules
                .iter()
                .map(|rule| PolicyRule {
                    peers: rule.from.iter().flatten().map(peer_of).collect(),
                    ports: rule.ports.iter().flatten().map(port_of).collect(),
                })
                .collect::<Vec<_>>()
        });
        let egress = spec.and_then(|s| s.egress.as_ref()).map(|rules| {
            rules
                .iter()
                .map(|rule| PolicyRule {
                    peers: rule.to.iter().flatten().map(peer_of).collect(),
                    ports: rule.ports.iter().flatten().map(port_of).collect(),
                })
                .collect::<Vec<_>>()
        });
        let types = spec.and_then(|s| s.policy_types.as_ref());
        let (wrote_in, wrote_out) = (ingress.is_some(), egress.is_some());

        Self {
            name: policy.name_any(),
            namespace: policy.namespace().unwrap_or_default(),
            selects: PolicySelects::read(spec.and_then(|s| s.pod_selector.as_ref())),
            selected: None,
            ingress: direction_of(types, "Ingress", ingress, wrote_in),
            egress: direction_of(types, "Egress", egress, wrote_out),
            labels: policy.labels().clone(),
            created_at: policy.metadata.creation_timestamp.as_ref().to_rfc3339_opt(),
        }
    }
}

/// Every policy in a list, joined to the pods that were read for the scope.
///
/// `pods: None` is a pod list this reader was refused, and it leaves every
/// count `None` rather than zero. Zero is the finding the page exists for —
/// a policy in front of nothing — and handing it to somebody who merely
/// lacks `list pods` would invent it. The two live one `Option` apart, which
/// is why the join is one function rather than a line in each caller.
#[must_use]
pub fn joined_to_pods(
    policies: &[k8s_openapi::api::networking::v1::NetworkPolicy],
    pods: Option<&[k8s_openapi::api::core::v1::Pod]>,
) -> Vec<NetworkPolicyInfo> {
    policies
        .iter()
        .map(|policy| {
            let mut info = NetworkPolicyInfo::from(policy);
            let selector = policy.spec.as_ref().and_then(|s| s.pod_selector.as_ref());
            info.selected = pods.map(|pods| {
                pods.iter()
                    // A policy only ever acts in its own namespace, and a
                    // cluster-wide pod list carries every other one's.
                    .filter(|pod| pod.namespace() == policy.namespace())
                    .filter(|pod| Selector::Query(selector).matches(pod.labels()))
                    .count()
            });
            info
        })
        .collect()
}

#[cfg(test)]
mod network_policy_tests {
    use super::*;
    use k8s_openapi::api::networking::v1::NetworkPolicy;

    /// Specs recorded from a v1.36 API server, which fills `policyTypes` in.
    fn policy(spec: &serde_json::Value) -> NetworkPolicy {
        serde_json::from_value(serde_json::json!({
            "apiVersion": "networking.k8s.io/v1",
            "kind": "NetworkPolicy",
            "metadata": { "name": "p", "namespace": "np-test" },
            "spec": spec,
        }))
        .expect("the shapes are the API server's own")
    }

    /// The pair one character apart in YAML, and opposite in effect.
    ///
    /// `ingress: []` on a policy that governs ingress denies everything to
    /// the pods it picks. `ingress: [{}]` is a rule with no peers under it,
    /// which allows everything. A row that counted rules and stopped would
    /// print `0` and `1` and leave the reader to know which way round it is.
    #[test]
    fn a_rule_with_no_peers_is_the_opposite_of_no_rule_at_all() {
        let denies: NetworkPolicyInfo = (&policy(&serde_json::json!({
            "podSelector": {},
            "policyTypes": ["Ingress"],
        })))
            .into();
        assert!(denies.ingress.governed);
        assert!(denies.ingress.denies_everything);
        assert!(!denies.ingress.opens_to_everything);

        let opens: NetworkPolicyInfo = (&policy(&serde_json::json!({
            "podSelector": { "matchLabels": { "app": "api" } },
            "policyTypes": ["Ingress"],
            "ingress": [{}],
        })))
            .into();
        assert!(opens.ingress.governed);
        assert!(opens.ingress.opens_to_everything);
        assert!(!opens.ingress.denies_everything);
    }

    /// A direction no `policyTypes` names is one this policy says nothing
    /// about, and another policy may govern it. Reporting it as "denies
    /// everything" would turn an ingress-only policy into a claim about
    /// egress that nobody made.
    #[test]
    fn a_direction_the_policy_does_not_govern_is_not_a_direction_it_closes() {
        let ingress_only: NetworkPolicyInfo = (&policy(&serde_json::json!({
            "podSelector": {},
            "policyTypes": ["Ingress"],
            "ingress": [{ "from": [{ "podSelector": { "matchLabels": { "app": "web" } } }] }],
        })))
            .into();
        assert!(!ingress_only.egress.governed);
        assert!(!ingress_only.egress.denies_everything);
        assert!(ingress_only.egress.rules.is_empty());
    }

    /// Three shapes of `podSelector`, and the empty one is the widest thing a
    /// `NetworkPolicy` can say. Drawing it as a blank cell would make the
    /// policy that covers the whole namespace look like the narrowest on the
    /// page; drawing an absent one as empty would invent a claim.
    #[test]
    fn an_empty_selector_and_a_missing_one_are_not_the_same_answer() {
        let everything: NetworkPolicyInfo = (&policy(&serde_json::json!({
            "podSelector": {},
            "policyTypes": ["Ingress"],
        })))
            .into();
        assert_eq!(everything.selects, PolicySelects::Everything);

        let written: NetworkPolicyInfo = (&policy(&serde_json::json!({
            "podSelector": { "matchLabels": { "app": "api" } },
            "policyTypes": ["Ingress"],
        })))
            .into();
        assert_eq!(
            written.selects,
            PolicySelects::Written {
                query: "app=api".to_string()
            }
        );

        let absent: NetworkPolicyInfo = (&policy(&serde_json::json!({
            "policyTypes": ["Ingress"],
        })))
            .into();
        assert_eq!(absent.selects, PolicySelects::NotSaid);
    }

    fn pod(namespace: &str, labels: &[(&str, &str)]) -> k8s_openapi::api::core::v1::Pod {
        serde_json::from_value(serde_json::json!({
            "apiVersion": "v1",
            "kind": "Pod",
            "metadata": {
                "name": "p",
                "namespace": namespace,
                "labels": labels.iter().copied().collect::<std::collections::BTreeMap<_, _>>(),
            },
        }))
        .expect("a pod is a pod")
    }

    /// The refusal, which is the whole reason the count is an `Option`.
    ///
    /// A reader with `list networkpolicies` and without `list pods` is an
    /// ordinary RBAC shape, and for them the pod list simply does not
    /// arrive. Handing them `0` would report the one finding this page
    /// exists for — a policy in front of nothing — to everybody who cannot
    /// see pods. Fails if the join ever defaults the count.
    #[test]
    fn a_pod_list_that_was_refused_is_not_a_pod_list_that_was_empty() {
        let policies = [policy(&serde_json::json!({
            "podSelector": { "matchLabels": { "app": "api" } },
            "policyTypes": ["Ingress"],
        }))];

        let refused = joined_to_pods(&policies, None);
        assert_eq!(refused[0].selected, None);

        let read_and_empty = joined_to_pods(&policies, Some(&[]));
        assert_eq!(read_and_empty[0].selected, Some(0));
    }

    /// A policy acts only in its own namespace, and a cluster-wide list
    /// carries every other namespace's pods. Counting them all would tell an
    /// operator their namespace-scoped policy covers pods it cannot reach.
    #[test]
    fn a_pod_in_another_namespace_is_not_behind_this_policy() {
        let policies = [policy(&serde_json::json!({
            "podSelector": { "matchLabels": { "app": "api" } },
            "policyTypes": ["Ingress"],
        }))];
        let pods = [
            pod("np-test", &[("app", "api")]),
            pod("elsewhere", &[("app", "api")]),
            pod("np-test", &[("app", "web")]),
        ];
        assert_eq!(joined_to_pods(&policies, Some(&pods))[0].selected, Some(1));
    }

    /// The count the page exists for, and the one it must never invent. A
    /// policy nothing matches is accepted and enforces nothing; a pod list
    /// the reader may not have is a different answer from zero.
    #[test]
    fn nothing_selected_is_a_number_and_an_unread_pod_list_is_not() {
        let info: NetworkPolicyInfo = (&policy(&serde_json::json!({
            "podSelector": { "matchLabels": { "app": "apo" } },
            "policyTypes": ["Ingress"],
        })))
            .into();
        // Straight off the object, before any pod list is joined to it.
        assert_eq!(info.selected, None);
    }
}

#[cfg(test)]
mod network_policy_rule_tests {
    use super::*;
    use k8s_openapi::api::networking::v1::NetworkPolicy;

    fn policy(spec: &serde_json::Value) -> NetworkPolicy {
        serde_json::from_value(serde_json::json!({
            "apiVersion": "networking.k8s.io/v1",
            "kind": "NetworkPolicy",
            "metadata": { "name": "p", "namespace": "np-test" },
            "spec": spec,
        }))
        .expect("the shapes are the API server's own")
    }

    /// The AND and the OR, which differ by two characters of YAML.
    ///
    /// One peer carrying both selectors means those pods *in* those
    /// namespaces. Two peers, one selector each, mean those pods anywhere
    /// plus every pod in those namespaces, which is far wider. Flattening
    /// the list into one set of selectors is how the narrow one gets drawn
    /// as the wide one.
    #[test]
    fn two_selectors_in_one_peer_are_not_the_same_as_one_each_in_two() {
        let and: NetworkPolicyInfo = (&policy(&serde_json::json!({
            "podSelector": {},
            "policyTypes": ["Ingress"],
            "ingress": [{ "from": [{
                "podSelector": { "matchLabels": { "app": "web" } },
                "namespaceSelector": { "matchLabels": { "tier": "front" } },
            }] }],
        })))
            .into();
        assert_eq!(and.ingress.rules.len(), 1);
        assert_eq!(and.ingress.rules[0].peers.len(), 1);
        assert_eq!(
            and.ingress.rules[0].peers[0].pods,
            PolicySelects::Written {
                query: "app=web".to_string()
            }
        );
        assert_eq!(
            and.ingress.rules[0].peers[0].namespaces,
            PolicySelects::Written {
                query: "tier=front".to_string()
            }
        );

        let or: NetworkPolicyInfo = (&policy(&serde_json::json!({
            "podSelector": {},
            "policyTypes": ["Ingress"],
            "ingress": [{ "from": [
                { "podSelector": { "matchLabels": { "app": "web" } } },
                { "namespaceSelector": { "matchLabels": { "tier": "front" } } },
            ] }],
        })))
            .into();
        assert_eq!(or.ingress.rules[0].peers.len(), 2);
        assert_eq!(
            or.ingress.rules[0].peers[0].namespaces,
            PolicySelects::NotSaid
        );
        assert_eq!(or.ingress.rules[0].peers[1].pods, PolicySelects::NotSaid);
    }

    /// An empty `namespaceSelector` is every namespace in the cluster and an
    /// absent one is this policy's own. The widest peer a rule can name and
    /// the narrowest, written one character apart.
    #[test]
    fn an_empty_namespace_selector_reaches_the_whole_cluster() {
        let info: NetworkPolicyInfo = (&policy(&serde_json::json!({
            "podSelector": {},
            "policyTypes": ["Ingress"],
            "ingress": [{ "from": [
                { "namespaceSelector": {} },
                { "podSelector": { "matchLabels": { "app": "web" } } },
            ] }],
        })))
            .into();
        let peers = &info.ingress.rules[0].peers;
        assert_eq!(peers[0].namespaces, PolicySelects::Everything);
        assert_eq!(peers[1].namespaces, PolicySelects::NotSaid);
    }

    /// A rule that names no port opens every port, so `None` may not be
    /// drawn as "no ports". Recorded against a real `ipBlock` rule, whose
    /// `except` list is the half people forget.
    #[test]
    fn a_rule_with_no_ports_is_not_a_rule_with_no_open_ports() {
        let info: NetworkPolicyInfo = (&policy(&serde_json::json!({
            "podSelector": {},
            "policyTypes": ["Egress"],
            "egress": [
                { "to": [{ "ipBlock": { "cidr": "10.0.0.0/8", "except": ["10.1.0.0/16"] } }] },
                { "ports": [
                    { "protocol": "TCP", "port": 5432 },
                    { "protocol": "UDP", "port": "dns" },
                    { "protocol": "TCP", "port": 8000, "endPort": 8100 },
                ] },
            ],
        })))
            .into();

        assert!(info.egress.rules[0].ports.is_empty());
        let block = info.egress.rules[0].peers[0]
            .ip_block
            .as_ref()
            .expect("the peer is an ipBlock");
        assert_eq!(block.cidr, "10.0.0.0/8");
        assert_eq!(block.except, vec!["10.1.0.0/16".to_string()]);

        let ports = &info.egress.rules[1].ports;
        assert_eq!(ports[0].port.as_deref(), Some("5432"));
        assert_eq!(ports[1].protocol, "UDP");
        assert_eq!(ports[1].port.as_deref(), Some("dns"));
        assert_eq!(ports[2].end_port, Some(8100));
        // Second rule names ports and no peers, which is the open shape.
        assert!(info.egress.opens_to_everything);
    }
}
