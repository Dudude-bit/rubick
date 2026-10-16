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
use tokio::io::AsyncReadExt;

type Pods = kube::Api<k8s_openapi::api::core::v1::Pod>;

/// The tests share one container, so they take turns: one test's shell must
/// not be counted as another's leftover.
static ONE_AT_A_TIME: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Every `sh` in the container before this run opened one.
static BEFORE_THE_RUN: tokio::sync::OnceCell<Vec<u32>> = tokio::sync::OnceCell::const_new();

/// The pid of every `sh` in the container but the one asking. `read` and `[`
/// are builtins, so the probe forks nothing that could be counted.
const LIST_SHELLS: &str = r#"for p in /proc/[0-9]*; do { read -r c < "$p/comm"; } 2>/dev/null && [ "$c" = sh ] && [ "${p#/proc/}" != "$$" ] && echo "${p#/proc/}"; done"#;

struct Shell {
    manager: TerminalManager,
    id: String,
    events: tokio::sync::broadcast::Receiver<AppEvent>,
    pods: Pods,
    pod: String,
    _turn: tokio::sync::MutexGuard<'static, ()>,
}

async fn shell() -> Shell {
    let turn = ONE_AT_A_TIME.lock().await;
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
    BEFORE_THE_RUN.get_or_init(|| shells_in(&pods, &pod)).await;
    let adapter = PodExecAdapter::new(
        (*client).clone(),
        SessionTarget {
            context,
            namespace,
            pod: pod.clone(),
            container: "main".to_string(),
        },
        Some("sh"),
        Some((120, 40)),
    );
    let id = manager.create_session(Box::new(adapter)).expect("session");
    manager.mark_subscribed(&id).expect("subscribed");
    Shell {
        manager,
        id,
        events,
        pods,
        pod,
        _turn: turn,
    }
}

async fn shells_in(pods: &Pods, pod: &str) -> Vec<u32> {
    let params = kube::api::AttachParams::default()
        .container("main")
        .stdout(true)
        .stderr(false);
    let mut probe = pods
        .exec(pod, ["/bin/sh", "-c", LIST_SHELLS], &params)
        .await
        .expect("probe");
    let mut said = String::new();
    if let Some(mut stdout) = probe.stdout() {
        stdout.read_to_string(&mut said).await.expect("read");
    }
    if let Some(status) = probe.take_status() {
        let _ = status.await;
    }
    let mut pids: Vec<u32> = said.lines().filter_map(|l| l.trim().parse().ok()).collect();
    pids.sort_unstable();
    pids
}

impl Shell {
    /// Close the shell, wait for the hang-up, and fail if any `sh` this run
    /// started is still in the container. Read a few times, a second apart:
    /// another test's short exec passes, a shell left behind stays.
    async fn end(&self) {
        assert!(
            self.manager
                .close_and_wait(&self.id, Duration::from_secs(15))
                .await,
            "the shell was not hung up within 15 s"
        );
        assert!(
            self.manager.list().is_empty(),
            "the registry still lists it"
        );
        let before = BEFORE_THE_RUN.get().expect("read before the first shell");
        let mut left: Vec<u32> = Vec::new();
        for read in 0..4 {
            if read > 0 {
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
            let now: Vec<u32> = shells_in(&self.pods, &self.pod)
                .await
                .into_iter()
                .filter(|pid| !before.contains(pid))
                .collect();
            left = if read == 0 {
                now
            } else {
                left.into_iter().filter(|pid| now.contains(pid)).collect()
            };
            if left.is_empty() {
                return;
            }
        }
        panic!("sh left running in {} by this run: {left:?}", self.pod);
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

/// `seq 1 300000` and two thousand Cyrillic lines, through the same path the
/// pane reads. Fails if a line is lost, reordered or split into U+FFFD.
#[tokio::test]
#[ignore = "needs a live cluster and a pod with a shell"]
async fn a_busy_shell_reaches_the_pane_quickly_and_whole() {
    let mut shell = shell().await;
    let (manager, id) = (&shell.manager, shell.id.clone());

    let started = Instant::now();
    manager
        .send_input(&id, "seq 1 300000; echo SEQ-$((1+1))-DONE\n")
        .await
        .expect("input");
    let (said, events_seen) = tokio::time::timeout(
        Duration::from_secs(120),
        until(&mut shell.events, "SEQ-2-DONE\r\n"),
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
        until(&mut shell.events, "CYR-2-DONE\r\n"),
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
    shell.end().await;
}

/// Dana closed two shells and both `sh` processes were still in their pods
/// minutes later: dropping the exec stream does not end what it started.
/// The k3d run left two more, from the tests beside this one, so this also
/// fails if any `sh` the run started is still there.
#[tokio::test]
#[ignore = "needs a live cluster and a pod with a shell"]
async fn a_closed_shell_is_not_left_running_in_the_container() {
    let mut shell = shell().await;
    shell
        .manager
        .send_input(&shell.id, "echo PID-$$-END\n")
        .await
        .expect("input");
    let (said, _) = tokio::time::timeout(
        Duration::from_secs(30),
        until(&mut shell.events, "-END\r\n"),
    )
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

    shell.end().await;

    let params = kube::api::AttachParams::default()
        .container("main")
        .stdout(true)
        .stderr(false);
    let mut probe = shell
        .pods
        .exec(
            &shell.pod,
            ["/bin/sh", "-c", &format!("kill -0 {pid}")],
            &params,
        )
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
        "pid {pid} is still running in {}",
        shell.pod
    );
}

/// Lena's Shell opened on three `/srv/app #` prompts: busybox 1.36 draws a
/// new one for every resize, and the pane's size arrived after the shell
/// was up. Opened at the size, the pane saying it again changes nothing.
#[tokio::test]
#[ignore = "needs a live cluster and a pod with a shell"]
async fn a_shell_opened_at_the_pane_size_prints_one_prompt() {
    let mut shell = shell().await;
    let heard = |events: &mut tokio::sync::broadcast::Receiver<AppEvent>| {
        let mut said = String::new();
        while let Ok(event) = events.try_recv() {
            if let AppEvent::TerminalOutput { data, .. } = event {
                said.push_str(&data);
            }
        }
        said
    };
    tokio::time::sleep(Duration::from_secs(2)).await;
    let first = heard(&mut shell.events);
    assert!(!first.trim().is_empty(), "the shell printed a prompt");

    shell
        .manager
        .resize_session(&shell.id, 120, 40)
        .await
        .expect("resize");
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(
        heard(&mut shell.events),
        "",
        "the same size drew another prompt"
    );
    shell.end().await;
}
