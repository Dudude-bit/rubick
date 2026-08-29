//! Manual proof harness for draining a node against a real cluster.
//! Ignored by default — it needs a kubeconfig and the specimens, so it is not
//! part of the `--lib` gate.
//!
//! ```text
//! K8S_GUI_DRAIN_CONTEXT=kind-rubick-drain K8S_GUI_DRAIN_NODE=rubick-drain-worker \
//!   cargo test --test live_drain -- --ignored --nocapture
//! ```
//!
//! The specimens (`kind` cluster, two nodes, everything pinned to the worker):
//!   * `held` — two replicas behind a `PodDisruptionBudget` with
//!     `minAvailable: 2`, so the budget allows no disruption at all and the
//!     eviction API answers 429 every single time. **This is the case the
//!     security report was about**: the version this replaced answered that
//!     429 with a direct `DELETE` and took the pods anyway.
//!   * `movable` — one replica, no budget. Must actually leave.
//!   * `stubborn` — one replica that tolerates everything, so its replacement
//!     lands back on the node even after the cordon. This is the specimen
//!     that makes the fixed-target-set rule observable: a drain that re-listed
//!     each pass would evict this one, then its replacement, then the next,
//!     for as long as it ran.
//!   * `scratchy` — one replica holding an `emptyDir`. Out of the set unless
//!     asked for.
//!   * `lonely` — a bare pod with no controller. Out of the set unless asked
//!     for.
//!   * kindnet / kube-proxy — DaemonSets, which stay and are not refusals.
//!
//!   * `slowpoke` — ignores SIGTERM, so the kubelet waits out its 25-second
//!     grace period. What makes "accepted" and "gone" far enough apart to
//!     measure.
//!
//! `a_spent_budget_keeps_its_pods` wants the budget in place.
//! `drained_means_the_pods_are_gone` wants it gone — it drains the node
//! completely, which `held-pdb` would forbid forever:
//!
//! ```text
//! kubectl delete pdb held-pdb -n draintest
//! ```
//!
//! Set up:
//!
//! ```text
//! kind create cluster --config test-manifests/drain-kind.yaml
//! kubectl apply -f test-manifests/drain-scene.yaml
//! ```

use std::collections::BTreeMap;
use std::time::Duration;

use k8s_gui_lib::drain::{DrainOptions, DrainOutcome, DrainRefusal};
use k8s_gui_lib::state::{AppEvent, AppState};

fn context() -> String {
    std::env::var("K8S_GUI_DRAIN_CONTEXT").unwrap_or_else(|_| "kind-rubick-drain".to_string())
}

fn node() -> String {
    std::env::var("K8S_GUI_DRAIN_NODE").unwrap_or_else(|_| "rubick-drain-worker".to_string())
}

async fn connected() -> (AppState, kube::Client) {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let state = AppState::new().expect("app state");
    state
        .client_manager
        .load_kubeconfig()
        .await
        .expect("kubeconfig");
    let client = state
        .client_manager
        .connect(&context())
        .await
        .expect("connect");
    let client = (*client).clone();
    (state, client)
}

/// The pods on the node right now, by `namespace/name`.
async fn pods_on_node(client: &kube::Client, node: &str) -> Vec<String> {
    use kube::api::ListParams;
    let api: kube::Api<k8s_openapi::api::core::v1::Pod> = kube::Api::all(client.clone());
    let params = ListParams::default().fields(&format!("spec.nodeName={node}"));
    let mut names: Vec<String> = api
        .list(&params)
        .await
        .expect("list pods")
        .items
        .into_iter()
        .map(|pod| {
            format!(
                "{}/{}",
                pod.metadata.namespace.unwrap_or_default(),
                pod.metadata.name.unwrap_or_default()
            )
        })
        .collect();
    names.sort();
    names
}

/// A node with nothing holding it must be reported drained only once the
/// pods have actually gone.
///
/// An eviction is a *graceful* delete: the API answers as soon as it accepts
/// one, and the pod stays put for its grace period. This drain used to call
/// that "drained" — telling the operator it was safe to power off a node
/// whose pods were all still running, which is the exact accident a drain
/// exists to prevent. `slowpoke` takes 20 seconds to stop, so a premature
/// `Drained` is measurable rather than arguable.
#[tokio::test]
#[ignore = "needs a real cluster with the specimens; run explicitly with --ignored"]
async fn drained_means_the_pods_are_gone() {
    let (state, client) = connected().await;
    let node = node();

    let before: Vec<String> = pods_on_node(&client, &node)
        .await
        .into_iter()
        .filter(|p| p.starts_with("draintest/"))
        .collect();
    assert!(!before.is_empty(), "the specimens have to be there");

    let mut events = state.subscribe();
    let handle = state.drain_manager.start(
        client.clone(),
        node.clone(),
        DrainOptions {
            ignore_daemonsets: true,
            evict_unmanaged_pods: true,
            evict_pods_with_emptydir: true,
        },
    );
    state
        .drain_manager
        .mark_subscribed(&handle.drain_id)
        .expect("the drain is there");

    let started = std::time::Instant::now();
    let (outcome, report) = tokio::time::timeout(Duration::from_secs(180), async {
        loop {
            match events.recv().await.expect("the channel stays open") {
                AppEvent::DrainProgress {
                    drain_id,
                    attempt,
                    report,
                    ..
                } if drain_id == handle.drain_id => {
                    println!(
                        "  attempt {attempt}: moved {}, leaving {}, still here {}",
                        report.evicted,
                        report.leaving,
                        report.refused.len()
                    );
                }
                AppEvent::DrainFinished {
                    drain_id,
                    outcome,
                    report,
                    ..
                } if drain_id == handle.drain_id => return (outcome, report),
                _ => {}
            }
        }
    })
    .await
    .expect("the drain has to finish");
    let took = started.elapsed();

    println!("  ended {outcome:?} after {}s", took.as_secs());
    assert_eq!(outcome, DrainOutcome::Drained);
    assert_eq!(report.leaving, 0, "nothing is still on its way out");

    // The check the finding was about. `slowpoke` stops in 20s, so a drain
    // that reported success on acceptance would be back in about a second.
    assert!(
        took >= Duration::from_secs(15),
        "reported drained after {}s, which is faster than the pods can stop: \
         it is reporting accepted evictions, not departures",
        took.as_secs()
    );

    // Only the pods this drain took on. `stubborn` tolerates the cordon, so
    // its *replacement* lands back here while the drain runs — a pod created
    // after the drain started is not the drain's to move, and calling that a
    // failure would be asking it to fight the controller forever.
    let after = pods_on_node(&client, &node).await;
    let left: Vec<_> = before.iter().filter(|p| after.contains(p)).collect();
    assert!(
        left.is_empty(),
        "the node was called drained while these, which it took on, were \
         still there: {left:?}"
    );
}

/// The control-plane node, whose pods the API server does not own.
///
/// `etcd`, `kube-apiserver` and the rest are static: the kubelet reads them
/// from a file and the API server holds only a mirror. Their owner reference
/// points at the Node, so every membership rule but the mirror check calls
/// them managed and puts them in the set — and since the drain now waits for
/// departures, a mirror the kubelet recreates at once would hang it for good.
///
/// Destructive to the control plane's schedulability; run it on a throwaway
/// cluster and `kubectl uncordon` afterwards.
#[tokio::test]
#[ignore = "needs a real cluster; cordons the control plane"]
async fn a_control_plane_drain_leaves_the_static_pods_alone() {
    let (state, client) = connected().await;
    let node = std::env::var("K8S_GUI_DRAIN_CONTROL_PLANE")
        .unwrap_or_else(|_| "rubick-drain-control-plane".to_string());

    let mut events = state.subscribe();
    let handle = state.drain_manager.start(
        client.clone(),
        node.clone(),
        DrainOptions {
            ignore_daemonsets: true,
            evict_unmanaged_pods: false,
            evict_pods_with_emptydir: false,
        },
    );
    state
        .drain_manager
        .mark_subscribed(&handle.drain_id)
        .expect("the drain is there");

    let (outcome, report) = tokio::time::timeout(Duration::from_secs(120), async {
        loop {
            match events.recv().await.expect("the channel stays open") {
                AppEvent::DrainFinished {
                    drain_id,
                    outcome,
                    report,
                    ..
                } if drain_id == handle.drain_id => return (outcome, report),
                _ => {}
            }
        }
    })
    .await
    .expect("a control-plane drain has to finish, not hang on a mirror");

    println!(
        "  ended {outcome:?}: moved {}, daemonset {}, static {}",
        report.evicted, report.daemonset_pods_left, report.static_pods_left
    );
    assert!(
        report.static_pods_left >= 4,
        "etcd, the apiserver, the scheduler and the controller-manager are all \
         static here; got {}",
        report.static_pods_left
    );
    // Named as staying, never as refused: nothing was asked of them.
    for pod in &report.refused {
        assert!(
            !pod.name.starts_with("etcd-") && !pod.name.starts_with("kube-apiserver-"),
            "{}/{} is static and must not appear as a refusal",
            pod.namespace,
            pod.name
        );
    }

    let still: kube::Api<k8s_openapi::api::core::v1::Pod> =
        kube::Api::namespaced(client.clone(), "kube-system");
    let etcd = still.get(&format!("etcd-{node}")).await;
    assert!(etcd.is_ok(), "etcd must still be there: {etcd:?}");
}

/// The whole thing, once, against a budget that never lets go.
///
/// Runs the drain for long enough to see it ask more than once, then cancels
/// it and checks the cluster itself — not the report — for the pods the budget
/// was protecting.
#[tokio::test]
#[ignore = "needs a real cluster with the specimens; run explicitly with --ignored"]
async fn a_spent_budget_keeps_its_pods() {
    let (state, client) = connected().await;
    let node = node();

    let before = pods_on_node(&client, &node).await;
    println!("\n=== on {node} before ===");
    for name in &before {
        println!("  {name}");
    }
    assert!(
        before.iter().any(|p| p.starts_with("draintest/held-")),
        "the specimens have to be there; got {before:?}"
    );

    let mut events = state.subscribe();
    let handle = state.drain_manager.start(
        client.clone(),
        node.clone(),
        DrainOptions {
            ignore_daemonsets: true,
            evict_unmanaged_pods: false,
            evict_pods_with_emptydir: false,
        },
    );
    state
        .drain_manager
        .mark_subscribed(&handle.drain_id)
        .expect("the drain is there");

    // Long enough for the backoff to have asked at least twice: 2s then 5s.
    let mut attempts = 0u32;
    let mut last = None;
    // (attempt, moved, still here) — the shape of the run, not just its end.
    let mut shape: Vec<(u32, u32, usize)> = Vec::new();
    let watching = tokio::time::timeout(Duration::from_secs(45), async {
        loop {
            match events.recv().await.expect("the channel stays open") {
                AppEvent::DrainProgress {
                    drain_id,
                    attempt,
                    report,
                    ..
                } if drain_id == handle.drain_id => {
                    println!(
                        "  attempt {attempt}: moved {}, gone {}, daemonset {}, still here {}",
                        report.evicted,
                        report.already_gone,
                        report.daemonset_pods_left,
                        report.refused.len()
                    );
                    for pod in &report.refused {
                        println!(
                            "      {}/{} — {:?}{}",
                            pod.namespace,
                            pod.name,
                            pod.refusal,
                            pod.message
                                .as_deref()
                                .map_or_else(String::new, |m| format!(" ({m})"))
                        );
                    }
                    attempts = attempt;
                    shape.push((attempt, report.evicted, report.refused.len()));
                    last = Some(report);
                    if attempt >= 3 {
                        return;
                    }
                }
                _ => {}
            }
        }
    })
    .await;
    assert!(
        watching.is_ok(),
        "the drain has to keep asking; it only reached attempt {attempts}"
    );

    println!("\n=== stopping it ===");
    state.drain_manager.cancel(&handle.drain_id);

    let ended = tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            match events.recv().await.expect("the channel stays open") {
                AppEvent::DrainFinished {
                    drain_id, outcome, ..
                } if drain_id == handle.drain_id => return outcome,
                _ => {}
            }
        }
    })
    .await
    .expect("cancelling has to end it");
    assert_eq!(ended, DrainOutcome::Cancelled);

    // --- what the report said -------------------------------------------
    let report = last.expect("at least one progress event");
    let by_pod: BTreeMap<String, DrainRefusal> = report
        .refused
        .iter()
        .map(|p| (format!("{}/{}", p.namespace, p.name), p.refusal))
        .collect();

    let held: Vec<_> = by_pod
        .iter()
        .filter(|(name, _)| name.starts_with("draintest/held-"))
        .collect();
    assert_eq!(held.len(), 2, "both budgeted pods stay; got {by_pod:?}");
    for (name, refusal) in &held {
        assert_eq!(
            **refusal,
            DrainRefusal::NotNow,
            "{name} is refused for now, not for good"
        );
    }
    assert_eq!(
        by_pod.get("draintest/lonely"),
        Some(&DrainRefusal::NothingWouldReplaceIt),
        "a pod with no controller is out of the set by default"
    );
    assert!(
        by_pod.iter().any(
            |(n, r)| n.starts_with("draintest/scratchy-") && *r == DrainRefusal::HoldsLocalData
        ),
        "a pod holding an emptyDir is out of the set by default; got {by_pod:?}"
    );
    assert!(
        report.daemonset_pods_left >= 1,
        "kindnet and kube-proxy stay, and are not refusals"
    );
    assert!(
        report.evicted >= 1,
        "the pod with no budget has to have left"
    );
    // The regression this test found, and the reason `stubborn` is in the
    // scene. The drain used to re-list the node every pass and work on
    // whatever it saw, so a replacement that tolerates the cordon got evicted
    // too, and the next, for as long as it ran. The set is fixed at the first
    // look, so once that look is done nothing new can enter it: with a budget
    // that never releases — which is this scene — both numbers must be
    // identical on every attempt after the first.
    let (_, moved_first, held_first) = shape[0];
    for (attempt, moved, held) in &shape[1..] {
        assert_eq!(
            (*moved, *held),
            (moved_first, held_first),
            "attempt {attempt} moved {moved} and held {held}, attempt 1 moved \
             {moved_first} and held {held_first}: the set is not fixed, so the \
             drain is chasing its own replacements"
        );
    }

    // And it is closed to scheduling, which the drain does itself rather than
    // trusting whoever started it to have done it.
    let nodes: kube::Api<k8s_openapi::api::core::v1::Node> = kube::Api::all(client.clone());
    let subject = nodes.get(&node).await.expect("the node");
    assert_eq!(
        subject.spec.and_then(|spec| spec.unschedulable),
        Some(true),
        "the drain has to cordon the node itself"
    );

    // --- what the cluster says ------------------------------------------
    // The report could say anything. This is the check the security fix is
    // actually about: ask the API server whether the protected pods are
    // still there.
    let after = pods_on_node(&client, &node).await;
    println!("\n=== on {node} after ===");
    for name in &after {
        println!("  {name}");
    }

    let held_before: Vec<_> = before
        .iter()
        .filter(|p| p.starts_with("draintest/held-"))
        .collect();
    for name in held_before {
        assert!(
            after.contains(name),
            "{name} was protected by a spent budget and must still be on the node"
        );
    }
    assert!(
        after.contains(&"draintest/lonely".to_string()),
        "nothing would replace draintest/lonely, so it must not have been touched"
    );
}
