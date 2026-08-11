//! Manual proof harness for cross-cluster search against real
//! clusters. Ignored by default — it needs a kubeconfig and reachable
//! (or deliberately unreachable) contexts, so it is not part of the
//! `--lib` gate.
//!
//! ```text
//! K8S_GUI_SEARCH_CONTEXTS=ctx-a,ctx-b \
//! K8S_GUI_SEARCH_QUERY=api \
//!   cargo test --test cross_cluster_search -- --ignored --nocapture
//! ```
//!
//! It drives the same entry point the Tauri command does, so what it
//! prints is what the frontend receives.

use k8s_gui_lib::search::{SearchManager, SearchRequest};
use k8s_gui_lib::state::{AppEvent, AppState};
use std::time::Duration;

#[tokio::test]
#[ignore = "needs a real kubeconfig; run explicitly with --ignored"]
async fn fan_out_reports_every_cluster() {
    let contexts: Vec<String> = std::env::var("K8S_GUI_SEARCH_CONTEXTS")
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let query = std::env::var("K8S_GUI_SEARCH_QUERY").unwrap_or_else(|_| "k8s".to_string());
    let connect = std::env::var("K8S_GUI_SEARCH_CONNECT").as_deref() != Ok("0");

    // Same install `main()` does before any TLS work; without it every
    // client build panics inside rustls.
    let _ = rustls::crypto::ring::default_provider().install_default();

    let state = AppState::new().expect("app state");
    state
        .client_manager
        .load_kubeconfig()
        .await
        .expect("kubeconfig");
    let current = state
        .client_manager
        .get_current_context()
        .await
        .expect("current context lookup");
    state.set_current_context(current.clone());
    if let Some(ctx) = current.as_deref() {
        // Mirrors the app: the active cluster is already connected
        // before the palette is ever opened.
        state.client_manager.connect(ctx).await.expect("connect");
    }

    let mut events = state.subscribe();
    let handle = SearchManager::start_from_request(
        &state,
        SearchRequest {
            query: query.clone(),
            contexts,
            all_contexts: false,
            namespace: None,
            kinds: None,
            connect,
            limit_per_context: Some(20),
        },
    )
    .await
    .expect("search start");

    println!("query   : {query:?}");
    println!("searchId: {}", handle.search_id);
    for target in &handle.targets {
        println!(
            "target  : {:<32} {:?} {} {}",
            target.context,
            target.status,
            target
                .reason
                .map(|r| format!("{r:?}"))
                .unwrap_or_else(|| "-".to_string()),
            target.message.clone().unwrap_or_default(),
        );
    }
    state
        .search_manager
        .mark_subscribed(&handle.search_id)
        .expect("gate");

    let started = std::time::Instant::now();
    let mut terminal = 0usize;
    let expected = handle.targets.iter().filter(|t| t.is_active()).count();

    while terminal < expected && started.elapsed() < Duration::from_secs(40) {
        let Ok(Ok(event)) = tokio::time::timeout(Duration::from_secs(5), events.recv()).await
        else {
            break;
        };
        match event {
            AppEvent::SearchHits {
                search_id,
                context,
                hits,
            } if search_id == handle.search_id => {
                for hit in hits {
                    println!(
                        "[{:>6}ms] hit    {context} :: {}/{} {}",
                        started.elapsed().as_millis(),
                        hit.kind,
                        hit.namespace.clone().unwrap_or_else(|| "-".to_string()),
                        hit.name,
                    );
                }
            }
            AppEvent::SearchStatus {
                search_id,
                context,
                status,
                reason,
                message,
                matched,
                truncated,
            } if search_id == handle.search_id => {
                println!(
                    "[{:>6}ms] status {context} :: {status:?} reason={reason:?} matched={matched} truncated={truncated} message={}",
                    started.elapsed().as_millis(),
                    message.unwrap_or_else(|| "-".to_string()),
                );
                if !matches!(
                    status,
                    k8s_gui_lib::search::SearchContextStatus::Searching
                        | k8s_gui_lib::search::SearchContextStatus::Connecting
                ) {
                    terminal += 1;
                }
            }
            _ => {}
        }
    }

    assert_eq!(
        terminal, expected,
        "every active cluster must reach a terminal status"
    );
}
