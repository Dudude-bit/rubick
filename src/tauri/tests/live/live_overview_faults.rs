//! The Overview's health inputs on a real cluster behind a proxy that fails
//! one kind's reads on demand: what the overview and the Service verdicts
//! carry with Pods refused, and with Deployments failing, against the same
//! cluster read whole. Prints the numbers; it asserts only that a failed read
//! is carried, never drawn as a verdict.
//!
//!     KUBECONFIG=<rig kubeconfig> K8S_GUI_INIT_CONTEXT=gke-prod \
//!       RUBICK_CHAOS_FILE=<rig chaos.json> \
//!       cargo test --test live live_overview_faults:: -- --ignored --nocapture

use k8s_gui_lib::commands::network::{service_health_inputs, ServiceHealthInputs};
use k8s_gui_lib::commands::overview::{cluster_overview, ClusterOverview, OverviewUnread};
use k8s_gui_lib::resources::{ChainStop, NotServing};
use k8s_gui_lib::AppState;
use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

fn context() -> String {
    std::env::var("K8S_GUI_INIT_CONTEXT").unwrap_or_else(|_| "gke-prod".into())
}

fn chaos(rules: &serde_json::Value) {
    let path =
        std::env::var("RUBICK_CHAOS_FILE").expect("RUBICK_CHAOS_FILE names the proxy's fault file");
    std::fs::write(path, rules.to_string()).expect("fault file");
}

async fn connected() -> AppState {
    k8s_gui_lib::tls::provider();
    let state = AppState::new().expect("app state");
    state
        .client_manager
        .load_kubeconfig()
        .await
        .expect("kubeconfig");
    state
        .client_manager
        .connect(&context())
        .await
        .expect("connect");
    state.set_current_context(Some(context()));
    state
}

/// How the shell's verdict reads a group, as `serviceHealthOf` does.
fn verdict(stop: Option<&ChainStop>) -> &'static str {
    match stop {
        None => "serving",
        Some(ChainStop::ScaledToZero { .. }) => "idle",
        Some(ChainStop::PodsBeingMade { .. }) => "comingUp",
        Some(ChainStop::SelectsNothing {
            near: None,
            makers_read: false,
            ..
        }) => "unread",
        Some(ChainStop::PublishesNothingYet {
            pods_unread: true, ..
        }) => "unread",
        Some(ChainStop::NoneReady {
            why: NotServing::PodsUnread,
            ..
        }) => "unread",
        Some(ChainStop::NoneReady {
            why: NotServing::ComingUp,
            ..
        }) => "comingUp",
        Some(_) => "red",
    }
}

fn stop_name(stop: Option<&ChainStop>) -> String {
    match stop {
        None => "-".into(),
        Some(ChainStop::PublishesNothingYet { pods_unread, .. }) => {
            format!("publishesNothingYet(podsUnread={pods_unread})")
        }
        Some(ChainStop::SelectsNothing {
            makers_read, near, ..
        }) => format!(
            "selectsNothing(makersRead={makers_read},near={})",
            near.is_some()
        ),
        Some(ChainStop::NoneReady { why, .. }) => format!("noneReady({why:?})"),
        Some(other) => serde_json::to_value(other).expect("stop")["reason"]
            .as_str()
            .unwrap_or("?")
            .to_string(),
    }
}

const NEEDS_PODS_OR_MAKERS: [&str; 5] = [
    "publishesNothingYet",
    "selectsNothing",
    "scaledToZero",
    "podsBeingMade",
    "noneReady",
];

fn withheld(stop: Option<&ChainStop>, namespace: &str, lost: &[&OverviewUnread]) -> bool {
    let Some(stop) = stop else { return false };
    let reason = serde_json::to_value(stop).expect("stop")["reason"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    NEEDS_PODS_OR_MAKERS.contains(&reason.as_str())
        && lost
            .iter()
            .any(|entry| entry.namespace.as_deref().is_none_or(|ns| ns == namespace))
}

/// The Services drawn red, by namespace and name, and how many read idle.
struct Drawn {
    red: BTreeSet<String>,
    idle: usize,
}

fn print(label: &str, overview: &ClusterOverview, services: &[ServiceHealthInputs]) -> Drawn {
    println!("\n== {label}");
    println!("  served_from: {:?}", overview.served_from);
    for entry in &overview.unread {
        println!(
            "  unread: {} ns={:?} code={} {}",
            entry.kind, entry.namespace, entry.code, entry.message
        );
    }
    println!(
        "  counts: pods={:?} deployments={:?}",
        overview.counts.pods, overview.counts.deployments
    );
    match &overview.pods {
        Some(pods) => println!(
            "  pods census: complete={} running={} ready={} pending={}",
            pods.complete, pods.read.running, pods.read.ready, pods.read.pending
        ),
        None => println!("  pods census: None"),
    }
    match &overview.deployments {
        Some(census) => println!(
            "  deployments census: complete={} {:?}",
            census.complete,
            census
                .read
                .iter()
                .map(|c| format!(
                    "{}={}{}",
                    c.reason,
                    c.count,
                    if c.pods_unread { "?" } else { "" }
                ))
                .collect::<Vec<_>>()
        ),
        None => println!("  deployments census: None"),
    }
    println!(
        "  problems={} unconfirmed={}",
        overview.problems.len(),
        overview.unconfirmed.len()
    );
    let lost: Vec<&OverviewUnread> = overview
        .unread
        .iter()
        .filter(|entry| entry.kind != "Node")
        .collect();
    let mut verdicts: BTreeMap<&str, usize> = BTreeMap::new();
    let mut red_rows = Vec::new();
    let mut red = BTreeSet::new();
    let mut withheld_rows = 0;
    for inputs in services {
        for group in &inputs.groups {
            let stop = group.stop.as_ref();
            let says = verdict(stop);
            *verdicts.entry(says).or_default() += group.names.len();
            if says == "red" {
                red.extend(
                    group
                        .names
                        .iter()
                        .map(|name| format!("{}/{name}", inputs.namespace)),
                );
            }
            if says == "red" && stop.is_some() {
                if withheld(stop, &inputs.namespace, &lost) {
                    withheld_rows += group.names.len();
                } else {
                    for name in &group.names {
                        red_rows.push(format!("{}/{} {}", inputs.namespace, name, stop_name(stop)));
                    }
                }
            }
            if says == "unread" {
                for name in &group.names {
                    println!(
                        "  unread service: {}/{} {}",
                        inputs.namespace,
                        name,
                        stop_name(stop)
                    );
                }
            }
        }
    }
    println!("  service verdicts: {verdicts:?}");
    println!(
        "  red service rows (attention): {} withheld by overview.unread: {withheld_rows}",
        red_rows.len()
    );
    for row in red_rows {
        println!("    {row}");
    }
    Drawn {
        idle: verdicts.get("idle").copied().unwrap_or_default(),
        red,
    }
}

async fn look(state: &AppState, label: &str) -> Drawn {
    let overview = cluster_overview(state, None).await.expect("overview");
    let services = service_health_inputs(state, None)
        .await
        .expect("service inputs")
        .rows;
    print(label, &overview, &services)
}

/// A failed read neither adds a fault the whole read did not find nor
/// calls a Service idle, which takes every workload list read.
fn carried(faulted: &Drawn, whole: &Drawn, label: &str) {
    assert!(
        faulted.red.is_subset(&whole.red),
        "{label}: red beyond the whole read: {:?}",
        faulted.red.difference(&whole.red).collect::<Vec<_>>()
    );
    assert_eq!(faulted.idle, 0, "{label}: idle beside a failed read");
}

#[tokio::test]
#[ignore = "needs a cluster behind the fault-injecting proxy"]
async fn a_failed_read_behind_the_overview_is_carried_never_drawn_as_a_verdict() {
    chaos(&serde_json::json!([]));
    let warm = connected().await;
    look(&warm, "baseline, first read").await;
    tokio::time::sleep(Duration::from_secs(3)).await;
    let whole = look(&warm, "baseline, stores filled").await;

    let pods = serde_json::json!([{
        "match": "/pods(\\?|$)", "code": 403, "reason": "Forbidden",
        "message": "pods is forbidden: User \"jane@example.com\" cannot list resource \"pods\""
    }]);
    chaos(&pods);
    let pods_warm = look(&warm, "pods 403, stores warm").await;
    let pods_cold = look(&connected().await, "pods 403, cold").await;

    chaos(&serde_json::json!([]));
    let warm = connected().await;
    look(&warm, "baseline again, first read").await;
    tokio::time::sleep(Duration::from_secs(3)).await;
    look(&warm, "baseline again, stores filled").await;

    let deployments = serde_json::json!([{
        "match": "/deployments", "code": 500, "reason": "InternalError",
        "message": "etcdserver: request timed out"
    }]);
    chaos(&deployments);
    let deployments_warm = look(&warm, "deployments 500, stores warm").await;
    let deployments_cold = look(&connected().await, "deployments 500, cold").await;

    chaos(&serde_json::json!([]));
    carried(&pods_warm, &whole, "pods 403, warm");
    carried(&pods_cold, &whole, "pods 403, cold");
    carried(&deployments_warm, &whole, "deployments 500, warm");
    carried(&deployments_cold, &whole, "deployments 500, cold");
}

/// How long warm stores keep answering after a kind's reads start failing:
/// an open watch still streams, so until it reconnects the overview is read
/// and the lists beside it are not.
#[tokio::test]
#[ignore = "needs a cluster behind the fault-injecting proxy; takes up to six minutes"]
async fn warm_stores_answer_until_their_watch_reconnects_into_the_fault() {
    chaos(&serde_json::json!([]));
    let state = connected().await;
    cluster_overview(&state, None).await.expect("overview");
    tokio::time::sleep(Duration::from_secs(3)).await;
    chaos(&serde_json::json!([{
        "match": "/pods(\\?|$)", "code": 403, "reason": "Forbidden",
        "message": "pods is forbidden: User \"jane@example.com\" cannot list resource \"pods\""
    }]));
    let started = std::time::Instant::now();
    let flipped = loop {
        let overview = cluster_overview(&state, None).await.expect("overview");
        if overview.unread.iter().any(|entry| entry.kind == "Pod") {
            break Some(started.elapsed());
        }
        if started.elapsed() > Duration::from_secs(360) {
            break None;
        }
        tokio::time::sleep(Duration::from_secs(10)).await;
    };
    chaos(&serde_json::json!([]));
    println!("pods 403 carried by the overview after: {flipped:?}");
    assert!(flipped.is_some(), "the overview never carried the refusal");
}
