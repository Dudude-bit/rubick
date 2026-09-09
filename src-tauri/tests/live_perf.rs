//! The backend half of a baseline: what a full pod list costs before the
//! frontend sees it. Run against the rig (`make perf-rig`):
//!
//!     RUBICK_PERF_CONTEXT=k3d-rubick-perf \
//!       cargo test --test live_perf -- --ignored --nocapture
//!
//! Prints the API round trip, the conversion to `PodInfo`, and the size of
//! the JSON the IPC bridge would carry, per row and in total.

use k8s_gui_lib::resources::PodInfo;
use k8s_openapi::api::core::v1::Pod;
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::{api::ListParams, Api, Client, Config};
use std::time::Instant;

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

#[tokio::test]
#[ignore = "needs the perf rig; prints a baseline rather than asserting one"]
async fn a_full_pod_list_costs_this_much_before_the_frontend() {
    let client = client().await;
    let api: Api<Pod> = Api::all(client);

    let started = Instant::now();
    let list = api.list(&ListParams::default()).await.expect("list pods");
    let fetched = started.elapsed();

    let converting = Instant::now();
    let rows: Vec<PodInfo> = list.items.iter().map(PodInfo::from).collect();
    let converted = converting.elapsed();

    let serialising = Instant::now();
    let json = serde_json::to_vec(&rows).expect("serialise");
    let serialised = serialising.elapsed();

    let raw = serde_json::to_vec(&list.items)
        .expect("serialise raw")
        .len();
    println!("pods                 {}", rows.len());
    println!("api list             {} ms", fetched.as_millis());
    println!("to PodInfo           {} ms", converted.as_millis());
    println!("to JSON              {} ms", serialised.as_millis());
    println!(
        "ipc payload          {} KiB ({} bytes/row)",
        json.len() / 1024,
        json.len() / rows.len().max(1)
    );
    println!(
        "raw Pod objects      {} KiB ({} bytes/row)",
        raw / 1024,
        raw / rows.len().max(1)
    );
}
