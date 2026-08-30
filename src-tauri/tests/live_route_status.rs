//! Dumps what this app actually reads from a cluster whose controller claims
//! a class and programs a gateway but writes no status for a route.
//!
//! That shape was reported from a live Netbird cluster, where every TCPRoute
//! read "the route is invisible to the data plane" while carrying traffic.
//! Netbird is not needed to reproduce it — the shape is: `Accepted` on the
//! class, `Programmed` on the gateway, no `status.parents` on the route.
//! `test-manifests/no-route-status.yaml` builds it and plays the controller.
//!
//! ```text
//! K8S_GUI_SHAPE_CONTEXT=kind-rubick-gw \
//!   cargo test --test live_route_status -- --ignored --nocapture
//! ```
//!
//! The JSON it prints is fed to the frontend's own `routeTraces` by
//! `src/lib/route-trace.live.test.ts`, so the fix is checked against what the
//! cluster really says rather than against a fixture written to match it.

use kube::api::{ApiResource, DynamicObject, GroupVersionKind, ListParams};
use kube::Api;

use k8s_gui_lib::resources::{GatewayClassInfo, GatewayInfo, RouteInfo};
use k8s_gui_lib::state::AppState;

async fn client() -> kube::Client {
    let name =
        std::env::var("K8S_GUI_SHAPE_CONTEXT").unwrap_or_else(|_| "kind-rubick-gw".to_string());
    let _ = rustls::crypto::ring::default_provider().install_default();
    let state = AppState::new().expect("app state");
    state
        .client_manager
        .load_kubeconfig()
        .await
        .expect("kubeconfig");
    (*state.client_manager.connect(&name).await.expect("connect")).clone()
}

fn resource(group: &str, version: &str, kind: &str) -> ApiResource {
    ApiResource::from_gvk(&GroupVersionKind::gvk(group, version, kind))
}

async fn all(client: &kube::Client, ar: &ApiResource) -> Vec<DynamicObject> {
    let api: Api<DynamicObject> = Api::all_with(client.clone(), ar);
    api.list(&ListParams::default())
        .await
        .expect("list")
        .items
        .into_iter()
        .map(|mut obj| {
            obj.types = Some(kube::api::TypeMeta {
                api_version: if ar.group.is_empty() {
                    ar.version.clone()
                } else {
                    format!("{}/{}", ar.group, ar.version)
                },
                kind: ar.kind.clone(),
            });
            obj
        })
        .collect()
}

#[tokio::test]
#[ignore = "needs the specimen cluster; run explicitly with --ignored"]
async fn dump_what_the_app_reads() {
    let client = client().await;
    let g = "gateway.networking.k8s.io";

    let classes: Vec<GatewayClassInfo> = all(&client, &resource(g, "v1", "GatewayClass"))
        .await
        .iter()
        .map(GatewayClassInfo::read)
        .collect();
    let gateways: Vec<GatewayInfo> = all(&client, &resource(g, "v1", "Gateway"))
        .await
        .iter()
        .map(GatewayInfo::read)
        .collect();
    let routes: Vec<RouteInfo> = all(&client, &resource(g, "v1alpha2", "TCPRoute"))
        .await
        .iter()
        .map(RouteInfo::read)
        .collect();

    println!("=== what the app reads ===");
    for c in &classes {
        println!("  class {} accepted={:?}", c.name, c.accepted);
    }
    for gw in &gateways {
        println!(
            "  gateway {}/{} addresses={:?} conditions={:?}",
            gw.namespace,
            gw.name,
            gw.addresses,
            gw.conditions
                .iter()
                .map(|c| format!("{}={}", c.type_, c.status))
                .collect::<Vec<_>>()
        );
    }
    for r in &routes {
        println!(
            "  route {}/{} parents={} rules={}",
            r.namespace,
            r.name,
            r.parents.len(),
            r.rules.len()
        );
    }

    let dump = serde_json::json!({
        "classes": classes,
        "gateways": gateways,
        "routes": routes,
    });
    let out = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../src/lib/__fixtures__/live-route-status.json");
    std::fs::create_dir_all(out.parent().unwrap()).expect("fixture dir");
    std::fs::write(&out, serde_json::to_string_pretty(&dump).unwrap()).expect("write");
    println!("  written to {}", out.display());

    assert_eq!(routes.len(), 1, "one TCPRoute in the scene");
    assert!(
        routes[0].parents.is_empty(),
        "the whole point: the controller wrote no status for it"
    );
}

#[tokio::test]
#[ignore = "needs the ListenerSet specimen cluster"]
async fn dump_listenerset_scene() {
    let client = client().await;
    let g = "gateway.networking.k8s.io";

    let classes: Vec<GatewayClassInfo> = all(&client, &resource(g, "v1", "GatewayClass"))
        .await
        .iter()
        .map(GatewayClassInfo::read)
        .collect();
    let sets = all(&client, &resource(g, "v1", "ListenerSet")).await;
    let sets: Vec<k8s_gui_lib::resources::ListenerSetInfo> = sets
        .iter()
        .map(k8s_gui_lib::resources::ListenerSetInfo::read)
        .collect();
    let mut gateways: Vec<GatewayInfo> = all(&client, &resource(g, "v1", "Gateway"))
        .await
        .iter()
        .map(GatewayInfo::read)
        .collect();
    for gw in &mut gateways {
        gw.merge_listener_sets(&sets);
    }
    let routes: Vec<RouteInfo> = all(&client, &resource(g, "v1", "HTTPRoute"))
        .await
        .iter()
        .map(RouteInfo::read)
        .collect();

    println!("=== what the app reads ===");
    for s in &sets {
        println!(
            "  set {}/{} -> gateway {}/{}",
            s.namespace, s.name, s.gateway_namespace, s.gateway_name
        );
    }
    for gw in &gateways {
        println!(
            "  gateway {}/{}  listenerSets={:?}  listeners={}",
            gw.namespace,
            gw.name,
            gw.listener_sets
                .iter()
                .map(|o| format!("{}/{}", o.namespace, o.name))
                .collect::<Vec<_>>(),
            gw.listeners.len()
        );
    }
    for r in &routes {
        println!(
            "  route {}/{}  parentRefs={:?}  parents={}",
            r.namespace,
            r.name,
            r.parent_refs
                .iter()
                .map(|p| format!("{}:{}", p.kind, p.name))
                .collect::<Vec<_>>(),
            r.parents.len()
        );
    }

    let dump = serde_json::json!({"classes": classes, "gateways": gateways, "routes": routes});
    let out = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../src/lib/__fixtures__/live-listenerset.json");
    std::fs::write(&out, serde_json::to_string_pretty(&dump).unwrap()).expect("write");

    assert_eq!(gateways.len(), 1);
    assert_eq!(
        gateways[0].listener_sets.len(),
        1,
        "the set must be recorded on the gateway"
    );
    assert_eq!(routes[0].parent_refs[0].kind, "ListenerSet");
}
