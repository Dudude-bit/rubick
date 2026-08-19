//! Manual proof harness for the Gateway API chain against a real cluster.
//! Ignored by default — it needs a kubeconfig and the specimens, so it is
//! not part of the `--lib` gate.
//!
//! ```text
//! kwokctl create cluster --name rubick-gw --runtime binary
//! kubectl apply -f .../gateway-api standard-install.yaml
//! kubectl apply -f test-manifests/gateway-api.yaml
//! # then play the controller: patch the statuses (see the PR that added
//! # this file), and:
//! K8S_GUI_INIT_CONTEXT=kwok-rubick-gw K8S_GUI_INIT_NAMESPACE=gwtest \
//!   cargo test --test live_gateway -- --ignored --nocapture
//! ```

use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
use kube::api::ListParams;
use kube::Api;

use k8s_gui_lib::commands::connections::connections_of;
use k8s_gui_lib::commands::helpers::ResourceContext;
use k8s_gui_lib::resources::{ChainStop, Existence, GatewayApiDetection, ObjectFacts, Relation};
use k8s_gui_lib::state::AppState;

async fn context(namespace: &str) -> ResourceContext {
    let name =
        std::env::var("K8S_GUI_INIT_CONTEXT").unwrap_or_else(|_| "kwok-rubick-gw".to_string());
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
    std::env::var("K8S_GUI_INIT_NAMESPACE").unwrap_or_else(|_| "gwtest".to_string())
}

async fn detection(ctx: &ResourceContext) -> GatewayApiDetection {
    let crds: Api<CustomResourceDefinition> = Api::all(ctx.client.clone());
    let list = crds.list(&ListParams::default()).await.expect("crd list");
    GatewayApiDetection::from_crds(&list.items)
}

/// The whole point of the release: a workload page on a Gateway API
/// cluster draws the chain, and every stop the fixtures stage shows up in
/// the cluster's own words.
#[tokio::test]
#[ignore]
async fn the_gateway_chain_arrives_and_the_stops_are_named() {
    let ns = namespace();
    let ctx = context(&ns).await;
    let detection = detection(&ctx).await;

    assert!(detection.installed, "the CRDs are installed");
    assert_eq!(detection.bundle_version.as_deref(), Some("v1.6.1"));
    assert_eq!(detection.channel.as_deref(), Some("standard"));
    assert!(!detection.mixed_bundle);
    for kind in [
        "GatewayClass",
        "Gateway",
        "HTTPRoute",
        "GRPCRoute",
        "TLSRoute",
        "TCPRoute",
        "UDPRoute",
        "ListenerSet",
    ] {
        let served = detection
            .kinds
            .iter()
            .find(|entry| entry.kind == kind)
            .unwrap_or_else(|| panic!("{kind} is served"));
        assert_eq!(served.read_version, "v1", "{kind} reads at v1");
    }

    let answer = connections_of(&ctx, "Deployment", "gwtest-app", Some(&detection))
        .await
        .expect("neighbourhood");

    // The healthy route -> Service edge, hostnames and all.
    let healthy = answer
        .edges
        .iter()
        .find(|edge| edge.from.kind == "HTTPRoute" && edge.from.name == "gwtest-healthy")
        .expect("gwtest-healthy routes to the Service");
    match &healthy.relation {
        Relation::RuleRoutes {
            hostnames, port, ..
        } => {
            assert_eq!(hostnames, &vec!["healthy.gwtest.example.com".to_string()]);
            assert_eq!(port.as_deref(), Some("8080"));
        }
        other => panic!("expected RuleRoutes, got {other:?}"),
    }

    // The Gateway above it, present, claimed, and carrying its class.
    let above = answer
        .edges
        .iter()
        .find(|edge| edge.from.name == "gwtest-healthy" && edge.to.kind == "Gateway")
        .expect("gwtest-healthy attaches to the Gateway");
    assert!(matches!(above.to.existence, Existence::Present));
    assert!(matches!(
        &above.to.facts,
        Some(ObjectFacts::Gateway { class_name }) if class_name == "gwtest-claimed"
    ));

    // Every route kind reaches the same Service: the chain is not an
    // HTTPRoute feature.
    for kind in ["GRPCRoute", "TLSRoute", "TCPRoute", "UDPRoute"] {
        assert!(
            answer.edges.iter().any(|edge| edge.from.kind == kind),
            "{kind} draws its edge"
        );
    }

    // The staged refusals, in the controller's words.
    assert!(
        answer.stops.iter().any(|stop| matches!(
            stop,
            ChainStop::RouteNotAccepted { route, condition_reason, .. }
                if route.name == "gwtest-wrong-host"
                    && condition_reason.as_deref() == Some("NoMatchingListenerHostname")
        )),
        "the hostname mismatch is a stop: {:?}",
        answer.stops
    );
    assert!(
        answer.stops.iter().any(|stop| matches!(
            stop,
            ChainStop::GatewayMissing { route, gateway }
                if route.name == "gwtest-ghost-parent" && gateway.name == "gwtest-ghost"
        )),
        "the ghost parent is a stop"
    );

    // The mesh route (parentRef kind Service) drew its backend edge and no
    // Gateway lie.
    assert!(answer
        .edges
        .iter()
        .any(|edge| edge.from.name == "gwtest-mesh" && edge.to.kind == "Service"));
    assert!(!answer.stops.iter().any(|stop| matches!(
        stop,
        ChainStop::GatewayMissing { route, .. } if route.name == "gwtest-mesh"
    )));
}
