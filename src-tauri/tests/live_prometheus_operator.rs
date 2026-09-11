//! The Prometheus Operator integration against a real cluster: the CRD the
//! app detects by is there, the monitors list, and the connected Prometheus
//! answers for its targets with the scrape pools the page ties monitors to.
//!
//!     K8S_GUI_INIT_CONTEXT=killercoda \
//!     K8S_GUI_PROMETHEUS_URL=https://<proxy>/api/v1/namespaces/monitoring/services/prometheus:9090/proxy \
//!       cargo test --test live_prometheus_operator -- --ignored --nocapture

use k8s_gui_lib::config::PrometheusEntry;
use k8s_gui_lib::integrations::prometheus::parse_targets;
use k8s_gui_lib::integrations::wire::get_text;
use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
use kube::api::{ApiResource, DynamicObject, GroupVersionKind, ListParams};
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::{Api, Client, Config, ResourceExt};

fn context() -> String {
    std::env::var("K8S_GUI_INIT_CONTEXT").unwrap_or_else(|_| "killercoda".into())
}

async fn client() -> Client {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let config = Config::from_custom_kubeconfig(
        Kubeconfig::read().expect("kubeconfig"),
        &KubeConfigOptions {
            context: Some(context()),
            ..Default::default()
        },
    )
    .await
    .expect("kubeconfig context");
    Client::try_from(config).expect("client")
}

fn monitors(client: Client, kind: &str) -> Api<DynamicObject> {
    let resource =
        ApiResource::from_gvk(&GroupVersionKind::gvk("monitoring.coreos.com", "v1", kind));
    Api::all_with(client, &resource)
}

#[tokio::test]
#[ignore = "needs a cluster with the operator's CRDs and a Prometheus reachable by URL"]
async fn the_monitors_are_there_and_the_targets_name_their_pools() {
    let client = client().await;

    let crds: Api<CustomResourceDefinition> = Api::all(client.clone());
    let marker = crds
        .list(&ListParams::default())
        .await
        .expect("list crds")
        .items
        .into_iter()
        .any(|crd| crd.name_any() == "servicemonitors.monitoring.coreos.com");
    assert!(
        marker,
        "the CRD the app detects the operator by is not installed"
    );

    let service_monitors = monitors(client.clone(), "ServiceMonitor")
        .list(&ListParams::default())
        .await
        .expect("list ServiceMonitors");
    let names: Vec<String> = service_monitors
        .items
        .iter()
        .map(ResourceExt::name_any)
        .collect();
    println!("ServiceMonitors: {names:?}");
    for wanted in ["log-demo", "selects-nothing", "nobody-picks-up"] {
        assert!(names.iter().any(|n| n == wanted), "{wanted} is missing");
    }
    let pod_monitors = monitors(client, "PodMonitor")
        .list(&ListParams::default())
        .await
        .expect("list PodMonitors");
    println!("PodMonitors: {}", pod_monitors.items.len());

    let url = std::env::var("K8S_GUI_PROMETHEUS_URL").expect("K8S_GUI_PROMETHEUS_URL");
    let entry: PrometheusEntry =
        serde_json::from_value(serde_json::json!({ "url": url })).expect("connection entry");
    let body = get_text(
        &entry,
        "/api/v1/targets",
        &[("state", "active".to_string())],
    )
    .await
    .expect("targets from the connected Prometheus");
    let targets = parse_targets(&serde_json::from_str(&body).expect("json")).expect("parse");
    for target in &targets {
        println!(
            "  {} {} {}",
            target.scrape_pool, target.health, target.last_error
        );
    }
    let pool = |name: &str| format!("serviceMonitor/k8s-gui-test/{name}/0");
    assert!(
        targets.iter().any(|t| t.scrape_pool == pool("log-demo")),
        "log-demo's pool is not among the targets"
    );
    let nothing = targets
        .iter()
        .find(|t| t.scrape_pool == pool("selects-nothing"))
        .expect("selects-nothing's pool");
    assert!(
        nothing.health != "up",
        "an unreachable target must not read as up"
    );
}
