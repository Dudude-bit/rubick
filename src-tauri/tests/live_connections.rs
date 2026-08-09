//! Manual proof harness for the connections command against a real cluster.
//! Ignored by default — it needs a kubeconfig and the specimens, so it is not
//! part of the `--lib` gate.
//!
//! ```text
//! K8S_GUI_INIT_CONTEXT=k3d-k8s-gui-dev K8S_GUI_INIT_NAMESPACE=k8s-gui-test \
//!   cargo test --test live_connections -- --ignored --nocapture
//! ```
//!
//! Specimens (`test-manifests/k8s-gui-all.yaml`):
//!   * `log-demo`     — Ingress → Service → Deployment → two ready pods.
//!     The chain that arrives.
//!   * `tls-demo`     — Ingress → Service whose selector matches no pod.
//!   * `ghost-demo`   — Ingress whose backend Service does not exist.
//!   * `unready-demo` — Service whose pods exist and none is ready.
//!   * `mounts-demo`  — a ConfigMap, a Secret and a claim, mounted and read.
//!   * `pvc-demo`     — the claim, asked who mounts it.

use k8s_gui_lib::commands::connections::connections_of;
use k8s_gui_lib::commands::helpers::ResourceContext;
use k8s_gui_lib::resources::{
    ChainStop, ConnectionEdge, Existence, ObjectFacts, Relation, ResourceConnections, Usage,
};
use k8s_gui_lib::state::AppState;

async fn context(namespace: &str) -> ResourceContext {
    let name =
        std::env::var("K8S_GUI_INIT_CONTEXT").unwrap_or_else(|_| "k3d-k8s-gui-dev".to_string());
    let _ = rustls::crypto::ring::default_provider().install_default();

    let state = AppState::new().expect("app state");
    state
        .client_manager
        .load_kubeconfig()
        .await
        .expect("kubeconfig");
    let client = state.client_manager.connect(&name).await.expect("connect");
    ResourceContext::from_client((*client).clone(), namespace.to_string())
}

fn namespace() -> String {
    std::env::var("K8S_GUI_INIT_NAMESPACE").unwrap_or_else(|_| "k8s-gui-test".to_string())
}

fn describe(what: &str, answer: &ResourceConnections) {
    println!(
        "\n=== {what} — {} {} ({:?})",
        answer.subject.kind, answer.subject.name, answer.subject.existence
    );
    for edge in &answer.edges {
        println!(
            "  {} {} --{}--> {} {} [{:?}]",
            edge.from.kind,
            edge.from.name,
            verb(&edge.relation),
            edge.to.kind,
            edge.to.name,
            edge.to.existence,
        );
    }
    for stop in &answer.stops {
        println!("  STOP {stop:?}");
    }
    for gap in &answer.not_looked_at {
        println!("  not looked at: {} — {}", gap.kind, gap.why);
    }
}

fn verb(relation: &Relation) -> &'static str {
    match relation {
        Relation::Owns { .. } => "owns",
        Relation::Selects { .. } => "selects",
        Relation::Uses { .. } => "uses",
        Relation::Routes { .. } => "routes",
        Relation::RunsOn => "runsOn",
        Relation::Binds => "binds",
    }
}

fn edges_to<'a>(
    answer: &'a ResourceConnections,
    kind: &str,
    name: &str,
) -> Vec<&'a ConnectionEdge> {
    answer
        .edges
        .iter()
        .filter(|e| e.to.kind == kind && e.to.name == name)
        .collect()
}

fn edges_from<'a>(answer: &'a ResourceConnections, kind: &str) -> Vec<&'a ConnectionEdge> {
    answer
        .edges
        .iter()
        .filter(|e| e.from.kind == kind)
        .collect()
}

/// The chain that arrives: Ingress, Service, workload, pods, and the pods
/// serving.
#[tokio::test]
#[ignore = "needs a real kubeconfig and the connections specimens"]
async fn log_demo_reaches_its_pods_end_to_end() {
    let ns = namespace();
    let ctx = context(&ns).await;

    let answer = connections_of(&ctx, "Deployment", "log-demo")
        .await
        .expect("connections");
    describe("log-demo Deployment", &answer);

    let fronted = edges_to(&answer, "Deployment", "log-demo");
    let service = fronted
        .iter()
        .find(|e| e.from.kind == "Service" && e.from.name == "log-demo")
        .expect("the Service that selects this Deployment's template");
    match &service.relation {
        Relation::Selects { selector } => assert_eq!(selector, "app=log-demo"),
        other => panic!("expected a selector, got {other:?}"),
    }
    let Some(ObjectFacts::Service {
        type_,
        cluster_ip,
        ports,
        selector,
        ..
    }) = &service.from.facts
    else {
        panic!("the Service hop carries no Service facts")
    };
    assert_eq!(type_, "ClusterIP");
    assert!(cluster_ip.is_some(), "the Service states a cluster IP");
    assert_eq!(ports.len(), 1);
    assert_eq!(ports[0].port, 80);
    assert_eq!(ports[0].target_port, "80");
    assert_eq!(selector.as_deref(), Some("app=log-demo"));

    let ingress = answer
        .edges
        .iter()
        .find(|e| e.from.kind == "Ingress" && e.to.name == "log-demo" && e.to.kind == "Service")
        .expect("the Ingress that routes to the Service");
    match &ingress.relation {
        Relation::Routes {
            host, path, tls, ..
        } => {
            assert_eq!(host.as_deref(), Some("log-demo.local"));
            assert_eq!(path, "/");
            assert!(!tls, "log-demo is the plain-HTTP specimen");
        }
        other => panic!("expected a route, got {other:?}"),
    }
    let Some(ObjectFacts::Ingress { class_name }) = &ingress.from.facts else {
        panic!("the Ingress hop carries no Ingress facts")
    };
    assert_eq!(class_name.as_deref(), Some("nginx"));

    let pods: Vec<_> = answer
        .edges
        .iter()
        .filter(|e| {
            e.from.kind == "Deployment"
                && e.to.kind == "Pod"
                && matches!(e.relation, Relation::Selects { .. })
        })
        .collect();
    assert_eq!(pods.len(), 2, "log-demo runs two pods");
    for pod in &pods {
        let Some(ObjectFacts::Pod { ready, .. }) = &pod.to.facts else {
            panic!("a pod hop with no readiness is the whole bug this fixes")
        };
        assert!(*ready, "both log-demo pods are serving");
    }

    assert!(
        answer.stops.is_empty(),
        "a chain that arrives states no stop: {:?}",
        answer.stops
    );

    let nodes = edges_from(&answer, "Pod")
        .into_iter()
        .filter(|e| matches!(e.relation, Relation::RunsOn))
        .count();
    assert_eq!(nodes, 2, "each pod names the node it was placed on");

    let revisions: Vec<_> = answer
        .edges
        .iter()
        .filter(|e| e.to.kind == "ReplicaSet")
        .collect();
    assert!(!revisions.is_empty(), "a Deployment makes ReplicaSets");
    assert!(
        revisions.iter().any(|e| matches!(
            &e.to.facts,
            Some(ObjectFacts::Workload {
                current: Some(true),
                ..
            })
        )),
        "one revision is the current one"
    );

    assert!(
        answer
            .not_looked_at
            .iter()
            .any(|gap| gap.kind == "HorizontalPodAutoscaler"),
        "a kind the app never read is named, not implied absent"
    );
}

/// The three ways a chain stops, told apart.
#[tokio::test]
#[ignore = "needs a real kubeconfig and the connections specimens"]
async fn the_three_stops_are_different_stops() {
    let ns = namespace();
    let ctx = context(&ns).await;

    let tls = connections_of(&ctx, "Ingress", "tls-demo")
        .await
        .expect("connections");
    describe("tls-demo Ingress", &tls);
    assert_eq!(tls.stops.len(), 1);
    match &tls.stops[0] {
        ChainStop::SelectsNothing { service, selector } => {
            assert_eq!(service.name, "tls-demo");
            assert_eq!(service.existence, Existence::Present);
            assert_eq!(selector, "app=tls-demo");
        }
        other => panic!("tls-demo stops at a Service that selects nothing, got {other:?}"),
    }
    let route = tls
        .edges
        .iter()
        .find(|e| e.to.kind == "Service")
        .expect("the route to the Service");
    match &route.relation {
        Relation::Routes { tls, host, .. } => {
            assert!(*tls, "tls-demo.local is covered by spec.tls");
            assert_eq!(host.as_deref(), Some("tls-demo.local"));
        }
        other => panic!("expected a route, got {other:?}"),
    }
    assert!(
        tls.edges.iter().any(|e| e.to.kind == "Secret"
            && e.to.name == "tls-demo-cert"
            && matches!(&e.relation, Relation::Uses { usages }
                if usages.iter().any(|u| matches!(u, Usage::IngressTls { .. })))),
        "the certificate the Ingress serves is an edge too"
    );

    let ghost = connections_of(&ctx, "Ingress", "ghost-demo")
        .await
        .expect("connections");
    describe("ghost-demo Ingress", &ghost);
    assert_eq!(ghost.stops.len(), 1);
    match &ghost.stops[0] {
        ChainStop::BackendMissing { ingress, service } => {
            assert_eq!(ingress.name, "ghost-demo");
            assert_eq!(service.name, "ghost-demo");
            assert_eq!(service.existence, Existence::Missing);
        }
        other => panic!("ghost-demo stops at a Service that is not there, got {other:?}"),
    }

    let unready = connections_of(&ctx, "Service", "unready-demo")
        .await
        .expect("connections");
    describe("unready-demo Service", &unready);
    assert_eq!(unready.stops.len(), 1);
    match &unready.stops[0] {
        ChainStop::NoneReady {
            service,
            selector,
            pods,
        } => {
            assert_eq!(service.name, "unready-demo");
            assert_eq!(selector, "app=unready-demo");
            assert_eq!(
                *pods, 2,
                "the pods exist — that is what makes this the hard one"
            );
        }
        other => panic!("unready-demo stops on readiness, got {other:?}"),
    }
    assert!(
        unready
            .edges
            .iter()
            .filter(|e| e.to.kind == "Pod")
            .all(|e| matches!(&e.to.facts, Some(ObjectFacts::Pod { ready: false, .. }))),
        "every pod behind unready-demo reports itself unready"
    );
    assert!(
        unready
            .edges
            .iter()
            .any(|e| e.from.kind == "Deployment" && e.from.name == "unready-demo"),
        "the Service reaches its workload through the pods' owners"
    );
}

/// What a workload needs to run, with how each thing is used.
#[tokio::test]
#[ignore = "needs a real kubeconfig and the connections specimens"]
async fn mounts_demo_says_how_each_thing_is_used() {
    let ns = namespace();
    let ctx = context(&ns).await;

    let answer = connections_of(&ctx, "Deployment", "mounts-demo")
        .await
        .expect("connections");
    describe("mounts-demo Deployment", &answer);

    let usages = |kind: &str, name: &str| -> Vec<Usage> {
        edges_to(&answer, kind, name)
            .into_iter()
            .flat_map(|e| match &e.relation {
                Relation::Uses { usages } => usages.clone(),
                _ => Vec::new(),
            })
            .collect()
    };

    let config = usages("ConfigMap", "demo-config");
    assert!(
        config
            .iter()
            .any(|u| matches!(u, Usage::Mount { path, container, .. }
            if path == "/etc/app" && container == "app")),
        "the ConfigMap is mounted at /etc/app: {config:?}"
    );
    assert!(
        config
            .iter()
            .any(|u| matches!(u, Usage::Env { name, key, .. }
            if name == "APP_MESSAGE" && key == "app.conf")),
        "APP_MESSAGE reads app.conf: {config:?}"
    );
    assert!(
        config.iter().any(|u| matches!(u, Usage::EnvFrom { .. })),
        "envFrom is its own kind of use: {config:?}"
    );
    assert!(
        config
            .iter()
            .any(|u| matches!(u, Usage::Unmounted { volume, .. } if volume == "unread-config")),
        "a volume no container mounts is still stated: {config:?}"
    );

    let secret = usages("Secret", "demo-secret");
    assert!(
        secret
            .iter()
            .any(|u| matches!(u, Usage::Mount { path, .. } if path == "/etc/creds")),
        "the Secret is mounted at /etc/creds: {secret:?}"
    );
    assert!(
        secret
            .iter()
            .any(|u| matches!(u, Usage::Env { name, key, .. }
            if name == "APP_PASSWORD" && key == "password")),
        "APP_PASSWORD reads password: {secret:?}"
    );

    let claim = usages("PersistentVolumeClaim", "pvc-demo");
    assert!(
        claim
            .iter()
            .any(|u| matches!(u, Usage::Mount { path, .. } if path == "/var/lib/data")),
        "the claim is mounted at /var/lib/data: {claim:?}"
    );
    let claim_ref = edges_to(&answer, "PersistentVolumeClaim", "pvc-demo");
    let Some(ObjectFacts::Claim {
        phase, capacity, ..
    }) = &claim_ref[0].to.facts
    else {
        panic!("the claim hop carries no claim facts")
    };
    assert_eq!(phase, "Bound");
    assert_eq!(capacity, "1Gi");

    assert!(
        !usages("ServiceAccount", "k8s-gui-test").is_empty(),
        "the identity is stated by the spec, and left unchecked"
    );
    assert_eq!(
        edges_to(&answer, "ServiceAccount", "k8s-gui-test")[0]
            .to
            .existence,
        Existence::NotChecked,
        "the app never read a ServiceAccount, and says so rather than claiming it exists"
    );
}

/// The direction that was impossible: a claim naming who mounts it.
#[tokio::test]
#[ignore = "needs a real kubeconfig and the connections specimens"]
async fn a_claim_names_who_mounts_it() {
    let ns = namespace();
    let ctx = context(&ns).await;

    let answer = connections_of(&ctx, "PersistentVolumeClaim", "pvc-demo")
        .await
        .expect("connections");
    describe("pvc-demo claim", &answer);

    let users: Vec<_> = answer
        .edges
        .iter()
        .filter(|e| e.to.kind == "PersistentVolumeClaim" && e.to.name == "pvc-demo")
        .collect();
    assert!(
        users
            .iter()
            .any(|e| e.from.kind == "Deployment" && e.from.name == "mounts-demo"),
        "the Deployment whose template mounts it: {users:?}"
    );
    assert!(
        users.iter().any(|e| e.from.kind == "Pod"),
        "and the pod that actually has it: {users:?}"
    );

    assert!(
        answer
            .edges
            .iter()
            .any(|e| e.to.kind == "PersistentVolume" && matches!(e.relation, Relation::Binds)),
        "a bound claim states its volume"
    );
    assert!(
        answer
            .edges
            .iter()
            .any(|e| e.to.kind == "StorageClass" && matches!(e.relation, Relation::Binds)),
        "and its storage class"
    );

    let stateful = connections_of(&ctx, "PersistentVolumeClaim", "data-stateful-demo-0")
        .await
        .expect("connections");
    describe("data-stateful-demo-0 claim", &stateful);
    assert!(
        stateful
            .edges
            .iter()
            .any(|e| e.from.kind == "Pod" && e.from.name == "stateful-demo-0"),
        "a claim a StatefulSet made is mounted by the pod that owns the ordinal"
    );
}

/// The shapes that have no neighbours, and must not be read as faults.
#[tokio::test]
#[ignore = "needs a real kubeconfig and the connections specimens"]
async fn the_empty_shapes_state_nothing_rather_than_something_wrong() {
    let ns = namespace();
    let ctx = context(&ns).await;

    let external = connections_of(&ctx, "Service", "external-demo")
        .await
        .expect("connections");
    describe("external-demo Service", &external);
    assert!(
        external.stops.is_empty(),
        "a Service with no selector selects nothing on purpose; that is not a stop"
    );
    let Some(ObjectFacts::Service {
        selector,
        external_name,
        ..
    }) = &external.subject.facts
    else {
        panic!("the subject carries no Service facts")
    };
    assert!(selector.is_none(), "there is no selector to state");
    assert_eq!(external_name.as_deref(), Some("example.com"));

    let resource = connections_of(&ctx, "Ingress", "resource-demo")
        .await
        .expect("connections");
    describe("resource-demo Ingress", &resource);
    assert!(
        resource.stops.is_empty(),
        "a backend the app does not follow is not a backend that is missing"
    );
    let backend = resource
        .edges
        .iter()
        .find(|e| matches!(e.relation, Relation::Routes { .. }))
        .expect("the route is kept even though it leads somewhere unread");
    assert_eq!(backend.to.kind, "StorageBucket");
    assert_eq!(backend.to.existence, Existence::NotChecked);

    let ownerless = connections_of(&ctx, "Pod", "shell-demo")
        .await
        .expect("connections");
    describe("shell-demo Pod", &ownerless);
    assert!(
        !ownerless
            .edges
            .iter()
            .any(|e| matches!(e.relation, Relation::Owns { .. })),
        "a pod nothing made states no owner rather than inventing one"
    );
}

/// The reverse lookup that did not exist: a pod naming what fronts it.
#[tokio::test]
#[ignore = "needs a real kubeconfig and the connections specimens"]
async fn a_pod_names_the_service_that_fronts_it() {
    let ns = namespace();
    let ctx = context(&ns).await;

    let pods = connections_of(&ctx, "Deployment", "log-demo")
        .await
        .expect("connections");
    let pod = pods
        .edges
        .iter()
        .find(|e| e.to.kind == "Pod")
        .map(|e| e.to.name.clone())
        .expect("a log-demo pod");

    let answer = connections_of(&ctx, "Pod", &pod)
        .await
        .expect("connections");
    describe("a log-demo pod", &answer);

    assert!(
        answer
            .edges
            .iter()
            .any(|e| e.from.kind == "Service" && e.from.name == "log-demo" && e.to.name == pod),
        "the Service that selects this pod"
    );
    assert!(
        answer
            .edges
            .iter()
            .any(|e| e.from.kind == "Ingress" && e.from.name == "log-demo"),
        "and through it, the Ingress"
    );
    assert!(
        answer
            .edges
            .iter()
            .any(|e| e.from.kind == "Deployment" && e.from.name == "log-demo"),
        "the owner chain walked to the top"
    );
    assert!(
        answer
            .edges
            .iter()
            .any(|e| e.to.kind == "Node" && matches!(e.relation, Relation::RunsOn)),
        "and the node it was placed on"
    );
}
