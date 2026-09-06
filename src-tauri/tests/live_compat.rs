//! Compatibility smoke test: every core kind this app reads must deserialise
//! against whatever cluster the current context points at. Ignored by
//! default — it needs a real kubeconfig, so it is not part of the `--lib`
//! gate.
//!
//! Its reason to exist is the k8s-openapi feature version. The crate models
//! the API as of one Kubernetes release; a field that became *required* in a
//! newer one and is absent on an older cluster would fail to deserialise and
//! take a whole screen down. Kubernetes' own compatibility rules forbid that
//! for GA types, but the way to know is to point this at an old cluster and
//! watch every list come back.
//!
//! ```text
//! kubectl config use-context kind-rubick-old   # e.g. a v1.28 kind cluster
//! cargo test --test live_compat -- --ignored --nocapture
//! ```

use kube::{api::ListParams, Api, Client};

/// List one kind and record a deserialisation failure rather than panicking,
/// so a single incompatible kind does not hide the state of all the others.
macro_rules! list {
    ($client:expr, $ty:ty, $label:expr, $failures:expr) => {{
        let api: Api<$ty> = Api::all($client.clone());
        match api.list(&ListParams::default().limit(200)).await {
            Ok(objects) => println!("  ok  {:<24} {} objects", $label, objects.items.len()),
            Err(err) => {
                println!("  ERR {:<24} {err}", $label);
                $failures.push(format!("{}: {err}", $label));
            }
        }
    }};
}

#[tokio::test]
#[ignore = "needs a real kubeconfig; run against an old cluster to prove compat"]
async fn every_core_kind_deserialises_against_this_cluster() {
    use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, ReplicaSet, StatefulSet};
    use k8s_openapi::api::autoscaling::v2::HorizontalPodAutoscaler;
    use k8s_openapi::api::batch::v1::{CronJob, Job};
    use k8s_openapi::api::coordination::v1::Lease;
    use k8s_openapi::api::core::v1::{
        ConfigMap, Endpoints, Event, Namespace, Node, PersistentVolume, PersistentVolumeClaim, Pod,
        ReplicationController, Secret, Service, ServiceAccount,
    };
    use k8s_openapi::api::discovery::v1::EndpointSlice;
    use k8s_openapi::api::networking::v1::{Ingress, IngressClass, NetworkPolicy};
    use k8s_openapi::api::policy::v1::PodDisruptionBudget;
    use k8s_openapi::api::rbac::v1::{ClusterRole, ClusterRoleBinding, Role, RoleBinding};
    use k8s_openapi::api::storage::v1::{CSIDriver, StorageClass};

    let client = Client::try_default()
        .await
        .expect("a kubeconfig on the current context");
    let version = client
        .apiserver_version()
        .await
        .expect("the server should answer its version");
    println!(
        "server v{}.{} — listing every kind the app reads",
        version.major, version.minor
    );

    let mut failures = Vec::new();

    // core/v1
    list!(client, Pod, "pods", failures);
    list!(client, Service, "services", failures);
    list!(client, Node, "nodes", failures);
    list!(client, Namespace, "namespaces", failures);
    list!(client, ConfigMap, "configmaps", failures);
    list!(client, Secret, "secrets", failures);
    list!(client, PersistentVolume, "persistentvolumes", failures);
    list!(
        client,
        PersistentVolumeClaim,
        "persistentvolumeclaims",
        failures
    );
    list!(client, ServiceAccount, "serviceaccounts", failures);
    list!(client, Endpoints, "endpoints", failures);
    list!(client, Event, "events", failures);
    list!(
        client,
        ReplicationController,
        "replicationcontrollers",
        failures
    );

    // apps/v1
    list!(client, Deployment, "deployments", failures);
    list!(client, StatefulSet, "statefulsets", failures);
    list!(client, DaemonSet, "daemonsets", failures);
    list!(client, ReplicaSet, "replicasets", failures);

    // batch/v1
    list!(client, Job, "jobs", failures);
    list!(client, CronJob, "cronjobs", failures);

    // networking/v1
    list!(client, Ingress, "ingresses", failures);
    list!(client, IngressClass, "ingressclasses", failures);
    list!(client, NetworkPolicy, "networkpolicies", failures);

    // rbac/v1
    list!(client, Role, "roles", failures);
    list!(client, RoleBinding, "rolebindings", failures);
    list!(client, ClusterRole, "clusterroles", failures);
    list!(client, ClusterRoleBinding, "clusterrolebindings", failures);

    // the rest the app reads
    list!(
        client,
        PodDisruptionBudget,
        "poddisruptionbudgets",
        failures
    );
    list!(
        client,
        HorizontalPodAutoscaler,
        "horizontalpodautoscalers",
        failures
    );
    list!(client, EndpointSlice, "endpointslices", failures);
    list!(client, StorageClass, "storageclasses", failures);
    list!(client, CSIDriver, "csidrivers", failures);
    list!(client, Lease, "leases", failures);

    assert!(
        failures.is_empty(),
        "kinds that would not deserialise against this cluster: {failures:#?}"
    );
}
