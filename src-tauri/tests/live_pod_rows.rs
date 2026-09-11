//! The paged pod list against a real cluster: every page lands, no row twice,
//! and no chunk over the IPC target. Run against the rig (`make perf-rig`) or
//! any cluster:
//!
//!     RUBICK_PERF_CONTEXT=k3d-rubick-perf \
//!       cargo test --test live_pod_rows -- --ignored --nocapture

use k8s_gui_lib::commands::pods::page_rows;
use k8s_gui_lib::resources::PodRow;
use k8s_gui_lib::state::perf::{chunks_within, IPC_TARGET_BYTES};
use k8s_openapi::api::core::v1::Pod;
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::{api::ListParams, Api, Client, Config};
use std::collections::HashSet;
use tokio::sync::oneshot;

async fn client() -> Client {
    let context = std::env::var("RUBICK_PERF_CONTEXT").ok();
    let config = match context {
        Some(context) => Config::from_custom_kubeconfig(
            Kubeconfig::read().expect("kubeconfig"),
            &KubeConfigOptions {
                context: Some(context),
                ..Default::default()
            },
        )
        .await
        .expect("kubeconfig context"),
        None => Config::infer().await.expect("kube config"),
    };
    Client::try_from(config).expect("client")
}

/// A page boundary that dropped or repeated a row would show here as a
/// count or a uid the unpaged list disagrees with.
#[tokio::test]
#[ignore = "needs a cluster"]
async fn paging_delivers_every_pod_once_in_messages_under_the_target() {
    let client = client().await;
    let api: Api<Pod> = Api::all(client);
    let whole = api.list(&ListParams::default()).await.expect("list pods");

    let (_cancel_tx, mut cancel_rx) = oneshot::channel::<()>();
    let mut pages = 0usize;
    let mut messages = 0usize;
    let mut largest = 0usize;
    let mut seen: HashSet<String> = HashSet::new();
    let paged = page_rows(
        &api,
        |rows: Vec<PodRow>| {
            pages += 1;
            for chunk in chunks_within(rows, IPC_TARGET_BYTES) {
                let bytes = serde_json::to_vec(&chunk).expect("serialise chunk").len();
                largest = largest.max(bytes);
                messages += 1;
                for row in chunk {
                    assert!(seen.insert(row.uid.clone()), "{} arrived twice", row.name);
                }
            }
        },
        &mut cancel_rx,
    )
    .await
    .expect("paged list");

    println!(
        "pods {} pages {} messages {} largest {} KiB",
        paged.rows,
        pages,
        messages,
        largest / 1024
    );
    assert!(paged.complete);
    assert_eq!(paged.rows, whole.items.len());
    assert_eq!(seen.len(), whole.items.len());
    assert!(
        largest <= IPC_TARGET_BYTES + 1024,
        "largest chunk {largest} bytes"
    );
}

/// A stop mid-list ends with `complete: false` and whatever had arrived, not
/// with a list that claims to be the cluster.
#[tokio::test]
#[ignore = "needs a cluster"]
async fn a_cancelled_list_says_it_is_incomplete() {
    let client = client().await;
    let api: Api<Pod> = Api::all(client);
    let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();
    cancel_tx.send(()).expect("cancel");
    let paged = page_rows(&api, |_rows| {}, &mut cancel_rx)
        .await
        .expect("paged list");
    assert!(!paged.complete);
    assert_eq!(paged.rows, 0);
}
