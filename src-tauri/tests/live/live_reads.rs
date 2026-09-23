//! A log line that is not UTF-8, read both ways the app reads logs.
//!
//! ```text
//! kubectl apply -f test-manifests/odd-bytes-and-names.yaml
//! K8S_GUI_INIT_CONTEXT=kind-rubick-gui cargo test --test live live_reads:: -- --ignored --nocapture
//! ```

use std::sync::Arc;
use std::time::Duration;

use k8s_gui_lib::logs::{LogConfig, LogStreamer};
use k8s_gui_lib::state::{AppEvent, AppState};

const EXPECTED: [&str; 3] = ["ok", "\u{fffd}\u{fffd}", "after"];

async fn streamer() -> (AppState, LogStreamer) {
    let context =
        std::env::var("K8S_GUI_INIT_CONTEXT").unwrap_or_else(|_| "kind-rubick-gui".to_string());
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
    let streamer = LogStreamer::new(Arc::new((*client).clone()), state.event_tx.clone());
    (state, streamer)
}

fn config() -> LogConfig {
    let namespace =
        std::env::var("K8S_GUI_INIT_NAMESPACE").unwrap_or_else(|_| "k8s-gui-test".to_string());
    LogConfig::new("bad-bytes", &namespace).with_container("main")
}

/// The whole history used to fail with the first bad byte, and "Download"
/// with it.
#[tokio::test]
#[ignore = "needs a live cluster and the bad-bytes specimen"]
async fn a_one_shot_read_keeps_every_line_around_a_bad_byte() {
    let (_state, streamer) = streamer().await;
    let lines = streamer
        .get_logs(&config().with_follow(false))
        .await
        .expect("a bad byte is one character, not a failed read");
    let messages: Vec<&str> = lines.iter().map(|l| l.message.as_str()).collect();
    println!("{messages:?}");
    assert_eq!(messages, EXPECTED);
}

/// The stream used to end at the bad byte with "the log stream broke", and
/// Reconnect read the same byte again.
#[tokio::test]
#[ignore = "needs a live cluster and the bad-bytes specimen"]
async fn a_followed_stream_reads_past_a_bad_byte() {
    let (state, streamer) = streamer().await;
    let mut events = state.event_tx.subscribe();
    let (cancel, cancelled) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        streamer
            .stream_logs("bytes".into(), config().with_follow(true), cancelled)
            .await
    });

    let mut seen = Vec::new();
    let read = tokio::time::timeout(Duration::from_secs(30), async {
        while seen.len() < EXPECTED.len() {
            match events.recv().await.expect("the event bridge") {
                AppEvent::LogBatch { stream_id, lines } if stream_id == "bytes" => {
                    seen.extend(lines.into_iter().map(|l| l.message));
                }
                AppEvent::StreamFailed {
                    stream_id, message, ..
                } if stream_id == "bytes" => panic!("the stream failed: {message}"),
                _ => {}
            }
        }
    })
    .await;
    let _ = cancel.send(());
    task.await.expect("stream task").expect("stream");

    read.expect("three lines within 30 s");
    println!("{seen:?}");
    assert_eq!(seen, EXPECTED);
}
