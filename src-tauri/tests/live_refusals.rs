//! What the app says when the cluster refuses it.
//!
//! Every `*Known` flag, every `Existence::NotChecked` and every
//! `not_looked_at` in this codebase exists for one moment: a read the cluster
//! declined. All of them are unit-tested against a hand-made refusal, and
//! none had ever been tested against a real 403 until this file.
//!
//! Ignored by default. It needs a cluster and an identity narrow enough to be
//! refused, which is two objects and an impersonating context.
//!
//! The role has to allow **pods, services and ingresses**: `Snapshot::of`
//! takes those three with `?`, so an identity refused any of them makes
//! `connections_of` return `Err` and this file panics before reaching a
//! single assertion instead of testing anything. What it must refuse is the
//! claim list — the read this file is about.
//!
//! ```text
//! kubectl create serviceaccount narrow -n k8s-gui-test
//! kubectl create role no-claims -n k8s-gui-test \
//!   --verb=get,list,watch --resource=pods,services,ingresses
//! kubectl create rolebinding narrow-no-claims -n k8s-gui-test \
//!   --role=no-claims --serviceaccount=k8s-gui-test:narrow
//! # then a kubeconfig context whose user carries
//! #   as: system:serviceaccount:k8s-gui-test:narrow
//! K8S_GUI_REFUSED_CONTEXT=narrow cargo test --test live_refusals -- --ignored --nocapture
//! ```

use k8s_gui_lib::commands::helpers::ResourceContext;
use k8s_gui_lib::resources::Existence;
use k8s_gui_lib::state::AppState;

async fn refused_context(namespace: &str) -> ResourceContext {
    let name = std::env::var("K8S_GUI_REFUSED_CONTEXT").unwrap_or_else(|_| "narrow".to_string());
    let _ = rustls::crypto::ring::default_provider().install_default();

    let state = AppState::new().expect("app state");
    state
        .client_manager
        .load_kubeconfig()
        .await
        .expect("kubeconfig");
    let client = state.client_manager.connect(&name).await.expect("connect");
    ResourceContext::from_client((*client).clone(), namespace.to_string())
}

fn namespace() -> String {
    std::env::var("K8S_GUI_INIT_NAMESPACE").unwrap_or_else(|_| "k8s-gui-test".to_string())
}

/// A pod that **mounts a claim**, because the assertion below is about claim
/// edges and a pod without one would let the loop run zero times and pass.
///
/// `shell-demo` in `test-manifests/k8s-gui-all.yaml` is a bare pod — a stable
/// name, unlike a Deployment's generated ones — and it mounts `pvc-demo`.
/// The default used to be `log-demo`, which is a Deployment and no pod at
/// all, so the read returned `not found` and the harness panicked.
fn pod_name() -> String {
    std::env::var("K8S_GUI_REFUSED_POD").unwrap_or_else(|_| "shell-demo".to_string())
}

/// The neighbourhood of a pod read by an identity allowed to see pods and
/// nothing else.
///
/// The pod itself comes back. Everything around it is refused, and the
/// question is whether the answer says so or draws an object standing alone
/// in an empty cluster.
#[tokio::test]
#[ignore = "needs a live cluster and a deliberately narrow identity"]
async fn a_refused_neighbourhood_says_so_instead_of_drawing_an_empty_one() {
    let namespace = namespace();
    let ctx = refused_context(&namespace).await;
    let pod = pod_name();

    let conns = k8s_gui_lib::commands::connections::connections_of(&ctx, "Pod", &pod, None)
        .await
        .expect("the pod itself is readable");

    println!("subject: {:?} {}", conns.subject.kind, conns.subject.name);
    println!("edges: {}", conns.edges.len());
    println!("published: {}", conns.published.len());
    println!("stops: {}", conns.stops.len());
    println!("not_looked_at: {} kinds", conns.not_looked_at.len());
    for unread in &conns.not_looked_at {
        println!("  - {} : {:?}", unread.kind, unread.why);
    }

    let claims: Vec<_> = conns
        .edges
        .iter()
        .filter(|edge| edge.to.kind == "PersistentVolumeClaim")
        .collect();
    println!("claim edges: {}", claims.len());
    for edge in &claims {
        println!("  - {} existence={:?}", edge.to.name, edge.to.existence);
    }

    assert!(
        !conns.not_looked_at.is_empty(),
        "an identity refused several kinds must leave them named; an empty list \
         here is the wire contract for 'every kind was read'"
    );
    assert!(
        conns
            .not_looked_at
            .iter()
            .any(|unread| unread.kind == "PersistentVolumeClaim"),
        "the refused claim list has to be named among them"
    );
    // Before the verdicts: a pod that mounts no claim would leave this loop
    // with nothing to walk, and a harness that asserts nothing passes for the
    // wrong reason. The whole file is about what a claim edge says.
    assert!(
        !claims.is_empty(),
        "{pod} mounts no PersistentVolumeClaim, so nothing here tests what a \
         refused claim list does to a claim edge; point K8S_GUI_REFUSED_POD at \
         a pod that mounts one"
    );
    for edge in &claims {
        assert_eq!(
            edge.to.existence,
            Existence::NotChecked,
            "a claim whose list the cluster refused is not a claim that is missing: \
             {} was drawn as {:?}, which tells a person a mounted, healthy volume \
             does not exist",
            edge.to.name,
            edge.to.existence
        );
    }
}
