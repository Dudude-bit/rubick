//! A pod shell under load: how long `seq 1 300000` takes to reach the pane,
//! and whether Cyrillic arrives whole.
//!
//! ```text
//! K8S_GUI_INIT_CONTEXT=kind-rubick-gui K8S_GUI_TERMINAL_POD=web.v1 \
//!   cargo test --test live live_terminal:: -- --ignored --nocapture
//! ```

use std::time::{Duration, Instant};

use k8s_gui_lib::state::{AppEvent, AppState};
use k8s_gui_lib::terminal::{PodExecAdapter, TerminalManager};

async fn shell() -> (AppState, TerminalManager, String) {
    let context =
        std::env::var("K8S_GUI_INIT_CONTEXT").unwrap_or_else(|_| "kind-rubick-gui".to_string());
    let namespace =
        std::env::var("K8S_GUI_INIT_NAMESPACE").unwrap_or_else(|_| "k8s-gui-test".to_string());
    let pod = std::env::var("K8S_GUI_TERMINAL_POD").unwrap_or_else(|_| "web.v1".to_string());
    let _ = rustls::crypto::ring::default_provider().install_default();
    let state = AppState::new().expect("app state");
    state
        .client_manager
        .load_kubeconfig()
        .await
        .expect("kubeconfig");
    let client = state
        .client_manager
        .connect(&context)
        .await
        .expect("connect");
    let manager = TerminalManager::new(state.event_tx.clone());
    let adapter = PodExecAdapter::new(
        (*client).clone(),
        namespace,
        pod,
        "main".to_string(),
        vec!["sh".to_string()],
    );
    let id = manager
        .create_session(Box::new(adapter))
        .await
        .expect("session");
    manager.mark_subscribed(&id).expect("subscribed");
    (state, manager, id)
}

/// Everything the shell prints until `marker` has arrived. The marker is
/// computed by the shell, so the echo of the typed line does not contain it.
async fn until(
    events: &mut tokio::sync::broadcast::Receiver<AppEvent>,
    marker: &str,
) -> (String, usize) {
    let mut said = String::new();
    let mut count = 0;
    while !said.contains(marker) {
        match events.recv().await.expect("the bus") {
            AppEvent::TerminalOutput { data, .. } => {
                count += 1;
                said.push_str(&data);
            }
            AppEvent::StreamFailed { message, .. } => panic!("the shell failed: {message}"),
            _ => {}
        }
    }
    (said, count)
}

#[tokio::test]
#[ignore = "needs a live cluster and a pod with a shell"]
async fn a_busy_shell_reaches_the_pane_quickly_and_whole() {
    let (state, manager, id) = shell().await;
    let mut events = state.event_tx.subscribe();

    let started = Instant::now();
    manager
        .send_input(&id, "seq 1 300000; echo SEQ-$((1+1))-DONE\n")
        .await
        .expect("input");
    let (said, events_seen) = tokio::time::timeout(
        Duration::from_secs(120),
        until(&mut events, "SEQ-2-DONE\r\n"),
    )
    .await
    .expect("within two minutes");
    let took = started.elapsed();
    println!(
        "seq 1 300000: {:.2} s, {} bytes in {events_seen} events",
        took.as_secs_f64(),
        said.len()
    );
    assert!(said.contains("\r\n300000\r\n"));

    manager
        .send_input(
            &id,
            "for i in $(seq 1 2000); do echo привет-мир; done; echo CYR-$((1+1))-DONE\n",
        )
        .await
        .expect("input");
    let (said, _) = tokio::time::timeout(
        Duration::from_secs(60),
        until(&mut events, "CYR-2-DONE\r\n"),
    )
    .await
    .expect("within a minute");
    let broken = said.matches('\u{fffd}').count();
    println!("привет-мир ×2000: {broken} replacement characters");
    assert_eq!(broken, 0);
}
