//! A pod shell under load: how long `seq 1 300000` takes to reach the pane,
//! and whether Cyrillic arrives whole. And a closed shell: whether it is
//! still running in the container afterwards.
//!
//! ```text
//! K8S_GUI_INIT_CONTEXT=kind-rubick-gui K8S_GUI_TERMINAL_POD=web.v1 \
//!   cargo test --test live live_terminal:: -- --ignored --nocapture
//! ```

use std::time::{Duration, Instant};

use k8s_gui_lib::state::{AppEvent, AppState};
use k8s_gui_lib::terminal::{PodExecAdapter, SessionTarget, TerminalManager};

struct Shell {
    manager: TerminalManager,
    id: String,
    events: tokio::sync::broadcast::Receiver<AppEvent>,
    pods: kube::Api<k8s_openapi::api::core::v1::Pod>,
    pod: String,
}

async fn shell() -> Shell {
    let context =
        std::env::var("K8S_GUI_INIT_CONTEXT").unwrap_or_else(|_| "kind-rubick-gui".to_string());
    let namespace =
        std::env::var("K8S_GUI_INIT_NAMESPACE").unwrap_or_else(|_| "k8s-gui-test".to_string());
    let pod = std::env::var("K8S_GUI_TERMINAL_POD").unwrap_or_else(|_| "web.v1".to_string());
    k8s_gui_lib::tls::provider();
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
    // Before the gate opens: a broadcast replays nothing to a late receiver,
    // and a connect that fails reports the moment the gate is released.
    let events = state.event_tx.subscribe();
    let pods = kube::Api::namespaced((*client).clone(), &namespace);
    let adapter = PodExecAdapter::new(
        (*client).clone(),
        SessionTarget {
            context,
            namespace,
            pod: pod.clone(),
            container: "main".to_string(),
        },
        Some("sh"),
    );
    let id = manager.create_session(Box::new(adapter)).expect("session");
    manager.mark_subscribed(&id).expect("subscribed");
    Shell {
        manager,
        id,
        events,
        pods,
        pod,
    }
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
    let Shell {
        manager,
        id,
        mut events,
        ..
    } = shell().await;

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
    // Every number, once and in order: a marker alone at the end would pass
    // a stream that lost the middle.
    let numbers: Vec<u32> = said
        .split("\r\n")
        .filter_map(|line| line.trim().parse().ok())
        .collect();
    assert_eq!(numbers.len(), 300_000, "every line arrived");
    assert!(
        numbers.windows(2).all(|pair| pair[1] == pair[0] + 1),
        "in order"
    );

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
    assert_eq!(
        said.matches("привет-мир\r\n").count(),
        2000,
        "every line arrived"
    );
    let broken = said.matches('\u{fffd}').count();
    println!("привет-мир ×2000: {broken} replacement characters");
    assert_eq!(broken, 0);
}

/// Dana closed two shells and both `sh` processes were still in their pods
/// minutes later: dropping the exec stream does not end what it started.
#[tokio::test]
#[ignore = "needs a live cluster and a pod with a shell"]
async fn a_closed_shell_is_not_left_running_in_the_container() {
    let Shell {
        manager,
        id,
        mut events,
        pods,
        pod,
    } = shell().await;
    manager
        .send_input(&id, "echo PID-$$-END\n")
        .await
        .expect("input");
    let (said, _) = tokio::time::timeout(Duration::from_secs(30), until(&mut events, "-END\r\n"))
        .await
        .expect("the shell answers");
    let pid: u32 = said
        .rsplit("PID-")
        .next()
        .and_then(|rest| rest.split("-END").next())
        .and_then(|digits| digits.parse().ok())
        .expect("a pid");
    assert!(
        !said.contains("rubick-pid"),
        "the mark reached the pane: {said:?}"
    );

    manager.close_session(&id).expect("close");
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            if let AppEvent::TerminalClosed { session_id, .. } =
                events.recv().await.expect("the bus")
            {
                if session_id == id {
                    return;
                }
            }
        }
    })
    .await
    .expect("the session ends");
    assert!(manager.list().is_empty(), "the registry still lists it");

    let params = kube::api::AttachParams::default()
        .container("main")
        .stdout(true)
        .stderr(false);
    let mut probe = pods
        .exec(&pod, ["/bin/sh", "-c", &format!("kill -0 {pid}")], &params)
        .await
        .expect("probe");
    let status = probe
        .take_status()
        .expect("status")
        .await
        .expect("an answer");
    assert_ne!(
        status.status.as_deref(),
        Some("Success"),
        "pid {pid} is still running in {pod}"
    );
}
