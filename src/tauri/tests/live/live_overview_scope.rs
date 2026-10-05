//! One overview for several namespaces on a real cluster, against the same
//! namespaces asked one at a time: every namespaced count is their sum, the
//! cluster's facts are the cluster's once, and every namespace's problems and
//! warnings are on it.
//!
//!     K8S_GUI_INIT_CONTEXT=kind-rubick-gui \
//!       cargo test --test live live_overview_scope:: -- --ignored --nocapture

use k8s_gui_lib::commands::overview::{cluster_overview, ClusterOverview, ResourceCounts};
use k8s_gui_lib::AppState;
use std::collections::{BTreeMap, BTreeSet};

const SCOPE: [&str; 3] = ["default", "k8s-gui-test", "kube-system"];

fn context() -> String {
    std::env::var("K8S_GUI_INIT_CONTEXT").unwrap_or_else(|_| "kind-rubick-check".into())
}

async fn connected() -> AppState {
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

fn namespaced(counts: &ResourceCounts) -> [Option<usize>; 10] {
    [
        counts.pods,
        counts.deployments,
        counts.stateful_sets,
        counts.daemon_sets,
        counts.jobs,
        counts.cron_jobs,
        counts.services,
        counts.ingresses,
        counts.config_maps,
        counts.secrets,
    ]
}

fn problems(overview: &ClusterOverview) -> BTreeSet<String> {
    overview
        .problems
        .iter()
        .map(|p| format!("{}/{:?}/{}/{}", p.kind, p.namespace, p.name, p.reason))
        .collect()
}

fn warnings(overviews: &[&ClusterOverview]) -> BTreeMap<String, i32> {
    let mut by_reason = BTreeMap::new();
    for group in overviews.iter().flat_map(|o| &o.warnings) {
        *by_reason.entry(group.reason.clone()).or_default() += group.count;
    }
    by_reason
}

/// What differs between the joined answer and its parts, or nothing.
fn differences(whole: &ClusterOverview, parts: &[ClusterOverview]) -> Vec<String> {
    let mut wrong = Vec::new();
    let sums: Vec<Option<usize>> = (0..10)
        .map(|i| parts.iter().map(|p| namespaced(&p.counts)[i]).sum())
        .collect();
    if namespaced(&whole.counts).to_vec() != sums {
        wrong.push(format!(
            "counts {:?} != sums {sums:?}",
            namespaced(&whole.counts)
        ));
    }
    for part in parts {
        if part.counts.nodes != whole.counts.nodes
            || part.counts.namespaces != whole.counts.namespaces
            || part.nodes.len() != whole.nodes.len()
            || part.served_from != whole.served_from
            || part.metrics_available != whole.metrics_available
        {
            wrong.push("a cluster fact differs from a part's".to_string());
        }
    }
    let running: usize = parts.iter().map(|p| p.pods.running).sum();
    let failed: usize = parts.iter().map(|p| p.pods.failed).sum();
    if (whole.pods.running, whole.pods.failed) != (running, failed) {
        wrong.push("pod composition is not the parts' sum".to_string());
    }
    let jobs: Option<usize> = parts
        .iter()
        .map(|p| p.jobs.as_ref().map(|j| j.completed + j.active + j.failed))
        .sum();
    if whole
        .jobs
        .as_ref()
        .map(|j| j.completed + j.active + j.failed)
        != jobs
    {
        wrong.push("jobs are not the parts' sum".to_string());
    }
    if parts.iter().all(|p| p.problems_truncated == 0) && whole.problems_truncated == 0 {
        let union: BTreeSet<String> = parts.iter().flat_map(problems).collect();
        if problems(whole) != union || whole.problems.len() != union.len() {
            wrong.push(format!("problems {:?} != union {union:?}", problems(whole)));
        }
    }
    let parts_refs: Vec<&ClusterOverview> = parts.iter().collect();
    if warnings(&[whole]) != warnings(&parts_refs) {
        wrong.push("warning counts differ".to_string());
    }
    if !whole.namespaces.is_empty() {
        wrong.push("a scope carried a namespace breakdown".to_string());
    }
    wrong
}

#[tokio::test]
#[ignore = "needs a cluster"]
async fn a_scope_is_the_sum_of_its_namespaces_asked_one_at_a_time() {
    let state = connected().await;
    let scope: Vec<String> = SCOPE.iter().map(ToString::to_string).collect();

    // Events and pods move under a live cluster; a round that races a change
    // is asked again rather than failed.
    let mut last = Vec::new();
    for round in 1..=5 {
        let whole = cluster_overview(&state, Some(scope.clone()))
            .await
            .expect("the scope's overview");
        let mut parts = Vec::new();
        for namespace in &scope {
            parts.push(
                cluster_overview(&state, Some(vec![namespace.clone()]))
                    .await
                    .expect("a namespace's overview"),
            );
        }
        last = differences(&whole, &parts);
        if last.is_empty() {
            println!(
                "round {round}: {:?}, pods {:?}, problems {}, warnings {}, served from {:?}",
                scope,
                whole.counts.pods,
                whole.problems.len(),
                whole.warnings.len(),
                whole.served_from
            );
            state.overview_cache.forget(&context());
            return;
        }
        println!("round {round} differed: {last:?}");
    }
    state.overview_cache.forget(&context());
    panic!("the scope never matched its parts: {last:?}");
}
