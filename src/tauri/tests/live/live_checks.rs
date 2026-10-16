//! A hypothesis tested from a real pod: the ladder in the pod's own
//! container, the fall-through to a copy when the image has nothing, and the
//! promise that the copy is gone afterwards.
//!
//! ```text
//! K8S_GUI_CHECK_CONTEXT=killercoda K8S_GUI_CHECK_POD=busy-demo-xxx \
//! K8S_GUI_BARE_POD=legacy-rc-xxx cargo test --test live live_checks:: -- --ignored --nocapture
//! ```

use k8s_gui_lib::commands::checks::{check_pod, Check, CheckAnswer, CopyWith};
use k8s_gui_lib::state::AppState;
use k8s_openapi::api::core::v1::Pod;
use kube::api::Api;

async fn client() -> (kube::Client, String) {
    let name = std::env::var("K8S_GUI_CHECK_CONTEXT").unwrap_or_else(|_| "killercoda".to_string());
    k8s_gui_lib::tls::provider();
    let state = AppState::new().expect("app state");
    state
        .client_manager
        .load_kubeconfig()
        .await
        .expect("kubeconfig");
    let client = state.client_manager.connect(&name).await.expect("connect");
    let namespace =
        std::env::var("K8S_GUI_INIT_NAMESPACE").unwrap_or_else(|_| "k8s-gui-test".to_string());
    ((*client).clone(), namespace)
}

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} names the pod to ask"))
}

/// A pod whose image has a resolver and nc answers from its own container.
#[tokio::test]
#[ignore = "needs a live cluster and the test manifests"]
async fn a_pod_with_tools_answers_from_its_own_container() {
    let (client, ns) = client().await;
    let pod = env("K8S_GUI_CHECK_POD");
    let container = std::env::var("K8S_GUI_CHECK_CONTAINER").unwrap_or_else(|_| "main".into());

    let dns = check_pod(
        client.clone(),
        &ns,
        &pod,
        &container,
        Check::Dns {
            name: "kubernetes.default.svc.cluster.local".into(),
        },
        None,
    )
    .await
    .expect("dns check runs");
    println!("dns: {dns:?}");
    assert_eq!(dns.ran_in, "container");
    assert!(
        dns.answer != CheckAnswer::NoTool,
        "the image has a resolver: tried {:?}",
        dns.tried
    );
    assert_eq!(
        dns.answer,
        CheckAnswer::Yes,
        "kubernetes.default resolves in every cluster"
    );

    let tcp = check_pod(
        client,
        &ns,
        &pod,
        &container,
        Check::Tcp {
            host: "kubernetes.default.svc.cluster.local".into(),
            port: 443,
        },
        None,
    )
    .await
    .expect("tcp check runs");
    println!("tcp: {tcp:?}");
    assert!(
        tcp.answer != CheckAnswer::NoTool,
        "the image has nc or curl: tried {:?}",
        tcp.tried
    );
    assert_eq!(
        tcp.answer,
        CheckAnswer::Yes,
        "the apiserver accepts a connection from every pod"
    );
}

/// A pause image has nothing on the ladder. The answer says so, the same
/// question from a copy answers, and the copy is gone when it has.
#[tokio::test]
#[ignore = "needs a live cluster and the test manifests"]
async fn a_bare_image_is_said_so_and_a_copy_answers_and_leaves() {
    let (client, ns) = client().await;
    let pod = env("K8S_GUI_BARE_POD");
    let container = std::env::var("K8S_GUI_BARE_CONTAINER").unwrap_or_else(|_| "pause".into());
    let ask = || Check::Dns {
        name: "kubernetes.default.svc.cluster.local".into(),
    };

    let bare = check_pod(client.clone(), &ns, &pod, &container, ask(), None)
        .await
        .expect("the exec itself runs");
    println!("bare: {bare:?}");
    assert_eq!(
        bare.answer,
        CheckAnswer::NoTool,
        "pause has no resolver: {:?}",
        bare.tried
    );
    assert_eq!(bare.answered_with, None);

    let copied = check_pod(
        client.clone(),
        &ns,
        &pod,
        &container,
        ask(),
        Some(CopyWith {
            image: "busybox:1.36".into(),
        }),
    )
    .await
    .expect("the copy runs");
    println!("copy: {copied:?}");
    assert_eq!(copied.ran_in, "copy");
    assert_eq!(copied.answer, CheckAnswer::Yes, "busybox resolves it");
    let report = copied.copy.expect("a copy is reported");
    assert!(report.deleted, "deleted, not merely asked");

    // This copy by name, Terminating included: one still being removed is
    // still there, and a label count skipping those passed with it running.
    let api: Api<Pod> = Api::namespaced(client, &ns);
    let started = std::time::Instant::now();
    let mut left = api.get_opt(&report.pod).await.expect("get");
    while left.is_some() && started.elapsed() < std::time::Duration::from_secs(30) {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        left = api.get_opt(&report.pod).await.expect("get");
    }
    assert!(left.is_none(), "the copy {} is left behind", report.pod);
}
