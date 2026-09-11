//! The overview answered from watches on a real cluster: the first request
//! may list while the stores fill; every one after is served from the
//! stores, and says so, with the same pod count the API gives.
//!
//!     K8S_GUI_INIT_CONTEXT=kind-rubick-check K8S_GUI_INIT_NAMESPACE=default \
//!       cargo test --test live_overview_cache -- --ignored --nocapture

use k8s_gui_lib::commands::overview::{cluster_overview, OverviewSource};
use k8s_gui_lib::AppState;
use k8s_openapi::api::core::v1::Pod;
use kube::{api::ListParams, Api};
use std::time::{Duration, Instant};

fn context() -> String {
    std::env::var("K8S_GUI_INIT_CONTEXT").unwrap_or_else(|_| "kind-rubick-check".into())
}

fn namespace() -> String {
    std::env::var("K8S_GUI_INIT_NAMESPACE").unwrap_or_else(|_| "default".into())
}

async fn connected() -> AppState {
    let state = AppState::new().expect("app state");
    state
        .client_manager
        .load_kubeconfig()
        .await
        .expect("kubeconfig");
    state
        .client_manager
        .connect(&context())
        .await
        .expect("connect");
    state.set_current_context(Some(context()));
    state
}

#[tokio::test]
#[ignore = "needs a cluster"]
async fn after_the_stores_fill_every_overview_is_served_from_the_watch() {
    let state = connected().await;
    let namespace = namespace();
    let client = state.client_manager.get_client(&context()).expect("client");
    let listed = Api::<Pod>::namespaced((*client).clone(), &namespace)
        .list(&ListParams::default())
        .await
        .expect("list pods")
        .items
        .len();

    let started = Instant::now();
    let mut served = Vec::new();
    loop {
        let overview = cluster_overview(&state, Some(namespace.clone()))
            .await
            .expect("overview");
        served.push(overview.served_from);
        if overview.served_from == OverviewSource::Watch {
            assert_eq!(overview.counts.pods, Some(listed));
            assert!(overview.nodes_known);
            break;
        }
        assert!(
            started.elapsed() < Duration::from_secs(90),
            "never served from the watch: {served:?}"
        );
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    println!(
        "served {served:?} after {} ms",
        started.elapsed().as_millis()
    );

    let whole = cluster_overview(&state, None).await.expect("overview");
    assert_eq!(whole.served_from, OverviewSource::Watch);
    assert!(whole.counts.pods.unwrap_or(0) >= listed);
    assert_eq!(state.overview_cache.watching(), vec![context()]);

    state.overview_cache.forget(&context());
    assert!(state.overview_cache.watching().is_empty());
}
