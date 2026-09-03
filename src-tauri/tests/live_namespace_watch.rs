//! Manual proof that the namespace watch delivers, against a real cluster.
//! Ignored by default — it needs a kubeconfig and it creates a namespace.
//!
//! ```text
//! kind create cluster --name rubick-check
//! K8S_GUI_WATCH_CONTEXT=kind-rubick-check \
//!   cargo test --test live_namespace_watch -- --ignored --nocapture
//! ```
//!
//! Why this one and not the other eleven watches: `subscribe_namespace_watch`
//! existed for months and nothing called it. The Namespaces page polled while
//! every other cluster-scoped list watched, so the command had never run
//! outside a compiler check. Wiring the page up is worth nothing if the
//! stream behind it was never exercised.
//!
//! The events go through a `broadcast::Sender<AppEvent>` rather than a Tauri
//! handle, which is what makes this testable without a window at all.

use std::time::Duration;

use k8s_gui_lib::state::{AppEvent, AppState};
use k8s_openapi::api::core::v1::Namespace;

fn context() -> String {
    std::env::var("K8S_GUI_WATCH_CONTEXT").unwrap_or_else(|_| "kind-rubick-check".to_string())
}

async fn connected() -> (AppState, kube::Client) {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let state = AppState::new().expect("app state");
    state
        .client_manager
        .load_kubeconfig()
        .await
        .expect("kubeconfig");
    let client = state
        .client_manager
        .connect(&context())
        .await
        .expect("connect");
    let client = (*client).clone();
    (state, client)
}

/// A namespace created while the page is open has to reach the page.
///
/// Would break if the watch produced nothing, or produced it under a stream
/// id the frontend is not listening on — the two ways this can fail silently,
/// since the page falls back to polling and still eventually shows the row.
/// The fallback is what makes a broken watch invisible, so the test has to
/// look at the stream rather than at the eventual list.
#[tokio::test]
#[ignore = "needs a live cluster"]
async fn a_namespace_created_now_arrives_on_the_stream() {
    let (state, client) = connected().await;
    let api: kube::Api<Namespace> = kube::Api::all(client);
    let name = "rubick-watch-probe";

    // Subscribe *before* creating, and take the receiver before that: the
    // channel drops anything sent while nobody holds a receiver.
    let mut events = state.event_tx.subscribe();
    let stream_id = state.watch_manager.subscribe_cluster::<Namespace, _, _>(
        (*state
            .client_manager
            .connect(&context())
            .await
            .expect("connect"))
        .clone(),
        "Namespace",
        |ns| Some(k8s_gui_lib::resources::NamespaceInfo::from(ns)),
    );
    // The watcher holds its initial burst until the frontend says it is
    // listening; without this the test waits on a stream that never starts.
    state
        .watch_manager
        .mark_subscribed(&stream_id)
        .expect("release the gate");

    let _ = api.delete(name, &Default::default()).await;
    tokio::time::sleep(Duration::from_secs(2)).await;

    let ns: Namespace = serde_json::from_value(serde_json::json!({
        "apiVersion": "v1",
        "kind": "Namespace",
        "metadata": { "name": name },
    }))
    .expect("namespace literal");
    api.create(&Default::default(), &ns)
        .await
        .expect("create the probe namespace");

    let saw = tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            match events.recv().await {
                Ok(AppEvent::ResourceWatchEvent {
                    stream_id: id,
                    changes,
                    ..
                }) if id == stream_id => {
                    if changes.iter().any(|change| {
                        serde_json::to_string(change)
                            .unwrap_or_default()
                            .contains(name)
                    }) {
                        return true;
                    }
                }
                Ok(_) => {}
                Err(_) => return false,
            }
        }
    })
    .await;

    let _ = api.delete(name, &Default::default()).await;
    assert!(
        matches!(saw, Ok(true)),
        "the namespace watch never mentioned {name}: {saw:?}"
    );
}
