//! Records every event a cluster currently holds, as the app reads them, so
//! the story builder is tested against what controllers really wrote.
//!
//! ```text
//! K8S_GUI_SHAPE_CONTEXT=k3d-k8s-gui-dev \
//!   cargo test --test live_events -- --ignored --nocapture
//! ```
//!
//! Feeds `src/lib/event-stories.test.ts`. Re-record rather than hand-edit.

use k8s_openapi::api::core::v1::Event;
use kube::api::ListParams;
use kube::Api;

use k8s_gui_lib::resources::EventInfo;
use k8s_gui_lib::state::AppState;

async fn client() -> kube::Client {
    let name =
        std::env::var("K8S_GUI_SHAPE_CONTEXT").unwrap_or_else(|_| "k3d-k8s-gui-dev".to_string());
    let _ = rustls::crypto::ring::default_provider().install_default();
    let state = AppState::new().expect("app state");
    state
        .client_manager
        .load_kubeconfig()
        .await
        .expect("kubeconfig");
    (*state.client_manager.connect(&name).await.expect("connect")).clone()
}

#[tokio::test]
#[ignore = "needs a cluster with a few hours of history"]
async fn dump_every_event() {
    let client = client().await;
    let api: Api<Event> = Api::all(client);
    let mut items = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let mut params = ListParams::default().limit(500);
        if let Some(t) = token.as_deref() {
            params = params.continue_token(t);
        }
        let mut page = api.list(&params).await.expect("list events");
        token = page.metadata.continue_.take().filter(|t| !t.is_empty());
        items.append(&mut page.items);
        if token.is_none() {
            break;
        }
    }
    let mut events: Vec<EventInfo> = items.iter().map(EventInfo::from).collect();
    events.sort_by_key(|e| std::cmp::Reverse(e.last_timestamp));
    println!("  {} events", events.len());

    let out = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../src/lib/__fixtures__/live-events.json");
    std::fs::write(&out, serde_json::to_string_pretty(&events).unwrap()).expect("write");
    println!("  written to {}", out.display());
    assert!(events.len() > 100, "a corpus, not a sample");
}
