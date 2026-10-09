//! What a Service publishes, which is the cluster's answer rather than ours.
//!
//! Everything else in this app that says who is behind a Service is a
//! deduction: match the selector, read each pod's own `Ready` condition,
//! count. The `EndpointSlice` is what the Service actually hands to kube-proxy
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

use k8s_openapi::api::apps::v1::{Deployment, StatefulSet};
use k8s_openapi::api::core::v1::{Endpoints, Pod, Service, ServicePort};
use k8s_openapi::api::discovery::v1::{Endpoint, EndpointSlice};
use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
use kube::ResourceExt;
use serde::{Deserialize, Serialize};

use super::connections::{ChainStop, Existence, NearMiss, NotServing, ObjectFacts, ObjectRef};
use super::selector::Selector;
use super::types::pod_display::display_status;
use super::types::{condition_is_true, crash_looping};

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
    /// `None` for a pod the cluster has not given an IP yet.
    pub address: Option<String>,
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
    /// How many `EndpointSlices` carried the answer. Zero for the other two
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
    /// Of `unrouted`, the ones the slice calls ready.
    #[serde(rename = "unroutedReady")]
    pub unrouted_ready: i32,
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
    /// Where a path into this Service stops, by [`service_stop`]; `None`
    /// where it reaches something.
    pub stop: Option<ChainStop>,
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

    /// This answer with [`service_stop`] filled in.
    #[must_use]
    pub fn with_stop(mut self, service: &Service, pods: Option<&[&Pod]>) -> Self {
        self.stop = service_stop(service, &self, pods);
        self
    }

    /// A selector matching no pod, said as [`ChainStop::ScaledToZero`] where
    /// [`scaled_to_zero`] finds every workload behind it asking for none.
    #[must_use]
    pub fn with_makers(mut self, service: &Service, makers: &[PodMaker<'_>]) -> Self {
        if let Some(ChainStop::SelectsNothing {
            service: at,
            selector,
            ..
        }) = &self.stop
        {
            if let Some(workloads) = scaled_to_zero(service, makers) {
                self.stop = Some(ChainStop::ScaledToZero {
                    service: at.clone(),
                    selector: selector.clone(),
                    workloads,
                });
            }
        }
        self
    }

    /// A selector matching no pod, with the pods in its namespace that carry
    /// the most of it named beside it.
    #[must_use]
    pub fn with_near_miss(mut self, service: &Service, pods: &[Pod]) -> Self {
        if let Some(ChainStop::SelectsNothing { near, .. }) = self.stop.as_mut() {
            *near = near_miss(service, pods);
        }
        self
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

pub(crate) fn pod_ref(pod: &Pod, ns: &str) -> ObjectRef {
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
        // The status word alone, not a whole PodInfo built to read one field.
        display: super::types::pod_display::display_status(pod),
        ready: condition_is_true(pod.status.as_ref(), "Ready"),
        looping_exit_at: super::types::pod_display::looping_exit(pod),
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
        address: endpoint.addresses.first().cloned(),
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
    let (mut ready, mut draining, mut not_ready) = (0, 0, 0);
    let (mut unrouted, mut unrouted_ready) = (0, 0);
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

        for endpoint in &slice.endpoints {
            let read = endpoint_of(endpoint, &numbers, &ns);
            if let Some(target) = read.target.as_ref().filter(|t| t.kind == "Pod") {
                let entry = held.entry(target.name.clone()).or_insert(false);
                *entry = *entry || publishes;
            }
            if !publishes {
                unrouted += 1;
                unrouted_ready += i32::from(read.ready);
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
        unrouted_ready,
        ports,
        endpoints,
        whole: true,
        unpublished,
        stop: None,
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
                    address: Some(address.ip.clone()),
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
        unrouted_ready: 0,
        ports,
        endpoints,
        whole: true,
        unpublished: Vec::new(),
        stop: None,
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
            address: pod.status.as_ref().and_then(|status| status.pod_ip.clone()),
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
        unrouted_ready: 0,
        ports: Vec::new(),
        endpoints,
        whole: true,
        unpublished: Vec::new(),
        stop: None,
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

/// Where a path into this Service stops, or `None` where it reaches
/// something: the one rule, for the connections graph and the routing pages.
///
/// `pods` is the selected pods where the reader listed them. A reader that
/// holds the endpoints alone passes `None` and gets what the endpoints can
/// say: it cannot tell a selector matching nothing from pods not yet given an
/// address, so it says `PublishesNothingYet` rather than blame the labels.
#[must_use]
pub fn service_stop(
    service: &Service,
    published: &ServicePublished,
    pods: Option<&[&Pod]>,
) -> Option<ChainStop> {
    // Neither the endpoints nor the pods were read: the zero is nobody's.
    if pods.is_none() && published.source == EndpointSource::PodReadiness {
        return None;
    }
    let spec = service.spec.as_ref();
    // A DNS alias: no pods by design, so no endpoints and no stop.
    if spec.and_then(|s| s.type_.as_deref()) == Some("ExternalName") {
        return None;
    }
    let selector = spec.and_then(|s| s.selector.clone()).unwrap_or_default();
    // No selector: endpoints managed by hand, nothing these objects can judge.
    let text = Selector::Equality(&selector).says()?;
    // A draining address still takes traffic when nothing ready is left.
    if published.serving() > 0 {
        return None;
    }
    let at = published.service.clone();
    let count = |n: usize| i32::try_from(n).unwrap_or(i32::MAX);
    let Some(selected) = pods else {
        if published.unrouted > 0 {
            return Some(ChainStop::PublishesNothing {
                service: at,
                selector: text,
                pods: published.unrouted,
                ready_pods: published.unrouted_ready,
                unnamed_ports: named_target_ports(service),
            });
        }
        if published.not_ready > 0 {
            return Some(ChainStop::NoneReady {
                service: at,
                selector: text,
                pods: published.not_ready,
                why: NotServing::InSlices,
            });
        }
        return Some(ChainStop::PublishesNothingYet {
            service: at,
            selector: text,
        });
    };
    if selected.is_empty() {
        return Some(ChainStop::SelectsNothing {
            service: at,
            selector: text,
            near: None,
        });
    }
    let ready_pods = selected
        .iter()
        .filter(|pod| condition_is_true(pod.status.as_ref(), "Ready"))
        .count();
    if published.not_ready > 0 || ready_pods == 0 {
        return Some(ChainStop::NoneReady {
            service: at,
            selector: text,
            pods: count(selected.len()),
            why: not_serving(selected),
        });
    }
    Some(ChainStop::PublishesNothing {
        service: at,
        selector: text,
        pods: count(selected.len()),
        ready_pods: count(ready_pods),
        unnamed_ports: unresolved_target_ports(service, selected),
    })
}

/// A Deployment or `StatefulSet` as the scaled-to-zero rule reads it: the
/// labels its pods are made with, and how many it asks for.
pub struct PodMaker<'a> {
    pub workload: ObjectRef,
    pub labels: &'a BTreeMap<String, String>,
    pub replicas: i32,
}

impl<'a> PodMaker<'a> {
    #[must_use]
    pub fn deployment(deployment: &'a Deployment) -> Option<Self> {
        let spec = deployment.spec.as_ref()?;
        let status = deployment.status.as_ref();
        Some(Self {
            workload: maker_ref(
                "Deployment",
                &deployment.name_any(),
                deployment.namespace(),
                status.and_then(|s| s.replicas).unwrap_or(0),
                status.and_then(|s| s.ready_replicas).unwrap_or(0),
                super::deployment_rollout(deployment),
            ),
            labels: spec.template.metadata.as_ref()?.labels.as_ref()?,
            replicas: spec.replicas.unwrap_or(1),
        })
    }

    #[must_use]
    pub fn stateful_set(set: &'a StatefulSet) -> Option<Self> {
        let spec = set.spec.as_ref()?;
        let status = set.status.as_ref();
        Some(Self {
            workload: maker_ref(
                "StatefulSet",
                &set.name_any(),
                set.namespace(),
                status.map_or(0, |s| s.replicas),
                status.and_then(|s| s.ready_replicas).unwrap_or(0),
                super::statefulset_rollout(set),
            ),
            labels: spec.template.metadata.as_ref()?.labels.as_ref()?,
            replicas: spec.replicas.unwrap_or(1),
        })
    }
}

/// Every Deployment and `StatefulSet` here, as the rule reads them.
#[must_use]
pub fn makers<'a>(deployments: &'a [Deployment], sets: &'a [StatefulSet]) -> Vec<PodMaker<'a>> {
    deployments
        .iter()
        .filter_map(PodMaker::deployment)
        .chain(sets.iter().filter_map(PodMaker::stateful_set))
        .collect()
}

fn maker_ref(
    kind: &str,
    name: &str,
    namespace: Option<String>,
    replicas: i32,
    ready_replicas: i32,
    rollout: super::Rollout,
) -> ObjectRef {
    ObjectRef::new(kind, name, namespace, Existence::Present).with_facts(ObjectFacts::Workload {
        replicas,
        ready_replicas,
        rollout: Some(rollout),
        revision: None,
        current: None,
    })
}

/// The workloads whose pods a Service's selector picks, where there are some
/// and every one asks for none; `None` where any still asks for pods.
#[must_use]
pub fn scaled_to_zero(service: &Service, makers: &[PodMaker<'_>]) -> Option<Vec<ObjectRef>> {
    let selector = service
        .spec
        .as_ref()
        .and_then(|s| s.selector.clone())
        .unwrap_or_default();
    let query = Selector::Equality(&selector);
    let picked: Vec<&PodMaker> = makers
        .iter()
        .filter(|maker| query.matches(maker.labels) == Some(true))
        .collect();
    if picked.is_empty() || picked.iter().any(|maker| maker.replicas > 0) {
        return None;
    }
    Some(picked.iter().map(|maker| maker.workload.clone()).collect())
}

/// The pods that carry the most of a Service's selector without carrying all
/// of it: one label short is the commonest way a selector matches nothing.
#[must_use]
pub fn near_miss(service: &Service, pods: &[Pod]) -> Option<NearMiss> {
    let selector = service
        .spec
        .as_ref()
        .and_then(|s| s.selector.clone())
        .unwrap_or_default();
    let mut groups: BTreeMap<Vec<&String>, Vec<&Pod>> = BTreeMap::new();
    for pod in pods {
        let carried = carried_of(&selector, pod.labels());
        if !carried.is_empty() && carried.len() < selector.len() {
            groups.entry(carried).or_default().push(pod);
        }
    }
    let (held, closest) = groups
        .into_iter()
        .max_by_key(|(held, pods)| (held.len(), pods.len()))?;
    let (carries, lacks) = split_selector(&selector, &held);
    Some(NearMiss {
        pods: closest
            .iter()
            .map(|pod| pod_ref(pod, &pod.namespace().unwrap_or_default()))
            .collect(),
        carries,
        lacks,
    })
}

/// The part of `selector` that `labels` carries and the part it lacks, where
/// it carries some of it and not all.
#[must_use]
pub fn partly_carried(
    selector: &BTreeMap<String, String>,
    labels: &BTreeMap<String, String>,
) -> Option<(String, String)> {
    let carried = carried_of(selector, labels);
    (!carried.is_empty() && carried.len() < selector.len())
        .then(|| split_selector(selector, &carried))
}

fn carried_of<'a>(
    selector: &'a BTreeMap<String, String>,
    labels: &BTreeMap<String, String>,
) -> Vec<&'a String> {
    selector
        .iter()
        .filter(|(key, value)| labels.get(*key) == Some(*value))
        .map(|(key, _)| key)
        .collect()
}

fn split_selector(selector: &BTreeMap<String, String>, carried: &[&String]) -> (String, String) {
    let part = |carries: bool| {
        selector
            .iter()
            .filter(|(key, _)| carried.contains(key) == carries)
            .map(|(key, value)| format!("{key}={value}"))
            .collect::<Vec<_>>()
            .join(",")
    };
    (part(true), part(false))
}

/// Why one pod that is not Ready is not, in the terms of [`NotServing`].
fn pod_not_serving(pod: &Pod) -> NotServing {
    if pod.metadata.deletion_timestamp.is_some() {
        return NotServing::Terminating;
    }
    let phase = pod.status.as_ref().and_then(|s| s.phase.as_deref());
    if matches!(phase, Some("Succeeded" | "Failed")) {
        return NotServing::Finished;
    }
    if display_status(pod).ends_with("CrashLoopBackOff") || crash_looping(pod, chrono::Utc::now()) {
        return NotServing::CrashLooping;
    }
    let placed = pod
        .spec
        .as_ref()
        .and_then(|s| s.node_name.as_deref())
        .is_some_and(|node| !node.is_empty());
    match (phase, placed) {
        (Some("Pending") | None, false) => NotServing::Unscheduled,
        (Some("Pending"), true) => NotServing::Starting,
        (Some("Running"), true) => NotServing::FailingReadiness,
        _ => NotServing::Other,
    }
}

/// Why the selected pods are not taking traffic: the one reason they share,
/// or `Mixed`. Pods that are Ready while the slices say none serves leave
/// only the slices to speak.
fn not_serving(selected: &[&Pod]) -> NotServing {
    let reasons: BTreeSet<NotServing> = selected
        .iter()
        .filter(|pod| !condition_is_true(pod.status.as_ref(), "Ready"))
        .map(|pod| pod_not_serving(pod))
        .collect();
    let mut each = reasons.into_iter();
    match (each.next(), each.next()) {
        (None, _) => NotServing::InSlices,
        (Some(only), None) => only,
        (Some(_), Some(_)) => NotServing::Mixed,
    }
}

/// The `targetPort` names not one selected container declares — only the
/// ones that resolve on no pod at all. One pod out of six missing a name is a
/// different finding from a Service asking for a name that exists nowhere.
fn unresolved_target_ports(service: &Service, selected: &[&Pod]) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for pod in selected {
        for name in unnamed_ports_of(service, pod) {
            if !names.contains(&name) {
                names.push(name);
            }
        }
    }
    names.retain(|name| {
        selected
            .iter()
            .all(|pod| unnamed_ports_of(service, pod).contains(name))
    });
    names
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::api::core::v1::{
        Container, ContainerPort, ContainerState, ContainerStateWaiting, ContainerStatus,
        EndpointAddress, EndpointPort as LegacyPort, EndpointSubset, PodSpec, PodStatus,
        ServiceSpec,
    };
    use k8s_openapi::api::discovery::v1::{
        EndpointConditions, EndpointHints, EndpointPort, ForZone,
    };
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::Time;
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

    /// Where the pods were not read, the stop counts ready pods from the
    /// slice. It said every unrouted address was ready, so a Service with one
    /// ready pod of two read "2 pods match, all ready".
    #[test]
    fn an_unread_pod_list_takes_ready_pods_from_the_slice() {
        let svc = selecting("web");
        let conditions = |ready: bool| EndpointConditions {
            ready: Some(ready),
            serving: Some(ready),
            terminating: Some(false),
        };
        let slices = [slice(
            "web-x",
            "web",
            None,
            vec![
                endpoint("10.0.0.1", "a", conditions(true)),
                endpoint("10.0.0.2", "b", conditions(false)),
            ],
        )];

        assert!(matches!(
            stop_of(&svc, &slices, None),
            Some(ChainStop::PublishesNothing {
                pods: 2,
                ready_pods: 1,
                ..
            })
        ));
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

    fn selecting(name: &str) -> Service {
        let mut svc = service(
            name,
            vec![port("http", IntOrString::String("http".to_string()))],
        );
        if let Some(spec) = svc.spec.as_mut() {
            spec.selector = Some([("app".to_string(), "web".to_string())].into());
        }
        svc
    }

    fn ready(mut pod: Pod) -> Pod {
        pod.status = Some(k8s_openapi::api::core::v1::PodStatus {
            conditions: Some(vec![k8s_openapi::api::core::v1::PodCondition {
                type_: "Ready".to_string(),
                status: "True".to_string(),
                ..Default::default()
            }]),
            ..Default::default()
        });
        pod
    }

    fn stop_of(
        svc: &Service,
        slices: &[EndpointSlice],
        pods: Option<&[&Pod]>,
    ) -> Option<ChainStop> {
        let name = svc.name_any();
        let published = from_slices(
            svc,
            svc_ref(&name),
            &slices_of(slices, &name),
            pods.unwrap_or_default(),
        );
        service_stop(svc, &published, pods)
    }

    /// Endpoints alone cannot tell a selector matching nothing from pods not
    /// yet given an address, so the routing pages must not blame the labels;
    /// the graph, which listed the pods and found none, must. Swapping the
    /// two branches, or dropping the `pods` split, fails one side.
    #[test]
    fn an_empty_service_selects_nothing_only_where_the_pods_were_listed() {
        let svc = selecting("web");

        assert!(matches!(
            stop_of(&svc, &[], None),
            Some(ChainStop::PublishesNothingYet { .. })
        ));
        assert!(matches!(
            stop_of(&svc, &[], Some(&[])),
            Some(ChainStop::SelectsNothing { .. })
        ));
    }

    fn deployment(name: &str, app: &str, replicas: i32) -> Deployment {
        serde_json::from_value(serde_json::json!({
            "apiVersion": "apps/v1", "kind": "Deployment",
            "metadata": {"name": name, "namespace": "k8s-gui-test"},
            "spec": {
                "replicas": replicas,
                "selector": {"matchLabels": {"app": app}},
                "template": {"metadata": {"labels": {"app": app}}, "spec": {"containers": []}}
            }
        }))
        .expect("deployment parses")
    }

    /// Lena scaled hello-web to zero and its Service read red "no pod carries
    /// app=hello-web" on every screen. Fails if a workload at zero leaves the
    /// labels blamed, or if one still asking for pods is called idle.
    #[test]
    fn a_service_whose_only_workload_is_scaled_to_zero_stops_by_intent() {
        let svc = selecting("web");
        let said = |deployments: &[Deployment]| {
            let makers: Vec<PodMaker> = deployments
                .iter()
                .filter_map(PodMaker::deployment)
                .collect();
            from_slices(&svc, svc_ref("web"), &[], &[])
                .with_stop(&svc, Some(&[]))
                .with_makers(&svc, &makers)
                .stop
        };

        let idle = said(&[deployment("web", "web", 0), deployment("other", "other", 3)]);
        let Some(ChainStop::ScaledToZero {
            workloads,
            selector,
            ..
        }) = idle
        else {
            panic!("a selector behind a workload at zero is idle, got {idle:?}");
        };
        assert_eq!(selector, "app=web");
        assert_eq!(
            workloads
                .iter()
                .map(|w| (w.kind.as_str(), w.name.as_str()))
                .collect::<Vec<_>>(),
            [("Deployment", "web")]
        );

        assert!(matches!(
            said(&[
                deployment("web", "web", 0),
                deployment("web-canary", "web", 1)
            ]),
            Some(ChainStop::SelectsNothing { .. })
        ));
        assert!(matches!(said(&[]), Some(ChainStop::SelectsNothing { .. })));
    }

    /// Only a selector that matched no pod is turned idle: endpoints alone
    /// cannot say no pod carries it, so nor can they say why. Fails if the
    /// rule reaches past `SelectsNothing`.
    #[test]
    fn a_service_read_from_its_endpoints_alone_is_not_called_idle() {
        let svc = selecting("web");
        let parked = [deployment("web", "web", 0)];
        let makers: Vec<PodMaker> = parked.iter().filter_map(PodMaker::deployment).collect();
        let stop = from_slices(&svc, svc_ref("web"), &[], &[])
            .with_stop(&svc, None)
            .with_makers(&svc, &makers)
            .stop;
        assert!(matches!(stop, Some(ChainStop::PublishesNothingYet { .. })));
    }

    fn labelled(name: &str, labels: &[(&str, &str)]) -> Pod {
        let mut pod = pod(name, None);
        pod.metadata.labels = Some(
            labels
                .iter()
                .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
                .collect(),
        );
        pod
    }

    /// Marco's checkout-api selects app=checkout-api,track=stable and its two
    /// pods carry track=canary: the page said only that no pod carries the
    /// selector. Fails if the pods carrying the most of it go unnamed, or a
    /// pod carrying none of it is offered as close.
    #[test]
    fn a_selector_one_label_short_names_the_pods_that_carry_the_rest() {
        let mut svc = selecting("checkout-api");
        if let Some(spec) = svc.spec.as_mut() {
            spec.selector = Some(
                [("app", "checkout-api"), ("track", "stable")]
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .into(),
            );
        }
        let pods = [
            labelled(
                "checkout-api-a",
                &[("app", "checkout-api"), ("track", "canary")],
            ),
            labelled(
                "checkout-api-b",
                &[("app", "checkout-api"), ("track", "canary")],
            ),
            labelled("worker", &[("app", "checkout-worker")]),
        ];
        let stop = from_slices(&svc, svc_ref("checkout-api"), &[], &[])
            .with_stop(&svc, Some(&[]))
            .with_near_miss(&svc, &pods)
            .stop;
        let Some(ChainStop::SelectsNothing {
            near: Some(near), ..
        }) = stop
        else {
            panic!("the closest pods are named, got {stop:?}");
        };
        assert_eq!(near.carries, "app=checkout-api");
        assert_eq!(near.lacks, "track=stable");
        assert_eq!(
            near.pods
                .iter()
                .map(|p| p.name.as_str())
                .collect::<Vec<_>>(),
            ["checkout-api-a", "checkout-api-b"]
        );

        assert!(near_miss(&svc, &pods[2..]).is_none());
        assert!(near_miss(&selecting("web"), &[labelled("web-1", &[("app", "api")])]).is_none());
    }

    /// With neither the endpoints nor the pods read, the zeros come from
    /// nothing. Deleting the `PodReadiness` guard says "publishes nothing
    /// yet" about a Service nobody could look at.
    #[test]
    fn a_service_with_nothing_read_has_no_stop() {
        let svc = selecting("web");
        let published = from_pod_readiness(&svc, svc_ref("web"), &[]);

        assert!(service_stop(&svc, &published, None).is_none());
    }

    /// The portless slice says the same thing to both readers: Ready pods,
    /// no address:port. Endpoints alone name every named `targetPort`; the
    /// pods narrow it to the ones no container declares.
    #[test]
    fn a_portless_slice_publishes_nothing_to_either_reader() {
        let svc = selecting("web");
        let slices = [slice(
            "web-x",
            "web",
            None,
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
        let pods = [ready(pod("a", Some("web")))];
        let refs: Vec<&Pod> = pods.iter().collect();

        for answer in [
            stop_of(&svc, &slices, None),
            stop_of(&svc, &slices, Some(&refs)),
        ] {
            let Some(ChainStop::PublishesNothing {
                ready_pods,
                unnamed_ports,
                ..
            }) = answer
            else {
                panic!("expected PublishesNothing, got {answer:?}");
            };
            assert_eq!(ready_pods, 1);
            assert_eq!(unnamed_ports, vec!["http".to_string()]);
        }
    }

    /// A draining address is what kube-proxy falls back to, so a Service
    /// down to one is a restart rather than an outage; `ExternalName` and a
    /// selector-less Service are not judged at all.
    #[test]
    fn draining_external_name_and_selectorless_services_have_no_stop() {
        let svc = selecting("web");
        let draining = [slice(
            "web-x",
            "web",
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
        assert!(stop_of(&svc, &draining, None).is_none());

        let mut alias = selecting("alias");
        if let Some(spec) = alias.spec.as_mut() {
            spec.type_ = Some("ExternalName".to_string());
        }
        assert!(stop_of(&alias, &[], None).is_none());

        let manual = service("manual", vec![]);
        assert!(stop_of(&manual, &[], Some(&[])).is_none());
    }

    /// Pods listed and none Ready is the old stop, not "selects nothing".
    #[test]
    fn listed_pods_with_none_ready_are_none_ready() {
        let svc = selecting("web");
        let pods = [pod("a", Some("http"))];
        let refs: Vec<&Pod> = pods.iter().collect();

        assert!(matches!(
            stop_of(&svc, &[], Some(&refs)),
            Some(ChainStop::NoneReady { pods: 1, .. })
        ));
    }

    fn in_state(name: &str, node: Option<&str>, phase: &str, waiting: Option<&str>) -> Pod {
        let mut pod = pod(name, Some("http"));
        if let Some(spec) = pod.spec.as_mut() {
            spec.node_name = node.map(str::to_string);
        }
        pod.status = Some(PodStatus {
            phase: Some(phase.to_string()),
            container_statuses: waiting.map(|reason| {
                vec![ContainerStatus {
                    name: "web".to_string(),
                    state: Some(ContainerState {
                        waiting: Some(ContainerStateWaiting {
                            reason: Some(reason.to_string()),
                            ..Default::default()
                        }),
                        ..Default::default()
                    }),
                    ..Default::default()
                }]
            }),
            ..Default::default()
        });
        pod
    }

    fn why_of(svc: &Service, pods: &[Pod]) -> Option<NotServing> {
        let refs: Vec<&Pod> = pods.iter().collect();
        match stop_of(svc, &[], Some(&refs)) {
            Some(ChainStop::NoneReady { why, .. }) => Some(why),
            _ => None,
        }
    }

    /// topology-demo: Pending, no node, no address, an empty slice. The stop
    /// told the reader to debug a readiness probe on running pods.
    #[test]
    fn pending_pods_with_no_node_are_unscheduled_not_failing_a_probe() {
        let svc = selecting("web");
        let pods = [
            in_state("a", None, "Pending", None),
            in_state("b", None, "Pending", None),
        ];
        assert_eq!(why_of(&svc, &pods), Some(NotServing::Unscheduled));
    }

    #[test]
    fn each_state_a_pod_is_in_names_its_own_reason() {
        let svc = selecting("web");
        let cases = [
            (
                in_state("a", Some("n1"), "Pending", Some("ContainerCreating")),
                NotServing::Starting,
            ),
            (
                in_state("a", Some("n1"), "Running", Some("CrashLoopBackOff")),
                NotServing::CrashLooping,
            ),
            (
                in_state("a", Some("n1"), "Running", None),
                NotServing::FailingReadiness,
            ),
            (
                in_state("a", Some("n1"), "Succeeded", None),
                NotServing::Finished,
            ),
        ];
        for (pod, want) in cases {
            assert_eq!(why_of(&svc, &[pod]), Some(want));
        }

        let mut leaving = in_state("a", Some("n1"), "Running", None);
        leaving.metadata.deletion_timestamp = Some(Time(
            crate::utils::moment::as_cluster_time(chrono::Utc::now()).expect("now is a time"),
        ));
        assert_eq!(why_of(&svc, &[leaving]), Some(NotServing::Terminating));
    }

    /// A crash-looping pod caught in the seconds its container is up read as
    /// one failing its readiness probe. Fails if the stop reads the instant
    /// rather than the loop.
    #[test]
    fn a_crash_looping_pod_caught_while_up_is_still_crash_looping() {
        let svc = selecting("web");
        let mut up = in_state("a", Some("n1"), "Running", None);
        up.status.as_mut().unwrap().container_statuses = Some(vec![ContainerStatus {
            name: "web".to_string(),
            restart_count: 9,
            state: Some(ContainerState {
                running: Some(k8s_openapi::api::core::v1::ContainerStateRunning::default()),
                ..Default::default()
            }),
            last_state: Some(ContainerState {
                terminated: Some(k8s_openapi::api::core::v1::ContainerStateTerminated {
                    exit_code: 1,
                    finished_at: Some(Time(
                        crate::utils::moment::as_cluster_time(chrono::Utc::now())
                            .expect("now is a time"),
                    )),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            ..Default::default()
        }]);
        assert_eq!(why_of(&svc, &[up]), Some(NotServing::CrashLooping));
    }

    #[test]
    fn pods_not_ready_for_different_reasons_are_mixed() {
        let svc = selecting("web");
        let pods = [
            in_state("a", None, "Pending", None),
            in_state("b", Some("n1"), "Running", None),
        ];
        assert_eq!(why_of(&svc, &pods), Some(NotServing::Mixed));
    }

    /// A reader holding the slices alone has no pod to ask, so it says the
    /// slices spoke rather than guess at a state.
    #[test]
    fn a_reader_without_pods_says_the_slices_spoke() {
        let svc = selecting("web");
        let slices = [slice(
            "web-1",
            "web",
            Some(vec![EndpointPort {
                port: Some(80),
                ..Default::default()
            }]),
            vec![Endpoint {
                addresses: vec!["10.0.0.1".to_string()],
                conditions: Some(EndpointConditions {
                    ready: Some(false),
                    serving: Some(false),
                    ..Default::default()
                }),
                ..Default::default()
            }],
        )];
        assert!(matches!(
            stop_of(&svc, &slices, None),
            Some(ChainStop::NoneReady {
                why: NotServing::InSlices,
                ..
            })
        ));
    }

    /// A pending pod has no IP yet. Would break if its row went back to a
    /// stand-in glyph where the address goes, which the page drew as one.
    #[test]
    fn a_pod_with_no_ip_publishes_no_address_rather_than_a_placeholder() {
        let svc = selecting("web");
        let waiting = pod("web-0", None);
        let published = from_pod_readiness(&svc, svc_ref("web"), &[&waiting]);

        assert_eq!(published.endpoints[0].address, None);
    }
}
