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
    snapshot: &Snapshot,
    out: &mut Neighbourhood,
) {
    for svc in snapshot.services() {
        let selector = service_selector(svc);
        let Some(text) = Selector::Equality(&selector).says() else {
            continue;
        };
        if Selector::Equality(&selector).matches(labels) != Some(true) {
            continue;
        }
        let svc_ref = service_ref(svc, ns);
        out.edge(
            svc_ref.clone(),
            target.clone(),
            Relation::Selects { selector: text },
        );
        note_reach(svc, &svc_ref, snapshot, out, false);
        routes_into(ns, &svc_ref, snapshot, out);
        gateway_traffic_into(
            ns,
            &svc_ref,
            &snapshot.gateway_routes,
            snapshot.gateways.as_deref(),
            out,
        );
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
pub(super) fn gateway_traffic_into(
    ns: &str,
    svc_ref: &ObjectRef,
    routes: &[crate::resources::RouteInfo],
    gateways: Option<&[crate::resources::GatewayInfo]>,
    out: &mut Neighbourhood,
) {
    use crate::resources::{verdict_of, Verdict, GATEWAY_API_GROUP};

    for route in routes {
        let backends: Vec<_> = route
            .rules
            .iter()
            .flat_map(|rule| &rule.backend_refs)
            .filter(|b| {
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

        for backend in backends {
            out.edge(
                route_ref.clone(),
                svc_ref.clone(),
                Relation::RuleRoutes {
                    hostnames: route.hostnames.clone(),
                    port: backend.port.map(|p| p.to_string()),
                    weight: backend.weight,
                },
            );
        }

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
            // Absent list means nobody asked, which is a different answer
            // from "asked, and it is not there" — and only the second one
            // may be drawn as a break in the chain.
            let found = gateways
                .and_then(|list| {
                    list.iter().find(|g| {
                        if via_set {
                            // The set's own namespace resolution, then the
                            // Gateway it named.
                            g.listener_sets
                                .iter()
                                .any(|set| set.name == parent.name && set.namespace == gw_ns)
                        } else {
                            g.name == parent.name && g.namespace == gw_ns
                        }
                    })
                })
                .map(Some);
            // Only when the sets were actually read: an unlisted ListenerSet
            // makes every set-parented route look orphaned.
            let resolvable =
                !via_set || gateways.is_some_and(|list| list.iter().all(|g| g.listener_sets_known));
            let gw_ref = match found {
                Some(Some(g)) => ObjectRef::new(
                    "Gateway",
                    &g.name,
                    Some(g.namespace.clone()),
                    Existence::Present,
                )
                .with_facts(ObjectFacts::Gateway {
                    class_name: g.class_name.clone(),
                }),
                // Unresolved: point at what the route actually named. Calling
                // a ListenerSet a Gateway would put the set's name under the
                // wrong kind, and the reader would go looking for a Gateway
                // that was never supposed to exist.
                _ => ObjectRef::new(
                    if via_set { "ListenerSet" } else { "Gateway" },
                    &parent.name,
                    Some(gw_ns.clone()),
                    if gateways.is_some() && resolvable {
                        Existence::Missing
                    } else {
                        Existence::NotChecked
                    },
                ),
            };
            // Only when the sets were actually read: an unlisted ListenerSet
            // makes every set-parented route look orphaned, and a break drawn
            // from that is this app's blind spot, not the cluster's state.
            let resolvable =
                !via_set || gateways.is_some_and(|list| list.iter().all(|g| g.listener_sets_known));
            if found.is_none() && gateways.is_some() && resolvable {
                out.stops.push(ChainStop::GatewayMissing {
                    route: route_ref.clone(),
                    gateway: gw_ref.clone(),
                });
            }
            out.edge(
                route_ref.clone(),
                gw_ref.clone(),
                Relation::AttachesTo {
                    section_name: parent.section_name.clone(),
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
                    message: said.message.clone(),
                });
            }
            if let Verdict::False(said) = verdict_of(&entries, "ResolvedRefs") {
                out.stops.push(ChainStop::RouteRefsUnresolved {
                    route: route_ref.clone(),
                    condition_reason: said.reason.clone(),
                    message: said.message.clone(),
                });
            }
        }
    }
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
/// `detail` is whether the reader is on this Service's own page, where the
/// endpoint rows and the pods it does not publish are the point rather than a
/// payload every other page would carry for nothing.
pub(super) fn note_reach(
    svc: &Service,
    svc_ref: &ObjectRef,
    snapshot: &Snapshot,
    out: &mut Neighbourhood,
    detail: bool,
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
    let published = snapshot
        .published_of(svc, svc_ref.clone(), &selected)
        .with_stop(svc, pods);
    let stop = published.stop.clone();
    out.published.push(if detail {
        published
    } else {
        published.summary()
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
        class_name: ing.spec.as_ref().and_then(|s| s.ingress_class_name.clone()),
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

    #[test]
    fn backend_ref_becomes_an_edge_and_the_gateway_sits_above() {
        let mut out = Neighbourhood::new();
        gateway_traffic_into(
            "shop",
            &service("shop", "promo"),
            &[route(HEALTHY_ROUTE)],
            Some(&[gateway(EDGE_GATEWAY)]),
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
            } => {
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
            Relation::AttachesTo { section_name } if section_name.as_deref() == Some("https")
        ));
        assert!(matches!(
            &to_gateway.to.facts,
            Some(ObjectFacts::Gateway { class_name }) if class_name == "envoy"
        ));
    }

    #[test]
    fn a_route_naming_another_service_draws_nothing() {
        let mut out = Neighbourhood::new();
        gateway_traffic_into(
            "shop",
            &service("shop", "checkout"),
            &[route(HEALTHY_ROUTE)],
            Some(&[gateway(EDGE_GATEWAY)]),
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
            &mut out,
        );

        let stop = out.stops.first().expect("a stop");
        match stop {
            ChainStop::GatewayMissing { route, gateway } => {
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
            &mut out,
        );
        // The backend edge is real; the Service parentRef must produce
        // neither a Gateway edge nor a "gateway missing" lie.
        assert!(out.edges.iter().all(|e| e.to.kind != "Gateway"));
        assert!(out.stops.is_empty());
    }
}
