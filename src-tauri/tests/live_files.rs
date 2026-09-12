//! The files ladder against real images.
//!
//! Needs a reachable current context with the usual k3s system pods:
//! traefik (busybox, so the `sh` + `stat` rung) and coredns (distroless,
//! so no rung at all). Run with `cargo test --test live_files -- --ignored`.

use k8s_gui_lib::files::{list_dir, read_preview, Listing, Target};
use kube::api::{Api, ListParams};
use kube::Client;

async fn pod_named(client: &Client, namespace: &str, prefix: &str) -> Option<(String, String)> {
    let api: Api<k8s_openapi::api::core::v1::Pod> = Api::namespaced(client.clone(), namespace);
    let pods = api.list(&ListParams::default()).await.ok()?;
    pods.items.into_iter().find_map(|pod| {
        let name = pod.metadata.name.clone()?;
        let running = pod.status.as_ref().and_then(|s| s.phase.as_deref()) == Some("Running");
        if !name.starts_with(prefix) || !running {
            return None;
        }
        let container = pod.spec.as_ref()?.containers.first()?.name.clone();
        Some((name, container))
    })
}

/// busybox: no GNU find, so the second rung answers, with rows.
#[tokio::test]
#[ignore = "needs a live k3s cluster"]
async fn a_busybox_image_lists_through_the_stat_rung() {
    let client = Client::try_default().await.expect("client");
    let (pod, container) = pod_named(&client, "kube-system", "traefik-")
        .await
        .expect("a running traefik pod");
    let (_cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
    let mut rows = Vec::new();
    let listing = list_dir(
        client.clone(),
        Target {
            namespace: "kube-system",
            pod: &pod,
            container: &container,
            via: None,
            path: "/etc",
        },
        |batch| rows.extend(batch),
        &mut cancel_rx,
    )
    .await
    .expect("listing runs");
    match listing {
        Listing::Listed {
            with,
            entries,
            partial,
            unreadable,
        } => {
            println!("traefik /etc: {entries} entries via {with:?}");
            assert!(entries > 0);
            assert!(!partial, "/etc fitted under the cap");
            assert_eq!(unreadable, 0, "every line of /etc parsed");
            assert!(
                rows.iter().any(|r| r.name == "hosts" || r.name == "passwd"),
                "{rows:?}"
            );
        }
        Listing::NoTools { tried } => panic!("no tools in traefik? tried {tried:?}"),
        Listing::Unopenable => panic!("traefik cannot open its own /etc?"),
        Listing::Failed { exit, stderr } => panic!("failed: {exit:?} {stderr}"),
    }

    let preview = read_preview(
        client,
        "kube-system",
        &pod,
        &container,
        None,
        "/etc/hostname",
    )
    .await
    .expect("read runs")
    .expect("head exists in busybox");
    assert!(!preview.binary);
    assert!(preview.text.is_some());
}

/// distroless: neither rung, and that is the answer, never an empty folder.
#[tokio::test]
#[ignore = "needs a live k3s cluster"]
async fn a_distroless_image_says_it_has_nothing_to_list_with() {
    let client = Client::try_default().await.expect("client");
    let (pod, container) = pod_named(&client, "kube-system", "coredns-")
        .await
        .expect("a running coredns pod");
    let (_cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
    let mut rows = Vec::new();
    let listing = list_dir(
        client,
        Target {
            namespace: "kube-system",
            pod: &pod,
            container: &container,
            via: None,
            path: "/etc",
        },
        |batch| rows.extend(batch),
        &mut cancel_rx,
    )
    .await
    .expect("listing runs");
    assert!(rows.is_empty());
    match listing {
        Listing::NoTools { tried } => {
            println!("coredns: no tools, tried {tried:?}");
            assert_eq!(tried, vec!["find".to_string(), "sh".to_string()]);
        }
        Listing::Listed { with, entries, .. } => {
            panic!("coredns listed {entries} entries via {with:?}; the image grew tools?")
        }
        Listing::Unopenable => panic!("unopenable rather than noTools"),
        Listing::Failed { exit, stderr } => {
            panic!("failed rather than noTools: {exit:?} {stderr}")
        }
    }
}

/// The capture path alone, to tell a hang in the loop from a hang in the socket.
#[tokio::test]
#[ignore = "needs a live k3s cluster"]
async fn busybox_find_rejects_printf_without_hanging() {
    let client = Client::try_default().await.expect("client");
    let (pod, container) = pod_named(&client, "kube-system", "traefik-")
        .await
        .expect("a running traefik pod");
    let command: Vec<String> = k8s_gui_lib::files::gnu_find_command("/etc");
    let captured = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        k8s_gui_lib::files::exec_capture(client, "kube-system", &pod, &container, &command),
    )
    .await
    .expect("answers within 20s")
    .expect("exec runs");
    println!(
        "exit {:?} missing={} stdout={}B stderr={}B: {}",
        captured.exit.code,
        captured.exit.missing_binary,
        captured.stdout.len(),
        captured.stderr.len(),
        captured.stderr.lines().next().unwrap_or("")
    );
}
