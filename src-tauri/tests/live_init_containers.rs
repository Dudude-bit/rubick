//! Manual proof harness for init containers and previous-run logs
//! against a real cluster. Ignored by default — it needs a kubeconfig
//! and two specimen pods, so it is not part of the `--lib` gate.
//!
//! ```text
//! K8S_GUI_INIT_CONTEXT=k3d-k8s-gui-dev K8S_GUI_INIT_NAMESPACE=k8s-gui-test \
//!   cargo test --test live_init_containers -- --ignored --nocapture
//! ```
//!
//! Specimens (`test-manifests/k8s-gui-all.yaml`):
//!   * `init-demo`    — `Init:CrashLoopBackOff`. `wait-for-db` succeeds,
//!     `migrate` fails, `seed` never gets a turn, `app` never starts.
//!   * `sidecar-demo` — `Running`. `prepare` finishes, `proxy` has
//!     `restartPolicy: Always` and keeps running.
//!
//! It builds `PodInfo` through the same `From<&Pod>` the list, the
//! detail page and the watch stream all share, so what it prints is
//! what the frontend receives.

use k8s_gui_lib::error::Error;
use k8s_gui_lib::logs::LogConfig;
use k8s_gui_lib::resources::{ContainerPhase, ContainerState, PodInfo};
use k8s_gui_lib::state::{AppState, StreamFailureKind};
use k8s_openapi::api::core::v1::Pod;
use kube::Api;

async fn pod(state: &AppState, context: &str, namespace: &str, name: &str) -> Pod {
    let client = state
        .client_manager
        .get_client(context)
        .expect("client for context");
    let api: Api<Pod> = Api::namespaced((*client).clone(), namespace);
    api.get(name).await.expect("pod")
}

fn describe(info: &PodInfo) {
    println!("pod {} — {}", info.name, info.status.display);
    for (index, c) in info.init_containers.iter().enumerate() {
        println!(
            "  init[{index}] {:<12} {:?} state={:?} restarts={} previousRun={}",
            c.name,
            c.phase,
            c.state,
            c.restart_count,
            c.last_terminated.is_some(),
        );
    }
    for c in &info.containers {
        println!(
            "  app      {:<12} {:?} state={:?}",
            c.name, c.phase, c.state
        );
    }
}

#[tokio::test]
#[ignore = "needs a real kubeconfig and the init-container specimens"]
async fn init_containers_and_previous_runs_reach_the_frontend() {
    let context =
        std::env::var("K8S_GUI_INIT_CONTEXT").unwrap_or_else(|_| "k3d-k8s-gui-dev".to_string());
    let namespace =
        std::env::var("K8S_GUI_INIT_NAMESPACE").unwrap_or_else(|_| "k8s-gui-test".to_string());

    let _ = rustls::crypto::ring::default_provider().install_default();

    let state = AppState::new().expect("app state");
    state
        .client_manager
        .load_kubeconfig()
        .await
        .expect("kubeconfig");
    state
        .client_manager
        .connect(&context)
        .await
        .expect("connect");
    state.set_current_context(Some(context.clone()));

    // ----- init-demo: a sequence, with one failure and one that never ran.
    let info = PodInfo::from(&pod(&state, &context, &namespace, "init-demo").await);
    describe(&info);

    assert_eq!(
        info.init_containers
            .iter()
            .map(|c| c.name.as_str())
            .collect::<Vec<_>>(),
        ["wait-for-db", "migrate", "seed"],
    );
    assert!(info
        .init_containers
        .iter()
        .all(|c| c.phase == ContainerPhase::Init));

    match &info.init_containers[0].state {
        ContainerState::Terminated { termination } => {
            assert_eq!(termination.exit_code, 0);
            assert!(
                termination.finished_at.is_some(),
                "finished at T, not just 'not running'"
            );
        }
        other => panic!("wait-for-db should have succeeded, got {other:?}"),
    }

    let migrate = &info.init_containers[1];
    assert!(migrate.restart_count > 0, "migrate crash-loops");
    let death = migrate
        .last_terminated
        .as_ref()
        .expect("migrate has a previous run");
    assert_eq!(death.exit_code, 1);

    let seed = &info.init_containers[2];
    assert!(
        matches!(&seed.state, ContainerState::Waiting { .. }) && seed.restart_count == 0,
        "seed never got a turn",
    );
    assert!(seed.last_terminated.is_none());

    // ----- sidecar-demo: an init container that never finishes.
    let side = PodInfo::from(&pod(&state, &context, &namespace, "sidecar-demo").await);
    describe(&side);
    assert_eq!(side.init_containers[0].phase, ContainerPhase::Init);
    assert_eq!(side.init_containers[1].name, "proxy");
    assert_eq!(side.init_containers[1].phase, ContainerPhase::Sidecar);
    assert!(matches!(
        side.init_containers[1].state,
        ContainerState::Running
    ));

    // ----- the previous run of the failing init container.
    let client = state.client_manager.get_client(&context).expect("client");
    let streamer = k8s_gui_lib::logs::LogStreamer::new(
        std::sync::Arc::new((*client).clone()),
        state.event_tx.clone(),
    );

    let lines = streamer
        .get_logs(
            &LogConfig::new("init-demo", &namespace)
                .with_container("migrate")
                .with_follow(false)
                .with_previous(true),
        )
        .await
        .expect("migrate has a previous run to read");
    for line in &lines {
        println!("  migrate/previous: {}", line.message);
    }
    assert!(
        lines
            .iter()
            .any(|l| l.message.contains("relation \"orders\" does not exist")),
        "the previous run is the one that printed the error",
    );

    // ----- and the one that has none, which must not read as a failure.
    let err = streamer
        .get_logs(
            &LogConfig::new("init-demo", &namespace)
                .with_container("wait-for-db")
                .with_follow(false)
                .with_previous(true),
        )
        .await
        .expect_err("wait-for-db has never restarted");
    println!("  wait-for-db/previous: {err}");
    assert!(
        matches!(&err, Error::NoPreviousRun { container } if container == "wait-for-db"),
        "expected NoPreviousRun, got {err:?}",
    );
    assert_eq!(
        StreamFailureKind::classify(&err),
        StreamFailureKind::NoPreviousRun,
        "and it must not be reported as the pod having disappeared",
    );

    // A real disappearance still classifies as one.
    let gone = streamer
        .get_logs(
            &LogConfig::new("no-such-pod", &namespace)
                .with_container("app")
                .with_follow(false),
        )
        .await
        .expect_err("no such pod");
    println!("  no-such-pod: {gone}");
    assert_eq!(StreamFailureKind::classify(&gone), StreamFailureKind::Gone);
}
