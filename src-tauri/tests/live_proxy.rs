//! `kubectl proxy` as the second way in, against a real cluster.
//!
//! Needs kubectl on PATH and a reachable current context (a `kind` or `k3d`
//! cluster is enough). Run with `cargo test --test live_proxy -- --ignored`.

use k8s_gui_lib::client::{ConnectionPath, K8sClientManager, KubectlProxy};

fn current_context() -> Option<String> {
    let out = std::process::Command::new("kubectl")
        .args(["config", "current-context"])
        .output()
        .ok()?;
    let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !name.is_empty()).then_some(name)
}

/// The proxy comes up, a client built on it lists namespaces and watches,
/// and the session says which way it went.
#[tokio::test]
#[ignore = "needs kubectl and a live cluster"]
async fn a_client_through_kubectl_proxy_reads_and_watches() {
    let context = current_context().expect("a current context");
    // Resolved by the OS on PATH, the way the app resolves it on the user's.
    let proxy = KubectlProxy::start("kubectl", &context, &[])
        .await
        .unwrap_or_else(|f| panic!("proxy did not start: {} / {}", f.error, f.stderr));
    let port = proxy.port;

    let manager = K8sClientManager::new();
    let client = manager
        .connect_through_proxy(&context, proxy)
        .expect("client through proxy");
    assert_eq!(
        manager.path_of(&context),
        Some(ConnectionPath::KubectlProxy)
    );

    let namespaces: kube::Api<k8s_openapi::api::core::v1::Namespace> =
        kube::Api::all((*client).clone());
    let list = namespaces
        .list(&Default::default())
        .await
        .expect("list through proxy");
    assert!(
        list.items
            .iter()
            .any(|ns| ns.metadata.name.as_deref() == Some("kube-system")),
        "kube-system is on every cluster"
    );

    // One watch event proves the streaming path survives the proxy.
    use futures::StreamExt;
    let mut stream = kube::runtime::watcher(namespaces, Default::default()).boxed();
    let first = tokio::time::timeout(std::time::Duration::from_secs(20), stream.next())
        .await
        .expect("a watch event within 20s")
        .expect("stream open")
        .expect("watch through proxy");
    assert!(matches!(
        first,
        kube::runtime::watcher::Event::Init | kube::runtime::watcher::Event::InitApply(_)
    ));

    // Disconnecting kills the proxy: the port stops answering.
    manager.disconnect(&context);
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let gone = reqwest::get(format!("http://127.0.0.1:{port}/version")).await;
    assert!(gone.is_err(), "proxy still answering after disconnect");
}
