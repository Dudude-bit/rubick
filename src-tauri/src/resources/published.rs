//! What a Service publishes, which is the cluster's answer rather than ours.
//!
//! Everything else in this app that says who is behind a Service is a
//! deduction: match the selector, read each pod's own `Ready` condition,
//! count. The EndpointSlice is what the Service actually hands to kube-proxy
//! and to every ingress controller, and the two come apart in ways nothing on
//! screen could show — a `targetPort` no container names publishes nothing
//! while every pod stays perfectly Ready, and a pod draining with
//! `serving: true, ready: false` is still taking traffic while the deduction
//! calls it dead.
//!
//! One shape comes out of here whichever object answered. A cluster below
//! 1.21 has no slices and the legacy `Endpoints` is read instead; a cluster
//! that answers neither falls back to the old deduction. The source travels
//! with the answer so a page can say which one spoke, rather than reporting a
//! confident empty.

use std::collections::{BTreeMap, BTreeSet};

use k8s_openapi::api::core::v1::{Endpoints, Pod, Service, ServicePort};
use k8s_openapi::api::discovery::v1::{Endpoint, EndpointSlice};
use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
use kube::ResourceExt;
use serde::{Deserialize, Serialize};

use super::connections::{Existence, ObjectFacts, ObjectRef};
use super::types::condition_is_true;

/// The label the endpoint controllers put on every slice they write, and the
/// only stated link from a slice back to its Service.
pub const SERVICE_NAME_LABEL: &str = "kubernetes.io/service-name";

/// The annotation the control plane adds when it had to drop addresses from
/// the legacy object.
pub const OVER_CAPACITY_ANNOTATION: &str = "endpoints.kubernetes.io/over-capacity";

/// How many addresses the legacy `Endpoints` object holds before the control
/// plane truncates it.
pub const LEGACY_CAPACITY: usize = 1000;

/// Which object answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EndpointSource {
    /// The Service's `discovery.k8s.io/v1` slices, found by the
    /// `kubernetes.io/service-name` label the controller writes.
    Slices,
    /// The legacy `Endpoints` object, because the slice list did not answer.
    /// It cannot express `serving` or `terminating`, and it stops at 1000
    /// addresses.
    LegacyEndpoints,
    /// Neither answered, so this is the old deduction — the pods the selector
    /// matches, each read for its own `Ready` condition.
    PodReadiness,
}

/// One port a slice publishes.
///
/// The name is the key, and it is the *Service* port's name rather than the
/// container's: that is what `EndpointSlice.ports[].name` carries, and it is
/// how a slice's ports are matched to `spec.ports` on a Service with several.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedPort {
    /// `None` for the single unnamed port a one-port Service may have.
    pub name: Option<String>,
    /// The resolved target port. `None` is the API's own "every port".
    pub port: Option<i32>,
    pub protocol: String,
    /// Whether `spec.ports` still declares a port by this name. A slice can
    /// outlive the port it was written for.
    pub exposed: bool,
}

/// One address the Service publishes, with the state the slice states.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedEndpoint {
    pub address: String,
    /// The pod behind it, where `targetRef` names one. A hand-written slice
    /// names nothing, and that is a real state rather than a gap.
    pub target: Option<ObjectRef>,
    /// `conditions.ready`, which is unset-means-true in this API.
    pub ready: bool,
    /// `conditions.serving`. True while a terminating pod finishes its open
    /// connections, and the address kube-proxy falls back to when nothing
    /// else is ready.
    pub serving: bool,
    pub terminating: bool,
    #[serde(rename = "nodeName")]
    pub node_name: Option<String>,
    pub zone: Option<String>,
    /// `hints.forZones` — the zones a client has to be in to reach this one.
    /// Empty where topology-aware routing is off, which is the usual case.
    #[serde(rename = "hintZones")]
    pub hint_zones: Vec<String>,
    /// The ports of the slice this endpoint came from.
    pub ports: Vec<i32>,
}

/// A pod the selector matches and the Service does not publish.
///
/// Two shapes, and the second is the one nothing on screen could show: a pod
/// in no slice at all, and a pod in a slice that carries no port — which is
/// what the endpoint controller writes when it cannot resolve `targetPort`
/// against the pod's containers.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnpublishedPod {
    pub pod: ObjectRef,
    /// The `targetPort` names this pod's containers declare nowhere. Empty
    /// where the app cannot say why, and it then says only that.
    #[serde(rename = "unnamedPorts")]
    pub unnamed_ports: Vec<String>,
    /// Whether a slice holds it at all. False is "in no slice"; true is "in a
    /// slice that publishes no port".
    #[serde(rename = "inSlice")]
    pub in_slice: bool,
}

/// What one Service publishes, whole.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServicePublished {
    pub service: ObjectRef,
    pub source: EndpointSource,
    /// How many EndpointSlices carried the answer. Zero for the other two
    /// sources, which have no slices to count.
    pub slices: i32,
    pub ready: i32,
    /// `serving && !ready` — draining, and still taking traffic. The legacy
    /// object cannot express this at all and reports it as not ready.
    pub draining: i32,
    #[serde(rename = "notReady")]
    pub not_ready: i32,
    /// Addresses that are in a slice carrying no port at all. The endpoint
    /// controller writes exactly that when it could resolve none of the
    /// Service's `targetPort`s against the pod, so nothing reaches them —
    /// and they are counted nowhere above, because they are not endpoints in
    /// any sense kube-proxy would recognise.
    pub unrouted: i32,
    pub ports: Vec<PublishedPort>,
    /// Every published endpoint where the reader is on the Service's own
    /// page, and the first alone where a chain hop only needs a name.
    pub endpoints: Vec<PublishedEndpoint>,
    /// Whether `endpoints` is all of them.
    pub whole: bool,
    /// Pods the selector matches that nothing publishes. Only filled where
    /// the pods were read — the second list on the Service page, and the
    /// reason the first one is worth drawing.
    pub unpublished: Vec<UnpublishedPod>,
}

impl ServicePublished {
    /// How many addresses take traffic right now. A draining endpoint counts:
    /// kube-proxy falls back to the terminating ones when no ready endpoint
    /// is left, which is exactly the restart this used to call an outage.
    #[must_use]
    pub fn serving(&self) -> i32 {
        self.ready + self.draining
    }

    /// Whether anything at all is in the answer, published or not.
    #[must_use]
    pub fn any(&self) -> bool {
        self.ready + self.draining + self.not_ready > 0
    }

    /// Trim to what a chain hop needs: the counts, and one name.
    #[must_use]
    pub fn summary(mut self) -> Self {
        self.whole = self.endpoints.len() <= 1;
        self.endpoints.truncate(1);
        self.unpublished.clear();
        self
    }
}

/// The slices that belong to a Service, by the label the controller writes.
///
/// The label rather than the owner reference: a hand-written slice for a
/// selector-less Service carries the label and is owned by nothing this app
/// would recognise, and it is every bit as much what the Service publishes.
#[must_use]
pub fn slices_of<'a>(slices: &'a [EndpointSlice], service: &str) -> Vec<&'a EndpointSlice> {
    slices
        .iter()
        .filter(|slice| slice.labels().get(SERVICE_NAME_LABEL).map(String::as_str) == Some(service))
        .collect()
}

fn service_ports(service: &Service) -> Vec<ServicePort> {
    service
        .spec
        .as_ref()
        .and_then(|spec| spec.ports.clone())
        .unwrap_or_default()
}

/// The `targetPort` names a Service asks for. A number is resolved by the
/// kernel and can never be the thing that is missing.
fn named_target_ports(service: &Service) -> Vec<String> {
    service_ports(service)
        .iter()
        .filter_map(|port| match port.target_port.as_ref() {
            Some(IntOrString::String(name)) => Some(name.clone()),
            _ => None,
        })
        .collect()
}

/// The port names a pod's containers declare.
///
/// `spec.containers` only, which is what the endpoint controller resolves
/// against — a port named on an init container is not one the Service can
/// reach.
fn declared_port_names(pod: &Pod) -> BTreeSet<String> {
    pod.spec
        .iter()
        .flat_map(|spec| &spec.containers)
        .flat_map(|container| container.ports.iter().flatten())
        .filter_map(|port| port.name.clone())
        .collect()
}

/// The `targetPort` names this pod answers to nowhere.
///
/// This is the whole of the app's inference, and it stops here. The Service
/// states the name it wants and the pod states the names it has; anything
/// past that — a controller that has not caught up, a webhook that dropped
/// the endpoint — is not written down anywhere this call can read.
#[must_use]
pub fn unnamed_ports_of(service: &Service, pod: &Pod) -> Vec<String> {
    let declared = declared_port_names(pod);
    named_target_ports(service)
        .into_iter()
        .filter(|name| !declared.contains(name))
        .collect()
}

fn pod_ref(pod: &Pod, ns: &str) -> ObjectRef {
    ObjectRef::new(
        "Pod",
        &pod.name_any(),
        Some(ns.to_string()),
        Existence::Present,
    )
    .with_facts(ObjectFacts::Pod {
        phase: pod
            .status
            .as_ref()
            .and_then(|s| s.phase.clone())
            .unwrap_or_else(|| "Unknown".to_string()),
        display: super::types::PodInfo::from(pod).status.display,
        ready: condition_is_true(pod.status.as_ref(), "Ready"),
    })
}

/// One endpoint, read out of a slice that does publish ports.
fn endpoint_of(endpoint: &Endpoint, ports: &[i32], ns: &str) -> PublishedEndpoint {
    let conditions = endpoint.conditions.as_ref();
    // The API defines an unset `ready` as true, and an unset `serving` as
    // whatever `ready` is. Reading either as false would invent a state.
    let ready = conditions.and_then(|c| c.ready).unwrap_or(true);
    let serving = conditions.and_then(|c| c.serving).unwrap_or(ready);
    PublishedEndpoint {
        address: endpoint
            .addresses
            .first()
            .cloned()
            .unwrap_or_else(|| "—".to_string()),
        target: endpoint.target_ref.as_ref().and_then(|target| {
            target.name.as_ref().map(|name| {
                ObjectRef::new(
                    target.kind.as_deref().unwrap_or("Pod"),
                    name,
                    Some(target.namespace.clone().unwrap_or_else(|| ns.to_string())),
                    Existence::NotChecked,
                )
            })
        }),
        ready,
        serving,
        terminating: conditions.and_then(|c| c.terminating).unwrap_or(false),
        node_name: endpoint.node_name.clone(),
        zone: endpoint.zone.clone(),
        hint_zones: endpoint
            .hints
            .as_ref()
            .and_then(|hints| hints.for_zones.as_ref())
            .map(|zones| zones.iter().map(|zone| zone.name.clone()).collect())
            .unwrap_or_default(),
        ports: ports.to_vec(),
    }
}

/// What a Service publishes, read off its slices.
///
/// `pods` is the namespace's pods where the caller has them and empty where
/// it does not: the second list is the only thing that needs them, and a
/// caller that only wants the counts must not pay for a pod list to get them.
#[must_use]
pub fn from_slices(
    service: &Service,
    service_ref: ObjectRef,
    slices: &[&EndpointSlice],
    pods: &[&Pod],
) -> ServicePublished {
    let ns = service.namespace().unwrap_or_default();
    let exposed: BTreeSet<Option<String>> = service_ports(service)
        .iter()
        .map(|port| port.name.clone())
        .collect();

    let mut ports: Vec<PublishedPort> = Vec::new();
    let mut endpoints: Vec<PublishedEndpoint> = Vec::new();
    let (mut ready, mut draining, mut not_ready, mut unrouted) = (0, 0, 0, 0);
    // Every pod any slice holds, and whether the slice holding it publishes a
    // port. A dual-stack Service lists the same pod in an IPv4 and an IPv6
    // slice, so "published somewhere" is the union rather than the last one.
    let mut held: BTreeMap<String, bool> = BTreeMap::new();

    for slice in slices {
        let slice_ports: Vec<PublishedPort> = slice
            .ports
            .iter()
            .flatten()
            .map(|port| PublishedPort {
                name: port.name.clone(),
                port: port.port,
                protocol: port.protocol.clone().unwrap_or_else(|| "TCP".to_string()),
                exposed: exposed.contains(&port.name),
            })
            .collect();
        // An empty port list is the API's "no defined ports", and it is what
        // the endpoint controller writes when `targetPort` resolved to
        // nothing on these pods. Nothing reaches an endpoint in such a slice.
        let publishes = !slice_ports.is_empty();
        let numbers: Vec<i32> = slice_ports.iter().filter_map(|port| port.port).collect();

        for port in slice_ports {
            if !ports.iter().any(|seen| seen.name == port.name) {
                ports.push(port);
            }
        }

        for endpoint in slice.endpoints.iter() {
            let read = endpoint_of(endpoint, &numbers, &ns);
            if let Some(target) = read.target.as_ref().filter(|t| t.kind == "Pod") {
                let entry = held.entry(target.name.clone()).or_insert(false);
                *entry = *entry || publishes;
            }
            if !publishes {
                unrouted += 1;
                continue;
            }
            if read.ready {
                ready += 1;
            } else if read.serving {
                draining += 1;
            } else {
                not_ready += 1;
            }
            endpoints.push(read);
        }
    }

    let unpublished = pods
        .iter()
        .filter(|pod| !held.get(&pod.name_any()).copied().unwrap_or(false))
        .map(|pod| UnpublishedPod {
            pod: pod_ref(pod, &ns),
            unnamed_ports: unnamed_ports_of(service, pod),
            in_slice: held.contains_key(&pod.name_any()),
        })
        .collect();

    ServicePublished {
        service: service_ref,
        source: EndpointSource::Slices,
        slices: i32::try_from(slices.len()).unwrap_or(i32::MAX),
        ready,
        draining,
        not_ready,
        unrouted,
        ports,
        endpoints,
        whole: true,
        unpublished,
    }
}

/// The same answer from the legacy object, on a cluster that serves no slices.
///
/// `serving` and `terminating` do not exist here — the object has one
/// distinction, ready or not — so a draining address arrives as not ready and
/// the page says which object answered rather than pretending otherwise.
#[must_use]
pub fn from_legacy(
    service: &Service,
    service_ref: ObjectRef,
    legacy: Option<&Endpoints>,
) -> ServicePublished {
    let ns = service.namespace().unwrap_or_default();
    let exposed: BTreeSet<Option<String>> = service_ports(service)
        .iter()
        .map(|port| port.name.clone())
        .collect();

    let mut ports: Vec<PublishedPort> = Vec::new();
    let mut endpoints: Vec<PublishedEndpoint> = Vec::new();
    let (mut ready, mut not_ready) = (0, 0);

    for subset in legacy.iter().flat_map(|ep| ep.subsets.iter().flatten()) {
        let numbers: Vec<i32> = subset
            .ports
            .iter()
            .flatten()
            .map(|port| port.port)
            .collect();
        for port in subset.ports.iter().flatten() {
            if !ports.iter().any(|seen| seen.name == port.name) {
                ports.push(PublishedPort {
                    name: port.name.clone(),
                    port: Some(port.port),
                    protocol: port.protocol.clone().unwrap_or_else(|| "TCP".to_string()),
                    exposed: exposed.contains(&port.name),
                });
            }
        }
        for (addresses, is_ready) in [
            (subset.addresses.as_ref(), true),
            (subset.not_ready_addresses.as_ref(), false),
        ] {
            for address in addresses.into_iter().flatten() {
                if is_ready {
                    ready += 1;
                } else {
                    not_ready += 1;
                }
                endpoints.push(PublishedEndpoint {
                    address: address.ip.clone(),
                    target: address.target_ref.as_ref().and_then(|target| {
                        target.name.as_ref().map(|name| {
                            ObjectRef::new(
                                target.kind.as_deref().unwrap_or("Pod"),
                                name,
                                Some(target.namespace.clone().unwrap_or_else(|| ns.clone())),
                                Existence::NotChecked,
                            )
                        })
                    }),
                    ready: is_ready,
                    serving: is_ready,
                    terminating: false,
                    node_name: address.node_name.clone(),
                    zone: None,
                    hint_zones: Vec::new(),
                    ports: numbers.clone(),
                });
            }
        }
    }

    ServicePublished {
        service: service_ref,
        source: EndpointSource::LegacyEndpoints,
        slices: 0,
        ready,
        draining: 0,
        not_ready,
        unrouted: 0,
        ports,
        endpoints,
        whole: true,
        unpublished: Vec::new(),
    }
}

/// The deduction this feature replaces, kept for the cluster that answers
/// neither object — named as a deduction so the page never draws it as the
/// cluster's own word.
#[must_use]
pub fn from_pod_readiness(
    service: &Service,
    service_ref: ObjectRef,
    pods: &[&Pod],
) -> ServicePublished {
    let ns = service.namespace().unwrap_or_default();
    let mut endpoints = Vec::new();
    let (mut ready, mut not_ready) = (0, 0);
    for pod in pods {
        let is_ready = condition_is_true(pod.status.as_ref(), "Ready");
        if is_ready {
            ready += 1;
        } else {
            not_ready += 1;
        }
        endpoints.push(PublishedEndpoint {
            address: pod
                .status
                .as_ref()
                .and_then(|status| status.pod_ip.clone())
                .unwrap_or_else(|| "—".to_string()),
            target: Some(pod_ref(pod, &ns)),
            ready: is_ready,
            serving: is_ready,
            terminating: false,
            node_name: pod.spec.as_ref().and_then(|spec| spec.node_name.clone()),
            zone: None,
            hint_zones: Vec::new(),
            ports: Vec::new(),
        });
    }

    ServicePublished {
        service: service_ref,
        source: EndpointSource::PodReadiness,
        slices: 0,
        ready,
        draining: 0,
        not_ready,
        unrouted: 0,
        ports: Vec::new(),
        endpoints,
        whole: true,
        unpublished: Vec::new(),
    }
}

/// How many addresses the legacy object lists, and whether it had to drop any.
///
/// The annotation is the control plane's own admission that it truncated;
/// past 1000 addresses a page reading only this object shows a number that is
/// not the answer.
#[must_use]
pub fn legacy_over_capacity(endpoints: &Endpoints) -> bool {
    endpoints
        .annotations()
        .get(OVER_CAPACITY_ANNOTATION)
        .is_some()
        || legacy_addresses(endpoints) >= LEGACY_CAPACITY
}

/// Every address the legacy object lists, ready or not.
#[must_use]
pub fn legacy_addresses(endpoints: &Endpoints) -> usize {
    endpoints
        .subsets
        .iter()
        .flatten()
        .map(|subset| {
            subset.addresses.as_ref().map_or(0, Vec::len)
                + subset.not_ready_addresses.as_ref().map_or(0, Vec::len)
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::api::core::v1::{
        Container, ContainerPort, EndpointAddress, EndpointPort as LegacyPort, EndpointSubset,
        PodSpec, ServiceSpec,
    };
    use k8s_openapi::api::discovery::v1::{
        EndpointConditions, EndpointHints, EndpointPort, ForZone,
    };
    use kube::core::ObjectMeta;

    fn service(name: &str, ports: Vec<ServicePort>) -> Service {
        Service {
            metadata: ObjectMeta {
                name: Some(name.to_string()),
                namespace: Some("k8s-gui-test".to_string()),
                ..Default::default()
            },
            spec: Some(ServiceSpec {
                ports: Some(ports),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    fn port(name: &str, target: IntOrString) -> ServicePort {
        ServicePort {
            name: Some(name.to_string()),
            port: 80,
            target_port: Some(target),
            ..Default::default()
        }
    }

    fn pod(name: &str, container_port: Option<&str>) -> Pod {
        Pod {
            metadata: ObjectMeta {
                name: Some(name.to_string()),
                namespace: Some("k8s-gui-test".to_string()),
                ..Default::default()
            },
            spec: Some(PodSpec {
                containers: vec![Container {
                    name: "web".to_string(),
                    ports: Some(vec![ContainerPort {
                        name: container_port.map(str::to_string),
                        container_port: 80,
                        ..Default::default()
                    }]),
                    ..Default::default()
                }],
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    fn slice(
        name: &str,
        service: &str,
        ports: Option<Vec<EndpointPort>>,
        endpoints: Vec<Endpoint>,
    ) -> EndpointSlice {
        EndpointSlice {
            metadata: ObjectMeta {
                name: Some(name.to_string()),
                namespace: Some("k8s-gui-test".to_string()),
                labels: Some(
                    [(SERVICE_NAME_LABEL.to_string(), service.to_string())]
                        .into_iter()
                        .collect(),
                ),
                ..Default::default()
            },
            address_type: "IPv4".to_string(),
            endpoints,
            ports,
        }
    }

    fn endpoint(address: &str, pod: &str, conditions: EndpointConditions) -> Endpoint {
        Endpoint {
            addresses: vec![address.to_string()],
            conditions: Some(conditions),
            target_ref: Some(k8s_openapi::api::core::v1::ObjectReference {
                kind: Some("Pod".to_string()),
                name: Some(pod.to_string()),
                namespace: Some("k8s-gui-test".to_string()),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    fn svc_ref(name: &str) -> ObjectRef {
        ObjectRef::new(
            "Service",
            name,
            Some("k8s-gui-test".to_string()),
            Existence::Present,
        )
    }

    fn http_port() -> EndpointPort {
        EndpointPort {
            name: Some("http".to_string()),
            port: Some(80),
            protocol: Some("TCP".to_string()),
            ..Default::default()
        }
    }

    /// The case the whole feature exists for. Two Ready pods, a healthy
    /// selector, and a slice with no port in it — which is what the endpoint
    /// controller writes when `targetPort: http` resolves to nothing.
    #[test]
    fn a_named_port_nothing_declares_publishes_nothing_over_ready_pods() {
        let svc = service(
            "named-port-demo",
            vec![port("http", IntOrString::String("http".to_string()))],
        );
        let pods = [pod("a", Some("web")), pod("b", Some("web"))];
        let refs: Vec<&Pod> = pods.iter().collect();
        let slices = [slice(
            "named-port-demo-x",
            "named-port-demo",
            None,
            vec![
                endpoint(
                    "10.0.0.1",
                    "a",
                    EndpointConditions {
                        ready: Some(true),
                        serving: Some(true),
                        terminating: Some(false),
                    },
                ),
                endpoint(
                    "10.0.0.2",
                    "b",
                    EndpointConditions {
                        ready: Some(true),
                        serving: Some(true),
                        terminating: Some(false),
                    },
                ),
            ],
        )];

        let published = from_slices(
            &svc,
            svc_ref("named-port-demo"),
            &slices.iter().collect::<Vec<_>>(),
            &refs,
        );
        assert_eq!(published.serving(), 0, "a portless slice reaches nothing");
        assert!(!published.any());
        assert_eq!(
            published.unrouted, 2,
            "both addresses are in the answer and neither is reachable"
        );
        assert_eq!(published.unpublished.len(), 2);
        assert!(published.unpublished.iter().all(|entry| entry.in_slice));
        assert_eq!(
            published.unpublished[0].unnamed_ports,
            vec!["http".to_string()]
        );
    }

    /// The same Service with the port named on the container publishes both,
    /// and nothing lands in the second list.
    #[test]
    fn the_same_service_with_the_port_named_publishes_both() {
        let svc = service(
            "named-port-demo",
            vec![port("http", IntOrString::String("http".to_string()))],
        );
        let pods = [pod("a", Some("http")), pod("b", Some("http"))];
        let refs: Vec<&Pod> = pods.iter().collect();
        let slices = [slice(
            "named-port-demo-x",
            "named-port-demo",
            Some(vec![http_port()]),
            vec![
                endpoint(
                    "10.0.0.1",
                    "a",
                    EndpointConditions {
                        ready: Some(true),
                        serving: Some(true),
                        terminating: Some(false),
                    },
                ),
                endpoint(
                    "10.0.0.2",
                    "b",
                    EndpointConditions {
                        ready: Some(true),
                        serving: Some(true),
                        terminating: Some(false),
                    },
                ),
            ],
        )];

        let published = from_slices(
            &svc,
            svc_ref("named-port-demo"),
            &slices.iter().collect::<Vec<_>>(),
            &refs,
        );
        assert_eq!(published.ready, 2);
        assert_eq!(published.serving(), 2);
        assert!(published.unpublished.is_empty());
        assert!(published.ports.iter().all(|port| port.exposed));
    }

    /// A draining endpoint is `serving: true, ready: false` and is still the
    /// address traffic goes to. Reading it as an outage is the defect this
    /// replaces.
    #[test]
    fn a_draining_endpoint_is_still_serving() {
        let svc = service(
            "draining-demo",
            vec![port("http", IntOrString::String("http".to_string()))],
        );
        let slices = [slice(
            "draining-demo-x",
            "draining-demo",
            Some(vec![http_port()]),
            vec![endpoint(
                "10.0.0.1",
                "a",
                EndpointConditions {
                    ready: Some(false),
                    serving: Some(true),
                    terminating: Some(true),
                },
            )],
        )];

        let published = from_slices(
            &svc,
            svc_ref("draining-demo"),
            &slices.iter().collect::<Vec<_>>(),
            &[],
        );
        assert_eq!(published.ready, 0);
        assert_eq!(published.draining, 1);
        assert_eq!(published.not_ready, 0);
        assert_eq!(
            published.serving(),
            1,
            "a draining endpoint takes traffic, so this is not an outage"
        );
    }

    /// The mirroring controller writes `ready` alone. The API defines an
    /// unset `serving` as whatever `ready` is, and reading it as false would
    /// invent a state the object never claimed.
    #[test]
    fn an_unset_serving_follows_ready() {
        let svc = service("manual-demo", vec![port("http", IntOrString::Int(8080))]);
        let slices = [slice(
            "manual-demo-x",
            "manual-demo",
            Some(vec![http_port()]),
            vec![Endpoint {
                addresses: vec!["10.42.9.11".to_string()],
                conditions: Some(EndpointConditions {
                    ready: Some(true),
                    serving: None,
                    terminating: None,
                }),
                ..Default::default()
            }],
        )];

        let published = from_slices(
            &svc,
            svc_ref("manual-demo"),
            &slices.iter().collect::<Vec<_>>(),
            &[],
        );
        assert_eq!(published.ready, 1);
        assert_eq!(published.draining, 0);
        assert!(published.endpoints[0].serving);
        assert!(
            published.endpoints[0].target.is_none(),
            "a hand-written endpoint names no pod, and that is a state rather than a gap"
        );
    }

    /// A slice port the Service no longer exposes is shown and marked, never
    /// counted as one of the Service's.
    #[test]
    fn a_slice_port_the_service_does_not_expose_is_marked() {
        let svc = service("shop-api", vec![port("http", IntOrString::Int(8080))]);
        let slices = [slice(
            "shop-api-x",
            "shop-api",
            Some(vec![
                http_port(),
                EndpointPort {
                    name: Some("metrics".to_string()),
                    port: Some(9090),
                    protocol: Some("TCP".to_string()),
                    ..Default::default()
                },
            ]),
            vec![endpoint(
                "10.0.0.1",
                "a",
                EndpointConditions {
                    ready: Some(true),
                    serving: Some(true),
                    terminating: Some(false),
                },
            )],
        )];

        let published = from_slices(
            &svc,
            svc_ref("shop-api"),
            &slices.iter().collect::<Vec<_>>(),
            &[],
        );
        let metrics = published
            .ports
            .iter()
            .find(|port| port.name.as_deref() == Some("metrics"))
            .expect("the slice's own port is listed");
        assert!(!metrics.exposed);
        assert!(published
            .ports
            .iter()
            .any(|port| port.name.as_deref() == Some("http") && port.exposed));
    }

    #[test]
    fn topology_hints_travel_with_the_endpoint() {
        let svc = service("topology-demo", vec![port("http", IntOrString::Int(80))]);
        let mut only = endpoint(
            "10.0.0.1",
            "a",
            EndpointConditions {
                ready: Some(true),
                serving: Some(true),
                terminating: Some(false),
            },
        );
        only.zone = Some("west1-b".to_string());
        only.hints = Some(EndpointHints {
            for_zones: Some(vec![ForZone {
                name: "west1-b".to_string(),
            }]),
        });
        let slices = [slice(
            "topology-demo-x",
            "topology-demo",
            Some(vec![http_port()]),
            vec![only],
        )];

        let published = from_slices(
            &svc,
            svc_ref("topology-demo"),
            &slices.iter().collect::<Vec<_>>(),
            &[],
        );
        assert_eq!(published.endpoints[0].zone.as_deref(), Some("west1-b"));
        assert_eq!(
            published.endpoints[0].hint_zones,
            vec!["west1-b".to_string()]
        );
    }

    /// A slice belongs to the Service its label names, and to nothing else.
    #[test]
    fn slices_are_found_by_the_label_the_controller_writes() {
        let mine = slice("a", "shop-api", None, vec![]);
        let theirs = slice("b", "other", None, vec![]);
        let all = [mine, theirs];
        assert_eq!(slices_of(&all, "shop-api").len(), 1);
        assert!(slices_of(&all, "nothing").is_empty());
    }

    /// Over capacity is impractical to stand up at 1000 endpoints, so the
    /// rule is asserted here: the annotation is the control plane saying it
    /// dropped addresses, and a page that reports the object's own length
    /// past that is showing 1000 of however many there really are.
    #[test]
    fn the_legacy_object_admits_when_it_was_truncated() {
        let mut endpoints = Endpoints {
            metadata: ObjectMeta {
                name: Some("big".to_string()),
                annotations: Some(
                    [(
                        OVER_CAPACITY_ANNOTATION.to_string(),
                        "truncated".to_string(),
                    )]
                    .into_iter()
                    .collect(),
                ),
                ..Default::default()
            },
            subsets: Some(vec![EndpointSubset {
                addresses: Some(
                    (0..LEGACY_CAPACITY)
                        .map(|n| EndpointAddress {
                            ip: format!("10.42.{}.{}", n / 256, n % 256),
                            ..Default::default()
                        })
                        .collect(),
                ),
                not_ready_addresses: None,
                ports: Some(vec![LegacyPort {
                    name: Some("http".to_string()),
                    port: 80,
                    protocol: Some("TCP".to_string()),
                    ..Default::default()
                }]),
            }]),
        };
        assert_eq!(legacy_addresses(&endpoints), LEGACY_CAPACITY);
        assert!(legacy_over_capacity(&endpoints));

        endpoints.metadata.annotations = None;
        assert!(
            legacy_over_capacity(&endpoints),
            "a full object is at the cap whether or not the annotation survived"
        );

        endpoints.subsets = Some(vec![EndpointSubset {
            addresses: Some(vec![EndpointAddress {
                ip: "10.42.0.1".to_string(),
                ..Default::default()
            }]),
            not_ready_addresses: None,
            ports: None,
        }]);
        assert!(!legacy_over_capacity(&endpoints));
    }
}
