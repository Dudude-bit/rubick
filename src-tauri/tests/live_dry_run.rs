//! A server-side dry run against a real cluster: an edit is "would change"
//! with the server's own object on both sides, a fresh name is "would be
//! created", and an identity refused the read is told so rather than told
//! it is about to create something.
//!
//! ```text
//! K8S_GUI_DRY_CONTEXT=killercoda K8S_GUI_REFUSED_CONTEXT=narrow \
//!   cargo test --test live_dry_run -- --ignored --nocapture
//! ```

use k8s_gui_lib::commands::manifest::{dry_run_of, DryRunOutcome};
use k8s_gui_lib::state::AppState;

async fn client(var: &str, default: &str) -> kube::Client {
    let name = std::env::var(var).unwrap_or_else(|_| default.to_string());
    let _ = rustls::crypto::ring::default_provider().install_default();
    let state = AppState::new().expect("app state");
    state
        .client_manager
        .load_kubeconfig()
        .await
        .expect("kubeconfig");
    let client = state.client_manager.connect(&name).await.expect("connect");
    (*client).clone()
}

fn namespace() -> String {
    std::env::var("K8S_GUI_INIT_NAMESPACE").unwrap_or_else(|_| "k8s-gui-test".to_string())
}

fn deployment(name: &str, replicas: u32) -> String {
    format!(
        "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: {name}\nspec:\n  replicas: {replicas}\n  selector:\n    matchLabels:\n      app: {name}\n  template:\n    metadata:\n      labels:\n        app: {name}\n    spec:\n      containers:\n      - name: web\n        image: nginx:1.27-alpine\n"
    )
}

/// The edit is made to the object as the cluster holds it, not to a manifest
/// written by hand: a hand-written selector that differs from the live one
/// is refused as immutable, which is the dry run doing its job and not the
/// case under test here.
async fn live_edit(client: kube::Client, ns: &str, name: &str, replicas: u32) -> String {
    let api: kube::Api<k8s_openapi::api::apps::v1::Deployment> = kube::Api::namespaced(client, ns);
    let live = api.get(name).await.expect("the deployment exists");
    let yaml = serde_yaml::to_string(&live).expect("yaml");
    let cleaned = k8s_gui_lib::commands::helpers::clean_yaml_for_editor(&yaml).expect("cleaned");
    let edited = regex_replace_replicas(&cleaned, replicas);
    assert_ne!(edited, cleaned, "the edit changed the replica count");
    edited
}

fn regex_replace_replicas(yaml: &str, replicas: u32) -> String {
    let mut out = String::new();
    for line in yaml.lines() {
        if line.trim_start().starts_with("replicas:") {
            let indent = &line[..line.len() - line.trim_start().len()];
            out.push_str(&format!("{indent}replicas: {replicas}\n"));
        } else {
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

#[tokio::test]
#[ignore = "needs a live cluster and the test manifests"]
async fn an_edit_is_a_change_with_the_servers_object_on_both_sides() {
    let client = client("K8S_GUI_DRY_CONTEXT", "killercoda").await;
    let ns = namespace();
    let pod_name = std::env::var("K8S_GUI_DRY_DEPLOYMENT").unwrap_or_else(|_| "expr-demo".into());

    let edited = live_edit(client.clone(), &ns, &pod_name, 7).await;
    let run = dry_run_of(client, &edited, Some(&ns))
        .await
        .expect("the dry run runs");
    let doc = &run.documents[0];
    println!("outcome: {:?}", doc.outcome);
    assert_eq!(doc.outcome, DryRunOutcome::Configured);
    let live = doc.live.as_deref().expect("the object exists");
    let would = doc
        .would
        .as_deref()
        .expect("the server answered with an object");
    assert!(
        would.contains("replicas: 7"),
        "the server's object carries the edit"
    );
    assert!(!live.contains("replicas: 7"), "and the live one does not");
    assert!(!would.contains("managedFields"), "bookkeeping stripped");
    assert!(!would.contains("status:"), "status stripped");
}

#[tokio::test]
#[ignore = "needs a live cluster"]
async fn a_fresh_name_would_be_created_and_nothing_is_stored() {
    let client = client("K8S_GUI_DRY_CONTEXT", "killercoda").await;
    let ns = namespace();
    let name = format!("dry-run-probe-{}", std::process::id());

    let run = dry_run_of(client.clone(), &deployment(&name, 1), Some(&ns))
        .await
        .expect("the dry run runs");
    assert_eq!(run.documents[0].outcome, DryRunOutcome::Created);
    assert!(run.documents[0].live.is_none());

    let api: kube::Api<k8s_openapi::api::apps::v1::Deployment> = kube::Api::namespaced(client, &ns);
    assert!(
        api.get_opt(&name).await.expect("list").is_none(),
        "a dry run stores nothing"
    );
}

/// The thesis, on this feature: no current object and "could not read the
/// current object" both arrive empty, and only one means "would be created".
#[tokio::test]
#[ignore = "needs a live cluster and the narrow identity"]
async fn a_refused_read_is_not_a_creation() {
    let client = client("K8S_GUI_REFUSED_CONTEXT", "narrow").await;
    let ns = namespace();
    let pod_name = std::env::var("K8S_GUI_DRY_DEPLOYMENT").unwrap_or_else(|_| "expr-demo".into());

    let run = dry_run_of(client, &deployment(&pod_name, 7), Some(&ns))
        .await
        .expect("the dry run runs");
    println!("narrow outcome: {:?}", run.documents[0].outcome);
    assert!(
        matches!(
            run.documents[0].outcome,
            DryRunOutcome::LiveUnread { .. } | DryRunOutcome::Refused { .. }
        ),
        "a token refused the read is never told it would create: {:?}",
        run.documents[0].outcome
    );
    assert_ne!(run.documents[0].outcome, DryRunOutcome::Created);
}
