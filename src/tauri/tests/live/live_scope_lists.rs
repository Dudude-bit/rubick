//! Lists and watches over several namespaces on a real cluster: one answer
//! from one LIST per namespace, one stream whose first `synced` waits for
//! every namespace, and a refused namespace carried by name.
//!
//! ```text
//! K8S_GUI_INIT_CONTEXT=kind-rubick-gui \
//!   cargo test --test live live_scope_lists:: -- --ignored --nocapture --test-threads=1
//! ```
//!
//! The refusal test needs an identity that may read ConfigMaps in
//! `k8s-gui-test` and nowhere else, as a context in `$KUBECONFIG`:
//!
//! ```text
//! kubectl create serviceaccount scope-narrow -n k8s-gui-test
//! kubectl create role configmaps-only -n k8s-gui-test \
//!   --verb=get,list,watch --resource=configmaps
//! kubectl create rolebinding scope-narrow -n k8s-gui-test \
//!   --role=configmaps-only --serviceaccount=k8s-gui-test:scope-narrow
//! K8S_GUI_NARROW_CONTEXT=<that context> cargo test --test live \
//!   live_scope_lists::a_refused -- --ignored --nocapture
//! ```

use std::time::Duration;

use k8s_gui_lib::commands::helpers::{across, infos_in};
use k8s_gui_lib::commands::pods::page_scope;
use k8s_gui_lib::resources::ConfigMapInfo;
use k8s_gui_lib::state::{AppEvent, WatchOp};
use k8s_gui_lib::watch::WatchManager;
use k8s_openapi::api::core::v1::ConfigMap;
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::{Api, Client, Config};
use tokio::sync::broadcast;

const SCOPE: [&str; 3] = ["default", "k8s-gui-test", "kube-system"];

async fn client_for(context: String) -> Client {
    k8s_gui_lib::tls::provider();
    let config = Config::from_custom_kubeconfig(
        Kubeconfig::read().expect("kubeconfig"),
        &KubeConfigOptions {
            context: Some(context),
            ..Default::default()
        },
    )
    .await
    .expect("kubeconfig context");
    Client::try_from(config).expect("client")
}

async fn client() -> Client {
    client_for(std::env::var("K8S_GUI_INIT_CONTEXT").unwrap_or_else(|_| "kind-rubick-gui".into()))
        .await
}

fn scope() -> Vec<String> {
    SCOPE.iter().map(ToString::to_string).collect()
}

/// Every event of one stream until `until` says stop, or the time runs out.
async fn read_stream(
    events: &mut broadcast::Receiver<AppEvent>,
    stream_id: &str,
    seconds: u64,
    mut until: impl FnMut(&[(WatchOp, Option<String>)]) -> bool,
) -> Vec<(WatchOp, Option<String>)> {
    let mut seen = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(seconds), async {
        while let Ok(event) = events.recv().await {
            let AppEvent::ResourceWatchEvent {
                stream_id: id,
                changes,
                error,
            } = event
            else {
                continue;
            };
            if id != stream_id {
                continue;
            }
            for change in changes {
                let said = change
                    .resource
                    .map(|raw| raw.get().to_string())
                    .or_else(|| error.clone());
                seen.push((change.op, said));
            }
            if until(&seen) {
                return;
            }
        }
    })
    .await;
    seen
}

/// The answer for three namespaces is their three answers, and nothing
/// comes back unread on an identity that may read them all.
#[tokio::test]
#[ignore = "needs a live cluster"]
async fn several_namespaces_answer_as_their_parts_do() {
    let client = client().await;
    let whole = across(Some(scope()), |reach| {
        infos_in::<ConfigMap, ConfigMapInfo>(client.clone(), reach)
    })
    .await
    .expect("three namespaces");
    let mut parts = 0;
    for namespace in SCOPE {
        let api: Api<ConfigMap> = Api::namespaced(client.clone(), namespace);
        parts += api
            .list(&Default::default())
            .await
            .expect("list")
            .items
            .len();
    }
    println!("configmaps {} across {SCOPE:?}", whole.rows.len());
    assert!(whole.unread.is_empty(), "unread: {:?}", whole.unread);
    assert_eq!(whole.rows.len(), parts);

    let cancel = tokio_util::sync::CancellationToken::new();
    let paged = page_scope(&client, Some(&scope()), |_| {}, &cancel)
        .await
        .expect("pods of three namespaces");
    println!("pods {} across {SCOPE:?}", paged.rows);
    assert!(paged.complete && paged.unread.is_empty());
}

/// One stream over two namespaces: its first `synced` comes after both
/// namespaces' rows, and a ConfigMap made in one of them afterwards arrives
/// on it as a plain change, with no second resync around it.
#[tokio::test]
#[ignore = "needs a live cluster; creates and deletes a ConfigMap in k8s-gui-test"]
async fn a_change_in_one_namespace_reaches_the_scope_stream() {
    let client = client().await;
    let (event_tx, mut events) = broadcast::channel(4096);
    let manager = WatchManager::new(event_tx);
    let stream_id = manager
        .subscribe::<ConfigMap, _, _>(
            client.clone(),
            "ConfigMap",
            Some(vec!["k8s-gui-test".into(), "default".into()]),
            |map| Some(ConfigMapInfo::from(map)),
        )
        .expect("a scope stream");
    manager.mark_subscribed(&stream_id).expect("gate");

    let first = read_stream(&mut events, &stream_id, 30, |seen| {
        seen.iter().any(|(op, _)| *op == WatchOp::Synced)
    })
    .await;
    let ops: Vec<WatchOp> = first.iter().map(|(op, _)| *op).collect();
    println!("first sync: {} changes", ops.len());
    assert_eq!(ops.first(), Some(&WatchOp::Restarted));
    assert_eq!(ops.last(), Some(&WatchOp::Synced));
    for namespace in ["default", "k8s-gui-test"] {
        let root = format!("\"namespace\":\"{namespace}\"");
        assert!(
            first.iter().any(|(_, row)| row
                .as_deref()
                .is_some_and(|r| r.contains(&root) && r.contains("kube-root-ca.crt"))),
            "{namespace}'s kube-root-ca.crt was not in the first sync"
        );
    }

    let api: Api<ConfigMap> = Api::namespaced(client, "k8s-gui-test");
    let name = "rubick-scope-probe";
    let _ = api.delete(name, &Default::default()).await;
    let probe: ConfigMap = serde_json::from_value(serde_json::json!({
        "metadata": { "name": name, "namespace": "k8s-gui-test" },
        "data": { "k": "v" },
    }))
    .expect("configmap literal");
    api.create(&Default::default(), &probe)
        .await
        .expect("create the probe");
    let arrived = read_stream(&mut events, &stream_id, 30, |seen| {
        seen.iter()
            .any(|(_, row)| row.as_deref().is_some_and(|r| r.contains(name)))
    })
    .await;
    api.delete(name, &Default::default())
        .await
        .expect("delete the probe");
    let gone = read_stream(&mut events, &stream_id, 30, |seen| {
        seen.iter().any(|(op, _)| *op == WatchOp::Deleted)
    })
    .await;
    manager.unsubscribe(&stream_id);

    println!("after create: {arrived:?}");
    assert!(arrived.iter().any(
        |(op, row)| *op == WatchOp::Applied && row.as_deref().is_some_and(|r| r.contains(name))
    ));
    assert!(
        !arrived
            .iter()
            .chain(&gone)
            .any(|(op, _)| matches!(op, WatchOp::Restarted | WatchOp::Synced)),
        "a change in one namespace resynced the scope"
    );
    assert!(gone.iter().any(
        |(op, row)| *op == WatchOp::Deleted && row.as_deref().is_some_and(|r| r.contains(name))
    ));
}

/// An identity that may read `k8s-gui-test` and not `default`: the list
/// answers with the one and names the other, and the stream fails by name
/// instead of ever saying `synced` over a namespace it could not read.
#[tokio::test]
#[ignore = "needs a live cluster and a context narrowed to k8s-gui-test"]
async fn a_refused_namespace_is_named_by_the_list_and_fails_the_stream() {
    let context = std::env::var("K8S_GUI_NARROW_CONTEXT").expect("K8S_GUI_NARROW_CONTEXT");
    let client = client_for(context).await;
    let asked = vec!["default".to_string(), "k8s-gui-test".to_string()];

    let answer = across(Some(asked.clone()), |reach| {
        infos_in::<ConfigMap, ConfigMapInfo>(client.clone(), reach)
    })
    .await
    .expect("k8s-gui-test answered");
    println!("rows {} unread {:?}", answer.rows.len(), answer.unread);
    assert!(answer
        .rows
        .iter()
        .all(|row| row.namespace == "k8s-gui-test"));
    assert!(!answer.rows.is_empty());
    assert_eq!(answer.unread.len(), 1);
    assert_eq!(answer.unread[0].namespace, "default");
    assert_eq!(answer.unread[0].code, "PERMISSION_DENIED");

    let (event_tx, mut events) = broadcast::channel(4096);
    let manager = WatchManager::new(event_tx);
    let stream_id = manager
        .subscribe::<ConfigMap, _, _>(client, "ConfigMap", Some(asked), |map| {
            Some(ConfigMapInfo::from(map))
        })
        .expect("a scope stream");
    manager.mark_subscribed(&stream_id).expect("gate");
    let seen = read_stream(&mut events, &stream_id, 60, |seen| {
        seen.iter().any(|(op, _)| *op == WatchOp::Failed)
    })
    .await;
    manager.unsubscribe(&stream_id);

    let failure = seen.iter().find(|(op, _)| *op == WatchOp::Failed);
    println!("failure: {failure:?}");
    assert!(failure
        .is_some_and(|(_, said)| said.as_deref().is_some_and(|s| s.starts_with("default: "))));
    assert!(!seen.iter().any(|(op, _)| *op == WatchOp::Synced));
}
