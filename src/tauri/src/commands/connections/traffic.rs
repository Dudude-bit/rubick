//! The traffic chain: which Services, Ingresses and routes reach an object,
//! and where a path into it stops.

use super::*;

pub(super) fn service_ref(svc: &Service, ns: &str) -> ObjectRef {
    let spec = svc.spec.as_ref();
    let selector = spec.and_then(|s| s.selector.clone()).unwrap_or_default();
    ObjectRef::new(
        "Service",
        &svc.name_any(),
        Some(ns.to_string()),
        Existence::Present,
    )
    .with_facts(ObjectFacts::Service {
        type_: spec
            .and_then(|s| s.type_.clone())
            .unwrap_or_else(|| "ClusterIP".to_string()),
        cluster_ip: spec.and_then(|s| s.cluster_ip.clone()),
        external_name: spec.and_then(|s| s.external_name.clone()),
        selector: Selector::Equality(&selector).query_text(),
        ports: crate::resources::ServiceInfo::from(svc).ports,
    })
}

pub(super) use crate::resources::published::pod_ref;

pub(super) fn service_selector(svc: &Service) -> BTreeMap<String, String> {
    svc.spec
        .as_ref()
        .and_then(|s| s.selector.clone())
        .unwrap_or_default()
}

/// Every Service in the namespace whose selector matches `labels`, what each
/// of those Services publishes, and the Ingresses that route to them.
///
/// Reachability is judged over what the Service publishes, not only over the
/// subject's own pods — a Service takes traffic when any address behind it
/// does, and that address need not belong to the workload being looked at.
pub(super) fn traffic_into(
    ns: &str,
    target: &ObjectRef,
    labels: &BTreeMap<String, String>,
    own: &[&Pod],
    snapshot: &Snapshot,
    out: &mut Neighbourhood,
) {
    let mut near: Vec<(usize, NearSelector)> = Vec::new();
    let mut selected = false;
    for svc in snapshot.services() {
        let selector = service_selector(svc);
        let Some(text) = Selector::Equality(&selector).says() else {
            continue;
        };
        if Selector::Equality(&selector).matches(labels) != Some(true) {
            if let Some((carries, lacks)) = published::partly_carried(&selector, labels) {
                let short = lacks.split(',').count();
                near.push((
                    short,
                    NearSelector {
                        service: service_ref(svc, ns),
                        carries,
                        lacks,
                    },
                ));
            }
            continue;
        }
        selected = true;
        let svc_ref = service_ref(svc, ns);
        out.edge(
            svc_ref.clone(),
            target.clone(),
            Relation::Selects { selector: text },
        );
        note_reach(svc, &svc_ref, snapshot, out, Carry::Named(own));
        routes_into(ns, &svc_ref, snapshot, out);
        gateway_traffic_into(
            ns,
            &svc_ref,
            &snapshot.gateway_routes,
            snapshot.gateways.as_deref(),
            snapshot.listener_sets.as_deref(),
            snapshot
                .gateway_classes
                .as_ref()
                .map(|read| read.as_deref().map_err(String::as_str)),
            out,
        );
    }
    if !selected {
        let fewest = near.iter().map(|(short, _)| *short).min();
        let closest: Vec<NearSelector> = near
            .into_iter()
            .filter(|(short, _)| Some(*short) == fewest)
            .map(|(_, near)| near)
            .collect();
        out.nearly_selected_by = (!closest.is_empty()).then_some(closest);
    }
}

/// The Gateway API routes whose `backendRefs` name this Service, with the
/// Gateway above each and every stop its status names.
///
/// Stops come from what the controller wrote — `Accepted: False`,
/// `ResolvedRefs: False`, per parent — plus the one thing no condition will
/// ever say: a parentRef naming a Gateway the API server does not have,
/// for which no controller will ever write status at all. A parentRef of
/// any other kind — `Service` is GAMMA/mesh — is recognized and left
/// alone: not a Gateway, so never "a missing Gateway".
/// The paths of a rule's matches, where a match without one is `/`.
fn pasteable_paths(rule: &crate::resources::RouteRuleInfo) -> Vec<String> {
    if rule.matches.is_empty() {
        return vec!["/".into()];
    }
    let mut paths: Vec<String> = rule
        .matches
        .iter()
        .filter(|m| m.path_type.as_deref() != Some("RegularExpression"))
        .map(|m| m.path.clone().unwrap_or_else(|| "/".into()))
        .collect();
    paths.dedup();
    paths
}

pub(super) fn gateway_traffic_into(
    ns: &str,
    svc_ref: &ObjectRef,
    routes: &[crate::resources::RouteInfo],
    gateways: Option<&[crate::resources::GatewayInfo]>,
    sets: Option<&[crate::resources::ListenerSetInfo]>,
    classes: Option<std::result::Result<&[crate::resources::GatewayClassInfo], &str>>,
    out: &mut Neighbourhood,
) {
    for route in routes {
        let backends: Vec<_> = route
            .rules
            .iter()
            .flat_map(|rule| rule.backend_refs.iter().map(move |b| (rule, b)))
            .filter(|(_, b)| {
                b.kind == "Service"
                    && b.group.is_empty()
                    && b.name == svc_ref.name
                    && b.namespace.as_deref().unwrap_or(&route.namespace) == ns
            })
            .collect();
        if backends.is_empty() {
            continue;
        }

        let route_ref = ObjectRef::new(
            &route.kind,
            &route.name,
            Some(route.namespace.clone()),
            Existence::Present,
        );

        for (rule, backend) in backends {
            out.edge(
                route_ref.clone(),
                svc_ref.clone(),
                Relation::RuleRoutes {
                    hostnames: route.hostnames.clone(),
                    port: backend.port.map(|p| p.to_string()),
                    weight: backend.weight,
                    paths: pasteable_paths(rule),
                },
            );
        }

        route_parents(route, &route_ref, gateways, sets, classes, out);
    }
}

/// A route's `parentRefs[]`: the Gateway above it, and every stop its status
/// names about each parent.
pub(super) fn route_parents(
    route: &crate::resources::RouteInfo,
    route_ref: &ObjectRef,
    gateways: Option<&[crate::resources::GatewayInfo]>,
    // Every ListenerSet, or `None` where they were not read.
    sets: Option<&[crate::resources::ListenerSetInfo]>,
    // Every GatewayClass, the cluster's words where they could not be read,
    // or `None` from a caller that does not ask about classes.
    classes: Option<std::result::Result<&[crate::resources::GatewayClassInfo], &str>>,
    out: &mut Neighbourhood,
) {
    use crate::resources::{programmed, verdict_of, Verdict, GATEWAY_API_GROUP};

    for parent in &route.parent_refs {
        // A route may name a `ListenerSet` instead of the Gateway; the set
        // carries its own `spec.parentRef`, and `GatewayInfo` keeps the
        // ones that named it. Skipping those here left the chain with no
        // `attachesTo` edge, so the peek panel called the route mesh while
        // the routes list traced it to a Gateway — one object, two answers.
        let via_set = parent.kind == "ListenerSet" && parent.group == GATEWAY_API_GROUP;
        if !via_set && (parent.kind != "Gateway" || parent.group != GATEWAY_API_GROUP) {
            continue;
        }
        let gw_ns = parent
            .namespace
            .clone()
            .unwrap_or_else(|| route.namespace.clone());
        let (found, gw_ref, through) = parent_at(parent, &gw_ns, via_set, gateways, sets);
        if gw_ref.existence == Existence::Missing {
            out.stops.push(ChainStop::GatewayMissing {
                route: route_ref.clone(),
                gateway: gw_ref.clone(),
                listener_set: through,
            });
        }
        if let (Some(g), Some(Err(said))) = (found, classes) {
            out.stops.push(ChainStop::GatewayClassUnread {
                route: route_ref.clone(),
                gateway: gw_ref.clone(),
                class: g.class_name.clone(),
                said: said.to_string(),
            });
        }
        if let (Some(g), Some(Ok(classes))) = (found, classes) {
            match classes.iter().find(|class| class.name == g.class_name) {
                None => out.stops.push(ChainStop::GatewayClassMissing {
                    route: route_ref.clone(),
                    gateway: gw_ref.clone(),
                    class: g.class_name.clone(),
                }),
                Some(class) if class.accepted != Some(true) => {
                    let refused = class
                        .conditions
                        .iter()
                        .find(|c| c.type_ == "Accepted" && c.status == "False");
                    out.stops.push(ChainStop::GatewayClassUnclaimed {
                        route: route_ref.clone(),
                        gateway: gw_ref.clone(),
                        class: g.class_name.clone(),
                        controller: class.controller_name.clone(),
                        refused: refused.is_some(),
                        condition_reason: refused.and_then(|c| c.reason.clone()),
                        message: refused.and_then(|c| shown(c.message.as_ref())),
                    });
                }
                Some(_) => {}
            }
        }
        if let Some(said) = found
            .and_then(|g| programmed(&g.conditions))
            .filter(|said| said.status == "False")
        {
            out.stops.push(ChainStop::GatewayNotProgrammed {
                route: route_ref.clone(),
                gateway: gw_ref.clone(),
                condition_type: said.type_.clone(),
                condition_reason: said.reason.clone(),
                message: shown(said.message.as_ref()),
            });
        }
        out.edge(
            route_ref.clone(),
            gw_ref.clone(),
            Relation::AttachesTo {
                section_name: parent.section_name.clone(),
                port: parent.port,
                listener_set: via_set.then(|| crate::resources::ObjectName {
                    name: parent.name.clone(),
                    namespace: gw_ns.clone(),
                }),
            },
        );

        // Every entry for this attachment, read by the one rule the
        // trace and the Gateway page read it by.
        let entries = route.statuses_for(parent);
        if let Verdict::False(said) = verdict_of(&entries, "Accepted") {
            out.stops.push(ChainStop::RouteNotAccepted {
                route: route_ref.clone(),
                gateway: gw_ref.clone(),
                condition_reason: said.reason.clone(),
                message: shown(said.message.as_ref()),
            });
        }
        if let Verdict::False(said) = verdict_of(&entries, "ResolvedRefs") {
            out.stops.push(ChainStop::RouteRefsUnresolved {
                route: route_ref.clone(),
                condition_reason: said.reason.clone(),
                message: shown(said.message.as_ref()),
            });
        }
    }
}

/// Where a parentRef leads, as the Routes trace resolves it too (held to it
/// by `parent-resolution-conformance.json`): the Gateway it reaches, the ref
/// the chain draws, and the `ListenerSet` it went through where that set is
/// there. A set that is there leads to the Gateway it names, and that is the
/// one missing; a set that is not there is named itself. Either is missing
/// only where the list that would hold it was read.
pub(super) fn parent_at<'a>(
    parent: &crate::resources::ParentRefInfo,
    namespace: &str,
    via_set: bool,
    gateways: Option<&'a [crate::resources::GatewayInfo]>,
    sets: Option<&[crate::resources::ListenerSetInfo]>,
) -> (
    Option<&'a crate::resources::GatewayInfo>,
    ObjectRef,
    Option<crate::resources::ObjectName>,
) {
    let named = |name: &str, namespace: &str| {
        gateways.and_then(|list| {
            list.iter()
                .find(|g| g.name == name && g.namespace == namespace)
        })
    };
    let ref_to = |kind: &str, name: &str, namespace: &str, read: bool| {
        ObjectRef::new(
            kind,
            name,
            Some(namespace.to_string()),
            if read {
                Existence::Missing
            } else {
                Existence::NotChecked
            },
        )
    };
    if !via_set {
        return match named(&parent.name, namespace) {
            Some(g) => (Some(g), gateway_ref(g), None),
            None => (
                None,
                ref_to("Gateway", &parent.name, namespace, gateways.is_some()),
                None,
            ),
        };
    }
    let through = crate::resources::ObjectName {
        name: parent.name.clone(),
        namespace: namespace.to_string(),
    };
    // The Gateways keep the sets that named them; the sets themselves say
    // which Gateway, there or not, each one names.
    let kept = gateways.and_then(|list| list.iter().find(|g| g.listener_sets.contains(&through)));
    if let Some(g) = kept {
        return (Some(g), gateway_ref(g), Some(through));
    }
    let Some(sets) = sets else {
        return (
            None,
            ref_to("ListenerSet", &parent.name, namespace, false),
            None,
        );
    };
    let Some(set) = sets
        .iter()
        .find(|set| set.name == through.name && set.namespace == through.namespace)
    else {
        return (
            None,
            ref_to("ListenerSet", &parent.name, namespace, true),
            None,
        );
    };
    match named(&set.gateway_name, &set.gateway_namespace) {
        Some(g) => (Some(g), gateway_ref(g), Some(through)),
        None => (
            None,
            ref_to(
                "Gateway",
                &set.gateway_name,
                &set.gateway_namespace,
                gateways.is_some(),
            ),
            Some(through),
        ),
    }
}

/// A controller's own words as a stop carries them to the screen: through
/// the one door, which never lets a private key out.
fn shown(message: Option<&String>) -> Option<String> {
    message.map(|text| crate::resources::shown_text(text))
}

/// A Gateway as the chain draws it.
pub(super) fn gateway_ref(g: &crate::resources::GatewayInfo) -> ObjectRef {
    ObjectRef::new(
        "Gateway",
        &g.name,
        Some(g.namespace.clone()),
        Existence::Present,
    )
    .with_facts(ObjectFacts::Gateway {
        class_name: g.class_name.clone(),
        listeners: g.listeners.clone(),
    })
}

/// The Ingresses whose backend names this Service.
pub(super) fn routes_into(
    ns: &str,
    svc_ref: &ObjectRef,
    snapshot: &Snapshot,
    out: &mut Neighbourhood,
) {
    for ing in snapshot.ingresses() {
        for (backend, relation) in ingress_backends(ing) {
            if backend != Backend::Service(svc_ref.name.clone()) {
                continue;
            }
            out.edge(ingress_ref(ing, ns), svc_ref.clone(), relation);
        }
    }
}

/// How much of what a Service publishes an answer carries.
#[derive(Clone, Copy)]
pub(super) enum Carry<'a> {
    /// Every address, and the pods it does not publish.
    Whole,
    /// The counts and the addresses a chain names: these pods', where it
    /// publishes any, or else the first taking traffic.
    Named(&'a [&'a Pod]),
}

/// What this Service publishes, and where the path stops if it does.
///
/// The last hop is the Service's own slices, not one `Selects` edge per
/// selected pod: three objects rather than 300 pod refs on a 300-pod Service,
/// and the cluster's own answer rather than a deduction — the two disagree in
/// exactly the cases nobody can see.
///
/// A Service with no selector is not a stop: an `ExternalName` resolves
/// elsewhere and a hand-managed one has endpoints this app never wrote — but
/// what it publishes is still read and still drawn, because a slice is a
/// slice however it got written.
///
/// `carry` is [`Carry::Whole`] on this Service's own page, where the
/// endpoint rows and the pods it does not publish are the point rather than a
/// payload every other page would carry for nothing.
pub(super) fn note_reach(
    svc: &Service,
    svc_ref: &ObjectRef,
    snapshot: &Snapshot,
    out: &mut Neighbourhood,
    carry: Carry<'_>,
) {
    if out
        .published
        .iter()
        .any(|entry| entry.service.same_object(svc_ref))
    {
        return;
    }

    let selector = service_selector(svc);
    let query = Selector::Equality(&selector);
    let selected: Vec<&Pod> = snapshot
        .pods()
        .iter()
        .filter(|pod| query.matches(pod.labels()) == Some(true))
        .collect();

    // Empty because nothing matched, or because nobody could read the pods?
    // Only the first is "no pod carries this"; for the second the rule gets
    // `None` and says what the endpoints alone can.
    let pods = snapshot.pods.is_ok().then_some(selected.as_slice());
    let makers = snapshot.makers();
    // Nothing read of it leaves no answer here; `unanswered` names why.
    let Some(published) = snapshot.published_of(svc, svc_ref.clone(), &selected) else {
        return;
    };
    let published = published
        .with_stop(svc, pods)
        .with_policies(svc, snapshot.policies.as_deref(), &snapshot.others)
        .with_makers(svc, &makers, snapshot.makers_read())
        .with_workloads(svc, &makers, pods, chrono::Utc::now())
        .with_near_miss(svc, snapshot.pods());
    let stop = published.stop.clone();
    out.published.push(match carry {
        Carry::Whole => published,
        Carry::Named(own) => published.summary_keeping(|target| {
            target.kind == "Pod" && own.iter().any(|pod| pod.name_any() == target.name)
        }),
    });
    if let Some(stop) = stop {
        out.stops.push(stop);
    }
}

pub(super) fn ingress_ref(ing: &Ingress, ns: &str) -> ObjectRef {
    ObjectRef::new(
        "Ingress",
        &ing.name_any(),
        Some(ns.to_string()),
        Existence::Present,
    )
    .with_facts(ObjectFacts::Ingress {
        class_name: crate::resources::ingress_class(ing).0,
    })
}

#[derive(PartialEq, Eq)]
pub(super) enum Backend {
    Service(String),
    /// A backend that names an API object instead of a Service. The app does
    /// not follow it, and says so rather than dropping the path.
    Resource {
        kind: String,
        name: String,
    },
}

/// Every backend an Ingress states, with the route that reaches it.
pub(super) fn ingress_backends(ing: &Ingress) -> Vec<(Backend, Relation)> {
    let Some(spec) = ing.spec.as_ref() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for rule in spec.rules.iter().flatten() {
        let host = rule.host.clone();
        let tls = tls_covers(ing, host.as_deref());
        for path in rule.http.iter().flat_map(|http| &http.paths) {
            if let Some((backend, port)) = path_backend(path) {
                out.push((
                    backend,
                    Relation::Routes {
                        host: host.clone(),
                        path: path.path.clone().unwrap_or_else(|| "/".to_string()),
                        path_type: path.path_type.clone(),
                        port,
                        tls,
                    },
                ));
            }
        }
    }

    // `spec.defaultBackend` is a route too — for a rules-less Ingress it is
    // the whole object, the ordinary way a cloud load balancer fronts an
    // in-cluster proxy. Without this edge the graph drew such an Ingress as
    // touching nothing: an empty chain and an empty Connections tab.
    if let Some(fallback) = spec.default_backend.as_ref() {
        if let Some((backend, port)) = backend_of(fallback) {
            out.push((
                backend,
                Relation::Routes {
                    host: None,
                    path: "*".to_string(),
                    path_type: "DefaultBackend".to_string(),
                    port,
                    tls: tls_covers(ing, None),
                },
            ));
        }
    }
    out
}

pub(super) fn path_backend(path: &HTTPIngressPath) -> Option<(Backend, Option<String>)> {
    backend_of(&path.backend)
}

pub(super) fn backend_of(backend: &IngressBackend) -> Option<(Backend, Option<String>)> {
    if let Some(svc) = &backend.service {
        let port = svc.port.as_ref().and_then(|p| {
            p.name
                .clone()
                .or_else(|| p.number.map(|number| number.to_string()))
        });
        return Some((Backend::Service(svc.name.clone()), port));
    }
    let resource = backend.resource.as_ref()?;
    Some((
        Backend::Resource {
            kind: resource.kind.clone(),
            name: resource.name.clone(),
        },
        None,
    ))
}

/// Whether `spec.tls` covers a host. A TLS block with no hosts is the
/// catch-all the API defines, and a leading `*.` matches one label.
pub(super) fn tls_covers(ing: &Ingress, host: Option<&str>) -> bool {
    let Some(spec) = ing.spec.as_ref() else {
        return false;
    };
    spec.tls.iter().flatten().any(|tls| {
        let hosts = tls.hosts.clone().unwrap_or_default();
        if hosts.is_empty() {
            return true;
        }
        let Some(host) = host else { return false };
        hosts.iter().any(|candidate| {
            candidate == host
                || candidate
                    .strip_prefix("*.")
                    .and_then(|suffix| host.split_once('.').map(|(_, rest)| rest == suffix))
                    .unwrap_or(false)
        })
    })
}

#[cfg(test)]
mod ingress_backend_tests {
    use super::*;
    use k8s_openapi::api::networking::v1::{
        IngressBackend, IngressServiceBackend, IngressSpec, IngressTLS, ServiceBackendPort,
    };

    /// The graph names an Ingress's class beside it, by the reading its
    /// page uses. Fails if the graph goes back to `spec` alone, which calls
    /// an annotated Ingress classless on one screen and classed on the next.
    #[test]
    fn an_ingress_in_the_graph_carries_the_class_its_annotation_names() {
        let mut ingress = Ingress::default();
        ingress
            .annotations_mut()
            .insert("kubernetes.io/ingress.class".into(), "alb".into());

        let facts = ingress_ref(&ingress, "shop").facts;
        assert!(
            matches!(&facts, Some(ObjectFacts::Ingress { class_name }) if class_name.as_deref() == Some("alb")),
            "{facts:?}"
        );
    }

    /// A defaultBackend-only Ingress is how a cloud load balancer fronts an
    /// in-cluster proxy, and the connections graph used to draw it as
    /// touching nothing — an empty chain and an empty tab on the one
    /// Ingress the reported cluster has.
    #[test]
    fn default_backend_is_an_edge() {
        let ingress = Ingress {
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
                tls: Some(vec![IngressTLS {
                    hosts: None,
                    secret_name: Some("wildcard-tls".into()),
                }]),
                ..Default::default()
            }),
            ..Default::default()
        };

        let backends = ingress_backends(&ingress);
        assert_eq!(backends.len(), 1);
        let (backend, relation) = &backends[0];
        assert!(matches!(backend, Backend::Service(name) if name == "traefik"));
        match relation {
            Relation::Routes {
                host,
                path,
                path_type,
                port,
                tls,
            } => {
                assert_eq!(host.as_deref(), None);
                assert_eq!(path, "*");
                assert_eq!(path_type, "DefaultBackend");
                assert_eq!(port.as_deref(), Some("80"));
                assert!(*tls);
            }
            other => panic!("expected Routes, got {other:?}"),
        }
    }
}

#[cfg(test)]
mod gateway_traffic_tests {
    use super::*;
    use crate::resources::{GatewayInfo, RouteInfo};

    fn route(yaml: &str) -> RouteInfo {
        RouteInfo::read(&serde_yaml::from_str(yaml).expect("route fixture parses"))
    }

    fn gateway(yaml: &str) -> GatewayInfo {
        GatewayInfo::read(&serde_yaml::from_str(yaml).expect("gateway fixture parses"))
    }

    fn service(ns: &str, name: &str) -> ObjectRef {
        ObjectRef::new("Service", name, Some(ns.to_string()), Existence::Present)
    }

    const EDGE_GATEWAY: &str = r"
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata: { name: edge, namespace: shop }
spec: { gatewayClassName: envoy }
";

    const HEALTHY_ROUTE: &str = r#"
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata: { name: promo, namespace: shop }
spec:
  parentRefs:
  - { name: edge, sectionName: https }
  hostnames: [promo.example.com]
  rules:
  - backendRefs:
    - { name: promo, port: 8080 }
status:
  parents:
  - parentRef: { name: edge, sectionName: https }
    controllerName: example.net/gw
    conditions:
    - { type: Accepted, status: "True", reason: Accepted, message: ok }
    - { type: ResolvedRefs, status: "True", reason: ResolvedRefs, message: ok }
"#;

    fn class(name: &str, accepted: Option<&str>) -> crate::resources::GatewayClassInfo {
        let status = accepted.map_or(String::new(), |status| {
            format!(
                "status: {{ conditions: [{{ type: Accepted, status: \"{status}\", reason: InvalidParameters, message: bad params }}] }}"
            )
        });
        crate::resources::GatewayClassInfo::read(
            &serde_yaml::from_str(&format!(
                "apiVersion: gateway.networking.k8s.io/v1\nkind: GatewayClass\nmetadata: {{ name: {name} }}\nspec: {{ controllerName: example.net/gw }}\n{status}"
            ))
            .expect("class fixture parses"),
        )
    }

    /// The Routes page said "nothing claims class envoy" of a route the
    /// Connections tab drew without a break: the chain never read the
    /// classes. Fails if a missing or unclaimed class is not a stop, if a
    /// refusal loses its words, or if a claimed class is one.
    #[test]
    fn a_gateway_whose_class_nothing_claims_stops_the_route_as_the_routes_page_says() {
        let stops =
            |classes: Option<std::result::Result<&[crate::resources::GatewayClassInfo], &str>>| {
                let mut out = Neighbourhood::new();
                gateway_traffic_into(
                    "shop",
                    &service("shop", "promo"),
                    &[route(HEALTHY_ROUTE)],
                    Some(&[gateway(EDGE_GATEWAY)]),
                    None,
                    classes,
                    &mut out,
                );
                out.stops
            };
        assert!(matches!(
            stops(Some(Ok(&[]))).as_slice(),
            [ChainStop::GatewayClassMissing { class, .. }] if class == "envoy"
        ));
        assert!(matches!(
            stops(Some(Ok(&[class("envoy", None)]))).as_slice(),
            [ChainStop::GatewayClassUnclaimed { class, controller, refused: false, condition_reason: None, .. }]
                if class == "envoy" && controller == "example.net/gw"
        ));
        assert!(matches!(
            stops(Some(Ok(&[class("envoy", Some("False"))]))).as_slice(),
            [ChainStop::GatewayClassUnclaimed { refused: true, condition_reason: Some(reason), message: Some(message), .. }]
                if reason == "InvalidParameters" && message == "bad params"
        ));
        assert!(stops(Some(Ok(&[class("envoy", Some("True"))]))).is_empty());
        assert!(stops(None).is_empty());

        // A controller that wrote a private key into its message: the stop
        // carries the placeholder, never the key.
        let mut keyed = class("envoy", Some("False"));
        keyed.conditions[0].message = Some(
            "-----BEGIN PRIVATE KEY-----\nTUFERS1VUC1LRVk=\n-----END PRIVATE KEY-----\n".into(),
        );
        assert!(matches!(
            stops(Some(Ok(&[keyed]))).as_slice(),
            [ChainStop::GatewayClassUnclaimed { message: Some(message), .. }]
                if message == crate::resources::WITHHELD_MARKER
        ));
    }

    /// A route's refusal carried its controller's message to the screen as
    /// written. Fails if a stop the route's own status names carries a
    /// private key rather than the placeholder.
    #[test]
    fn a_route_stop_carries_its_controller_s_words_only_through_the_door() {
        let key = "-----BEGIN PRIVATE KEY-----\nTUFERS1VUC1LRVk=\n-----END PRIVATE KEY-----\n";
        let mut refused = route(HEALTHY_ROUTE);
        for condition in &mut refused.parents[0].conditions {
            condition.status = "False".into();
            condition.message = Some(key.into());
        }
        let mut edge = gateway(EDGE_GATEWAY);
        edge.conditions = vec![crate::resources::ConditionInfo {
            type_: "Programmed".into(),
            status: "False".into(),
            reason: Some("Invalid".into()),
            message: Some(key.into()),
            last_transition_time: None,
            observed_generation: None,
        }];
        let mut out = Neighbourhood::new();
        gateway_traffic_into(
            "shop",
            &service("shop", "promo"),
            &[refused],
            Some(&[edge]),
            None,
            None,
            &mut out,
        );
        let messages: Vec<&Option<String>> = out
            .stops
            .iter()
            .filter_map(|stop| match stop {
                ChainStop::RouteNotAccepted { message, .. }
                | ChainStop::RouteRefsUnresolved { message, .. }
                | ChainStop::GatewayNotProgrammed { message, .. } => Some(message),
                _ => None,
            })
            .collect();
        assert_eq!(messages.len(), 3, "{:?}", out.stops);
        for message in messages {
            assert_eq!(message.as_deref(), Some(crate::resources::WITHHELD_MARKER));
        }
    }

    /// Classes the token could not list left the chain with no stop at all,
    /// which reads as "the class is claimed" and drew the route serving.
    /// Fails if a Gateway whose class was not read is not a blind stop that
    /// carries the cluster's words.
    #[test]
    fn a_gateway_whose_class_could_not_be_read_is_a_blind_stop() {
        let mut out = Neighbourhood::new();
        gateway_traffic_into(
            "shop",
            &service("shop", "promo"),
            &[route(HEALTHY_ROUTE)],
            Some(&[gateway(EDGE_GATEWAY)]),
            None,
            Some(Err("gatewayclasses is forbidden")),
            &mut out,
        );
        assert!(matches!(
            out.stops.as_slice(),
            [ChainStop::GatewayClassUnread { class, said, .. }]
                if class == "envoy" && said == "gatewayclasses is forbidden"
        ));
    }

    #[test]
    fn backend_ref_becomes_an_edge_and_the_gateway_sits_above() {
        let mut out = Neighbourhood::new();
        gateway_traffic_into(
            "shop",
            &service("shop", "promo"),
            &[route(HEALTHY_ROUTE)],
            Some(&[gateway(EDGE_GATEWAY)]),
            None,
            None,
            &mut out,
        );

        assert!(out.stops.is_empty());

        let to_service = out
            .edges
            .iter()
            .find(|e| e.to.kind == "Service")
            .expect("route -> service edge");
        assert_eq!(to_service.from.kind, "HTTPRoute");
        assert_eq!(to_service.from.name, "promo");
        match &to_service.relation {
            Relation::RuleRoutes {
                hostnames,
                port,
                weight,
                paths,
            } => {
                assert_eq!(paths, &["/"]);
                assert_eq!(hostnames, &vec!["promo.example.com".to_string()]);
                assert_eq!(port.as_deref(), Some("8080"));
                assert_eq!(*weight, None);
            }
            other => panic!("expected RuleRoutes, got {other:?}"),
        }

        let to_gateway = out
            .edges
            .iter()
            .find(|e| e.to.kind == "Gateway")
            .expect("route -> gateway edge");
        assert_eq!(to_gateway.to.name, "edge");
        assert!(matches!(to_gateway.to.existence, Existence::Present));
        assert!(matches!(
            &to_gateway.relation,
            Relation::AttachesTo { section_name, .. } if section_name.as_deref() == Some("https")
        ));
        assert!(matches!(
            &to_gateway.to.facts,
            Some(ObjectFacts::Gateway { class_name, .. }) if class_name == "envoy"
        ));
    }

    /// A route's address is composed from these on the frontend; without
    /// the rule's paths, the parentRef's port and the Gateway's listeners a
    /// Gateway API route hands the chain no URL at all.
    #[test]
    fn a_route_edge_carries_its_pasteable_paths_and_the_gateway_its_listeners() {
        let mut out = Neighbourhood::new();
        gateway_traffic_into(
            "shop",
            &service("shop", "promo"),
            &[route(
                r#"
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata: { name: api, namespace: shop }
spec:
  parentRefs:
  - { name: edge, port: 8443 }
  hostnames: [api.example.com]
  rules:
  - matches:
    - path: { type: PathPrefix, value: /api }
    - path: { type: RegularExpression, value: "/v[0-9]+" }
    - headers: [{ name: x-beta, value: "1" }]
    backendRefs:
    - { name: promo, port: 8080 }
"#,
            )],
            Some(&[gateway(
                r#"
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata: { name: edge, namespace: shop }
spec:
  gatewayClassName: envoy
  listeners:
  - { name: https, protocol: HTTPS, port: 8443, hostname: "*.example.com" }
"#,
            )]),
            None,
            None,
            &mut out,
        );

        let edge_to = |kind: &str| {
            out.edges
                .iter()
                .find(|e| e.to.kind == kind)
                .unwrap_or_else(|| panic!("an edge to a {kind}"))
        };
        match &edge_to("Service").relation {
            Relation::RuleRoutes { paths, .. } => assert_eq!(paths, &["/api", "/"]),
            other => panic!("expected RuleRoutes, got {other:?}"),
        }
        let up = edge_to("Gateway");
        match &up.relation {
            Relation::AttachesTo {
                port, listener_set, ..
            } => {
                assert_eq!(*port, Some(8443));
                assert!(listener_set.is_none());
            }
            other => panic!("expected AttachesTo, got {other:?}"),
        }
        match &up.to.facts {
            Some(ObjectFacts::Gateway { listeners, .. }) => {
                assert_eq!(listeners.len(), 1);
                assert_eq!(listeners[0].port, 8443);
                assert_eq!(listeners[0].hostname.as_deref(), Some("*.example.com"));
            }
            other => panic!("expected Gateway facts, got {other:?}"),
        }
    }

    /// A route through a `ListenerSet` reaches only the set's listeners;
    /// without the set on the edge its address would be composed against
    /// every listener the Gateway carries.
    #[test]
    fn a_route_through_a_listener_set_names_the_set_on_its_edge() {
        let team = crate::resources::ObjectName {
            name: "team".into(),
            namespace: "shop".into(),
        };
        let mut edge = gateway(EDGE_GATEWAY);
        edge.listener_sets = vec![team.clone()];
        edge.listener_sets_known = true;
        let mut out = Neighbourhood::new();
        gateway_traffic_into(
            "shop",
            &service("shop", "promo"),
            &[route(
                r"
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata: { name: promo, namespace: shop }
spec:
  parentRefs:
  - { group: gateway.networking.k8s.io, kind: ListenerSet, name: team }
  rules:
  - backendRefs:
    - { name: promo, port: 8080 }
",
            )],
            Some(&[edge]),
            None,
            None,
            &mut out,
        );

        let up = out
            .edges
            .iter()
            .find(|e| e.to.kind == "Gateway")
            .expect("route -> gateway edge");
        assert_eq!(up.to.name, "edge");
        assert!(matches!(
            &up.relation,
            Relation::AttachesTo { listener_set: Some(set), .. } if *set == team
        ));
    }

    /// A route through a `ListenerSet` that exists, whose Gateway is the one
    /// not there, was told the set did not exist. Fails if the chain does
    /// not name the set's Gateway as the missing one, does not call a set
    /// that is not there missing, or calls either missing where the list
    /// that would hold it was not read.
    #[test]
    fn a_route_through_a_listener_set_names_what_is_missing_behind_it() {
        let team = crate::resources::ListenerSetInfo {
            name: "team".into(),
            namespace: "shop".into(),
            gateway_name: "edge".into(),
            gateway_namespace: "infra".into(),
            listeners: Vec::new(),
            conditions: Vec::new(),
            created_at: None,
        };
        let through = |gateways: Option<&[GatewayInfo]>,
                       sets: Option<&[crate::resources::ListenerSetInfo]>| {
            let mut out = Neighbourhood::new();
            gateway_traffic_into(
                "shop",
                &service("shop", "promo"),
                &[route(
                    r"
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata: { name: promo, namespace: shop }
spec:
  parentRefs:
  - { group: gateway.networking.k8s.io, kind: ListenerSet, name: team }
  rules:
  - backendRefs:
    - { name: promo, port: 8080 }
",
                )],
                gateways,
                sets,
                None,
                &mut out,
            );
            let up = out
                .edges
                .iter()
                .find(|e| matches!(e.relation, Relation::AttachesTo { .. }))
                .expect("the route names its parent")
                .to
                .clone();
            let stops: Vec<String> = out
                .stops
                .iter()
                .map(|stop| match stop {
                    ChainStop::GatewayMissing {
                        gateway,
                        listener_set,
                        ..
                    } => format!(
                        "missing {}/{}{}",
                        gateway.kind,
                        gateway.name,
                        listener_set
                            .as_ref()
                            .map(|set| format!(" via {}", set.name))
                            .unwrap_or_default()
                    ),
                    other => format!("{other:?}"),
                })
                .collect();
            (
                format!(
                    "{} {}/{}",
                    up.kind,
                    up.namespace.unwrap_or_default(),
                    up.name
                ),
                up.existence,
                stops,
            )
        };
        let sets = std::slice::from_ref(&team);
        assert_eq!(
            through(Some(&[]), Some(sets)),
            (
                "Gateway infra/edge".into(),
                Existence::Missing,
                vec!["missing Gateway/edge via team".into()]
            )
        );
        assert_eq!(
            through(Some(&[]), Some(&[])),
            (
                "ListenerSet shop/team".into(),
                Existence::Missing,
                vec!["missing ListenerSet/team".into()]
            )
        );
        assert_eq!(
            through(Some(&[]), None),
            (
                "ListenerSet shop/team".into(),
                Existence::NotChecked,
                vec![]
            )
        );
        assert_eq!(
            through(None, Some(sets)),
            ("Gateway infra/edge".into(), Existence::NotChecked, vec![])
        );
        let mut edge = gateway(EDGE_GATEWAY);
        edge.namespace = "infra".into();
        assert_eq!(
            through(Some(&[edge]), Some(sets)),
            ("Gateway infra/edge".into(), Existence::Present, vec![])
        );
    }

    /// The chain and the Routes trace resolve a parentRef by one rule; a case
    /// one side answers differently is two screens naming different objects
    /// missing for one route.
    #[test]
    fn a_parent_resolves_as_the_shared_corpus_says() {
        let corpus: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../contracts/parent-resolution-conformance.json"
        ))
        .expect("the corpus parses");
        let text = |value: &serde_json::Value, key: &str| value[key].as_str().map(str::to_string);
        for case in corpus["cases"].as_array().expect("cases") {
            let name = case["name"].as_str().expect("a name");
            let route_ns = text(case, "routeNamespace").expect("a namespace");
            let short = &case["parent"];
            let parent = crate::resources::ParentRefInfo {
                group: text(short, "group")
                    .unwrap_or_else(|| crate::resources::GATEWAY_API_GROUP.into()),
                kind: text(short, "kind").unwrap_or_else(|| "Gateway".into()),
                name: text(short, "name").expect("a parent name"),
                namespace: text(short, "namespace"),
                section_name: None,
                port: None,
            };
            let gateways: Option<Vec<GatewayInfo>> = case["gateways"].as_array().map(|list| {
                list.iter()
                    .map(|entry| {
                        let mut g = gateway(&format!(
                            "apiVersion: gateway.networking.k8s.io/v1\nkind: Gateway\nmetadata: {{ name: {}, namespace: {} }}\nspec: {{ gatewayClassName: envoy }}\n",
                            entry["name"].as_str().expect("a name"),
                            entry["namespace"].as_str().expect("a namespace"),
                        ));
                        g.listener_sets = entry["listenerSets"]
                            .as_array()
                            .map(|sets| {
                                sets.iter()
                                    .map(|set| crate::resources::ObjectName {
                                        name: text(set, "name").expect("a name"),
                                        namespace: text(set, "namespace").expect("a namespace"),
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();
                        g
                    })
                    .collect()
            });
            let sets: Option<Vec<crate::resources::ListenerSetInfo>> =
                case["sets"].as_array().map(|list| {
                    list.iter()
                        .map(|set| crate::resources::ListenerSetInfo {
                            name: text(set, "name").expect("a name"),
                            namespace: text(set, "namespace").expect("a namespace"),
                            gateway_name: text(&set["gateway"], "name").expect("a Gateway"),
                            gateway_namespace: text(&set["gateway"], "namespace")
                                .expect("a namespace"),
                            listeners: Vec::new(),
                            conditions: Vec::new(),
                            created_at: None,
                        })
                        .collect()
                });
            let at_ns = parent.namespace.clone().unwrap_or(route_ns);
            let via_set = parent.kind == "ListenerSet";
            let (found, drawn, via) = parent_at(
                &parent,
                &at_ns,
                via_set,
                gateways.as_deref(),
                sets.as_deref(),
            );
            let state = match (found, drawn.existence) {
                (Some(_), _) => "found",
                (None, Existence::Missing) => "missing",
                (None, _) => "unread",
            };
            let expected = &case["at"];
            assert_eq!(
                (
                    state,
                    drawn.kind.as_str(),
                    drawn.name.as_str(),
                    drawn.namespace.as_deref(),
                    via.map(|set| (set.name, set.namespace)),
                ),
                (
                    expected["state"].as_str().expect("a state"),
                    expected["kind"].as_str().expect("a kind"),
                    expected["name"].as_str().expect("a name"),
                    expected["namespace"].as_str(),
                    text(&expected["via"], "name").zip(text(&expected["via"], "namespace")),
                ),
                "{name}"
            );
        }
    }

    #[test]
    fn a_route_naming_another_service_draws_nothing() {
        let mut out = Neighbourhood::new();
        gateway_traffic_into(
            "shop",
            &service("shop", "checkout"),
            &[route(HEALTHY_ROUTE)],
            Some(&[gateway(EDGE_GATEWAY)]),
            None,
            None,
            &mut out,
        );
        assert!(out.edges.is_empty());
        assert!(out.stops.is_empty());
    }

    #[test]
    fn cross_namespace_backend_ref_does_not_match_by_name_alone() {
        // The route names `promo` in the `audit` namespace; the subject is
        // `promo` in `shop`. Same name, different Service.
        let cross = r"
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata: { name: promo, namespace: shop }
spec:
  rules:
  - backendRefs:
    - { name: promo, namespace: audit, port: 8080 }
";
        let mut out = Neighbourhood::new();
        gateway_traffic_into(
            "shop",
            &service("shop", "promo"),
            &[route(cross)],
            Some(&[]),
            None,
            None,
            &mut out,
        );
        assert!(out.edges.is_empty());
    }

    #[test]
    fn accepted_false_is_a_stop_in_the_controllers_words() {
        let refused = r#"
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata: { name: promo, namespace: shop }
spec:
  parentRefs:
  - { name: edge }
  hostnames: [promo.example.com]
  rules:
  - backendRefs:
    - { name: promo, port: 8080 }
status:
  parents:
  - parentRef: { name: edge }
    controllerName: example.net/gw
    conditions:
    - { type: Accepted, status: "False", reason: NoMatchingListenerHostname, message: no listener matches }
"#;
        let mut out = Neighbourhood::new();
        gateway_traffic_into(
            "shop",
            &service("shop", "promo"),
            &[route(refused)],
            Some(&[gateway(EDGE_GATEWAY)]),
            None,
            None,
            &mut out,
        );

        let stop = out.stops.first().expect("a stop");
        match stop {
            ChainStop::RouteNotAccepted {
                route,
                gateway,
                condition_reason,
                ..
            } => {
                assert_eq!(route.name, "promo");
                assert_eq!(gateway.name, "edge");
                assert_eq!(
                    condition_reason.as_deref(),
                    Some("NoMatchingListenerHostname")
                );
            }
            other => panic!("expected RouteNotAccepted, got {other:?}"),
        }
    }

    /// Two controllers wrote entries for one Gateway and disagree. Reading
    /// the first entry alone drew no stop here while the Gateway page, the
    /// map and the trace said refused.
    #[test]
    fn a_refusal_in_the_second_controllers_entry_is_still_a_stop() {
        let contested = r#"
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata: { name: promo, namespace: shop }
spec:
  parentRefs:
  - { name: edge }
  rules:
  - backendRefs:
    - { name: promo, port: 8080 }
status:
  parents:
  - parentRef: { name: edge }
    controllerName: a.example.net/gw
    conditions:
    - { type: Accepted, status: "True", reason: Accepted, message: ok }
    - { type: ResolvedRefs, status: "True", reason: ResolvedRefs, message: ok }
  - parentRef: { name: edge }
    controllerName: b.example.net/gw
    conditions:
    - { type: Accepted, status: "False", reason: NotAllowedByListeners, message: no }
    - { type: ResolvedRefs, status: "False", reason: BackendNotFound, message: no }
"#;
        let mut out = Neighbourhood::new();
        gateway_traffic_into(
            "shop",
            &service("shop", "promo"),
            &[route(contested)],
            Some(&[gateway(EDGE_GATEWAY)]),
            None,
            None,
            &mut out,
        );
        assert!(out.stops.iter().any(|stop| matches!(
            stop,
            ChainStop::RouteNotAccepted { condition_reason, .. }
                if condition_reason.as_deref() == Some("NotAllowedByListeners")
        )));
        assert!(out.stops.iter().any(|stop| matches!(
            stop,
            ChainStop::RouteRefsUnresolved { condition_reason, .. }
                if condition_reason.as_deref() == Some("BackendNotFound")
        )));
    }

    #[test]
    fn resolved_refs_false_is_a_stop() {
        let unresolved = r#"
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata: { name: promo, namespace: shop }
spec:
  parentRefs:
  - { name: edge }
  rules:
  - backendRefs:
    - { name: promo, namespace: shop, port: 8080 }
status:
  parents:
  - parentRef: { name: edge }
    controllerName: example.net/gw
    conditions:
    - { type: Accepted, status: "True", reason: Accepted, message: ok }
    - { type: ResolvedRefs, status: "False", reason: RefNotPermitted, message: no ReferenceGrant allows it }
"#;
        let mut out = Neighbourhood::new();
        gateway_traffic_into(
            "shop",
            &service("shop", "promo"),
            &[route(unresolved)],
            Some(&[gateway(EDGE_GATEWAY)]),
            None,
            None,
            &mut out,
        );

        assert!(out.stops.iter().any(|stop| matches!(
            stop,
            ChainStop::RouteRefsUnresolved { condition_reason, .. }
                if condition_reason.as_deref() == Some("RefNotPermitted")
        )));
    }

    #[test]
    fn a_parent_gateway_the_server_does_not_have_is_named_missing() {
        let orphan = r"
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata: { name: promo, namespace: shop }
spec:
  parentRefs:
  - { name: ghost }
  rules:
  - backendRefs:
    - { name: promo, port: 8080 }
";
        let mut out = Neighbourhood::new();
        gateway_traffic_into(
            "shop",
            &service("shop", "promo"),
            &[route(orphan)],
            Some(&[]),
            None,
            None,
            &mut out,
        );

        let stop = out.stops.first().expect("a stop");
        match stop {
            ChainStop::GatewayMissing { route, gateway, .. } => {
                assert_eq!(route.name, "promo");
                assert_eq!(gateway.name, "ghost");
            }
            other => panic!("expected GatewayMissing, got {other:?}"),
        }
        let to_gateway = out
            .edges
            .iter()
            .find(|e| e.to.kind == "Gateway")
            .expect("the edge is still drawn, to a missing ref");
        assert!(matches!(to_gateway.to.existence, Existence::Missing));
    }

    /// A Gateway its controller refused: the chain drew the route's address
    /// on it, unbroken, while the trace stopped at "not programmed". Fails
    /// if a refusal, written as `Programmed` or as the legacy `Ready`, does
    /// not stop the route, or if a programmed Gateway does.
    #[test]
    fn a_gateway_its_controller_refused_stops_the_routes_on_it() {
        let edge = |conditions: &str| {
            gateway(&format!(
                "{EDGE_GATEWAY}status:\n  conditions:\n{conditions}"
            ))
        };
        let stops = |gw: GatewayInfo| {
            let mut out = Neighbourhood::new();
            gateway_traffic_into(
                "shop",
                &service("shop", "promo"),
                &[route(HEALTHY_ROUTE)],
                Some(&[gw]),
                None,
                None,
                &mut out,
            );
            out.stops
        };

        let refused = stops(edge(
            "  - { type: Programmed, status: \"False\", reason: AddressNotAssigned, message: no address }\n",
        ));
        match refused.as_slice() {
            [ChainStop::GatewayNotProgrammed {
                route,
                gateway,
                condition_type,
                condition_reason,
                ..
            }] => {
                assert_eq!(route.name, "promo");
                assert_eq!(gateway.name, "edge");
                assert_eq!(condition_type, "Programmed");
                assert_eq!(condition_reason.as_deref(), Some("AddressNotAssigned"));
            }
            other => panic!("expected GatewayNotProgrammed, got {other:?}"),
        }
        assert!(matches!(
            stops(edge(
                "  - { type: Ready, status: \"False\", reason: Invalid }\n"
            ))
            .as_slice(),
            [ChainStop::GatewayNotProgrammed { .. }]
        ));
        assert!(matches!(
            stops(edge(
                "  - { type: Accepted, status: \"False\", reason: ListenersNotValid }\n"
            ))
            .as_slice(),
            [ChainStop::GatewayNotProgrammed { condition_type, .. }] if condition_type == "Accepted"
        ));
        assert!(stops(edge(
            "  - { type: Programmed, status: \"True\", reason: Programmed }\n  - { type: Ready, status: \"False\" }\n"
        ))
        .is_empty());
    }

    /// The list that was read and did not hold it says "missing". A list
    /// nobody read says nothing — a namespace-scoped reader is refused this
    /// cluster-wide one, and every route they open would otherwise draw a
    /// break in a chain that is fine.
    #[test]
    fn an_unread_gateway_list_is_not_a_missing_gateway() {
        let mut out = Neighbourhood::new();
        gateway_traffic_into(
            "shop",
            &service("shop", "promo"),
            &[route(HEALTHY_ROUTE)],
            None,
            None,
            None,
            &mut out,
        );

        assert!(
            out.stops.is_empty(),
            "an unread list must not produce a GatewayMissing stop"
        );
        let gw = out
            .edges
            .iter()
            .find(|e| e.to.kind == "Gateway")
            .expect("the route still names its parent");
        assert_eq!(gw.to.existence, Existence::NotChecked);
    }

    #[test]
    fn a_mesh_parent_ref_is_not_a_missing_gateway() {
        let mesh = r#"
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata: { name: split, namespace: shop }
spec:
  parentRefs:
  - { group: "", kind: Service, name: promo }
  rules:
  - backendRefs:
    - { name: promo, port: 8080 }
"#;
        let mut out = Neighbourhood::new();
        gateway_traffic_into(
            "shop",
            &service("shop", "promo"),
            &[route(mesh)],
            Some(&[]),
            None,
            None,
            &mut out,
        );
        // The backend edge is real; the Service parentRef must produce
        // neither a Gateway edge nor a "gateway missing" lie.
        assert!(out.edges.iter().all(|e| e.to.kind != "Gateway"));
        assert!(out.stops.is_empty());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(services: Vec<Service>) -> Snapshot {
        Snapshot {
            pods: Ok(Vec::new()),
            services: Ok(services),
            ingresses: Ok(Vec::new()),
            claims: Ok(Vec::new()),
            autoscalers: Ok(Vec::new()),
            budgets: Ok(Vec::new()),
            deployments: Ok(Vec::new()),
            stateful_sets: Ok(Vec::new()),
            replica_sets: Ok(Vec::new()),
            refusals: Ok(Vec::new()),
            policies: Ok(Vec::new()),
            others: crate::resources::OtherPolicies::none(),
            slices: Ok(Vec::new()),
            legacy: Err("the slices answered".to_string()),
            taken_at: chrono::Utc::now(),
            gateway_routes: Vec::new(),
            gateways: None,
            listener_sets: None,
            gateway_classes: None,
            gateway_unread: Vec::new(),
        }
    }

    fn service(name: &str, selector: &[(&str, &str)]) -> Service {
        serde_json::from_value(serde_json::json!({
            "metadata": { "name": name, "namespace": "team-checkout" },
            "spec": { "selector": selector.iter().copied().collect::<BTreeMap<_, _>>() }
        }))
        .expect("a Service")
    }

    fn near_of(services: Vec<Service>, labels: &[(&str, &str)]) -> Vec<(String, String)> {
        let labels: BTreeMap<String, String> = labels
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect();
        let mut out = Neighbourhood::new();
        let pod = ObjectRef::new(
            "Pod",
            "checkout-api-a",
            Some("team-checkout".into()),
            Existence::Present,
        );
        traffic_into(
            "team-checkout",
            &pod,
            &labels,
            &[],
            &snapshot(services),
            &mut out,
        );
        out.nearly_selected_by
            .into_iter()
            .flatten()
            .map(|near| (near.service.name, near.lacks))
            .collect()
    }

    /// Marco's checkout-api pod page said no Service selects it while the
    /// Service checkout-api is one label short. Fails if the near Service
    /// goes unnamed, if a farther or unrelated one is offered beside it, or
    /// if a pod some Service does select is told about near misses.
    #[test]
    fn a_pod_no_service_selects_names_the_service_one_label_short() {
        let canary = [("app", "checkout-api"), ("track", "canary")];
        let services = || {
            vec![
                service(
                    "checkout-api",
                    &[("app", "checkout-api"), ("track", "stable")],
                ),
                service(
                    "checkout-api-eu",
                    &[
                        ("app", "checkout-api"),
                        ("track", "stable"),
                        ("region", "eu"),
                    ],
                ),
                service("worker", &[("app", "checkout-worker")]),
            ]
        };
        assert_eq!(
            near_of(services(), &canary),
            [("checkout-api".to_string(), "track=stable".to_string())]
        );

        let mut selecting = services();
        selecting.push(service("canary", &[("track", "canary")]));
        assert!(near_of(selecting, &canary).is_empty());

        assert!(near_of(services(), &[("app", "other")]).is_empty());
    }

    /// The chain reads its stops from here, and the routing pages from the
    /// backing lists: a policy admitting nothing has to stop both, or the
    /// Ingress page and the Traefik page disagree about the same pods.
    /// Fails if the neighbourhood skips the policies, or reads a refused
    /// policy list as a shut door.
    #[test]
    fn a_policy_that_admits_nothing_stops_the_chain_at_the_pods() {
        let svc = service("log-demo", &[("app", "log-demo")]);
        let svc_ref = service_ref(&svc, "team-checkout");
        let pod: Pod = serde_json::from_value(serde_json::json!({
            "metadata": { "name": "log-demo-a", "namespace": "team-checkout", "labels": { "app": "log-demo" } },
            "status": { "conditions": [{ "type": "Ready", "status": "True" }] }
        }))
        .expect("a Pod");
        let slice: EndpointSlice = serde_json::from_value(serde_json::json!({
            "metadata": {
                "name": "log-demo-x",
                "namespace": "team-checkout",
                "labels": { "kubernetes.io/service-name": "log-demo" }
            },
            "addressType": "IPv4",
            "ports": [{ "port": 8080, "protocol": "TCP" }],
            "endpoints": [{
                "addresses": ["10.0.0.1"],
                "conditions": { "ready": true },
                "targetRef": { "kind": "Pod", "name": "log-demo-a", "namespace": "team-checkout" }
            }]
        }))
        .expect("an EndpointSlice");
        let deny: k8s_openapi::api::networking::v1::NetworkPolicy =
            serde_json::from_value(serde_json::json!({
                "metadata": { "name": "deny-all-ingress", "namespace": "team-checkout" },
                "spec": { "podSelector": {}, "policyTypes": ["Ingress"] }
            }))
            .expect("a NetworkPolicy");
        let alone = crate::resources::OtherPolicies::none();
        let mut cilium = crate::resources::OtherPolicies::none();
        cilium.within("team-checkout", "CiliumNetworkPolicy");
        let stops = |policies: CodedRead<k8s_openapi::api::networking::v1::NetworkPolicy>,
                     others: &crate::resources::OtherPolicies| {
            let snapshot = Snapshot {
                pods: Ok(vec![pod.clone()]),
                slices: Ok(vec![slice.clone()]),
                policies,
                others: others.clone(),
                ..snapshot(vec![svc.clone()])
            };
            let mut out = Neighbourhood::new();
            note_reach(&svc, &svc_ref, &snapshot, &mut out, Carry::Whole);
            out.stops
        };
        assert!(
            matches!(
                stops(Ok(vec![deny.clone()]), &alone).as_slice(),
                [ChainStop::PolicyRefuses { no_rules: true, .. }]
            ),
            "the pods are shut to every client"
        );
        let refused = crate::resources::ListUnread {
            code: "PERMISSION_DENIED",
            said: "forbidden".to_string(),
        };
        assert!(stops(Err(refused), &alone).is_empty());
        // The graph and the lists read one door: beside another engine's
        // policy the chain must not end in a shut one either.
        assert!(stops(Ok(vec![deny]), &cilium).is_empty());
    }
}
