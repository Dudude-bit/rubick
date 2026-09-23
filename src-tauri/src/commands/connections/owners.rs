//! Ownership: the chain of controllers above an object.

use super::*;

/// The owner an object names, addressed the way its own kind is addressed.
///
/// The child's namespace is the right answer for a namespaced owner and only
/// for one: Kubernetes requires a namespaced owner to sit in the dependent's
/// namespace, but it explicitly allows a namespaced dependent to name a
/// cluster-scoped owner. Stamping the namespace on regardless broke the
/// invariant `ObjectRef::namespace` documents — `None` for the cluster-scoped
/// kinds — and produced a reference to something that is not there.
pub(super) fn owner_ref(owner: &OwnerReference, ns: &str) -> ObjectRef {
    let namespace = (!cluster_scoped(&owner.kind)).then(|| ns.to_string());
    ObjectRef::unchecked(&owner.kind, &owner.name, namespace)
}

/// Walk `metadata.ownerReferences` to the top.
///
/// Only the controller is followed; a non-controller owner is stated once
/// and left alone, because it is not what made the object. The two kinds
/// that are themselves owned are the only ones fetched, which bounds this at
/// two GETs whatever the chain looks like.
///
/// `seen` is shared across the pods of one Service so that each pod states
/// the `ReplicaSet` that made it while the hop above it is walked once.
///
/// A hop that could not be read ends the walk named unread: the page would
/// otherwise say nothing is above it, and an autoscaler on the Deployment
/// there would drop off the pod's page.
pub(super) async fn owner_chain(
    ctx: &ResourceContext,
    ns: &str,
    child: ObjectRef,
    owners: Vec<OwnerReference>,
    seen: &mut HashSet<String>,
    out: &mut Neighbourhood,
) -> Result<()> {
    let mut child = child;
    let mut owners = owners;

    loop {
        let mut controller = None;
        for owner in &owners {
            let is_controller = owner.controller.unwrap_or(false);
            if is_controller {
                controller = Some(owner.clone());
            }
            out.edge(
                owner_ref(owner, ns),
                child.clone(),
                Relation::Owns {
                    controller: is_controller,
                },
            );
        }

        let Some(controller) = controller else { break };
        if !seen.insert(controller.uid.clone()) {
            break;
        }
        let next = match fetch_owners(ctx, &controller.kind, &controller.name).await? {
            Above::Owners(next) => next,
            Above::Nothing => break,
            Above::Unread(unread) => {
                out.unread(unread);
                break;
            }
        };
        child = ObjectRef::new(
            &controller.kind,
            &controller.name,
            Some(ns.to_string()),
            Existence::Present,
        );
        owners = next;
    }
    Ok(())
}

/// What is above one hop of the chain.
pub(super) enum Above {
    /// The walk ends: a top, or an owner gone since the child named it.
    Nothing,
    Owners(Vec<OwnerReference>),
    /// The owner could not be read, so what is above it is unknown.
    Unread(UnexploredKind),
}

/// The owner references of the only two kinds that have any.
///
/// A Deployment, a `StatefulSet`, a `DaemonSet` and a `CronJob` are tops; fetching
/// them would buy nothing, so the walk ends there rather than spending a
/// request to learn that.
pub(super) async fn fetch_owners(ctx: &ResourceContext, kind: &str, name: &str) -> Result<Above> {
    match kind {
        "ReplicaSet" => {
            let got = ctx.namespaced_api::<ReplicaSet>().get(name).await;
            above(got, kind, "apps/v1")
        }
        "Job" => above(
            ctx.namespaced_api::<Job>().get(name).await,
            kind,
            "batch/v1",
        ),
        _ => Ok(Above::Nothing),
    }
}

/// An expired session ends the call, as every other read here does.
fn above<K: kube::Resource>(got: kube::Result<K>, kind: &str, version: &str) -> Result<Above> {
    match got {
        Ok(owner) => Ok(Above::Owners(owner.owner_references().to_vec())),
        Err(kube::Error::Api(status)) if status.code == 404 => Ok(Above::Nothing),
        Err(err) => match Error::from(err) {
            expired @ Error::CredentialsExpired(_) => Err(expired),
            other => Ok(Above::Unread(UnexploredKind::unanswered(
                kind,
                version,
                &other.to_string(),
            ))),
        },
    }
}

#[cfg(test)]
mod ownership_tests {
    use super::*;

    fn owner(kind: &str) -> OwnerReference {
        OwnerReference {
            kind: kind.to_string(),
            name: "the-owner".to_string(),
            ..OwnerReference::default()
        }
    }

    /// Kubernetes requires a namespaced owner to sit in the dependent's
    /// namespace, so the child's namespace is the right answer there.
    #[test]
    fn a_namespaced_owner_is_addressed_in_the_child_s_namespace() {
        assert_eq!(
            owner_ref(&owner("ReplicaSet"), "production")
                .namespace
                .as_deref(),
            Some("production")
        );
    }

    /// And a cluster-scoped one is not, however the dependent is scoped —
    /// naming one is explicitly allowed. `ObjectRef::namespace` documents
    /// `None` for these and the UI builds the object's URL out of it, so a
    /// `PersistentVolume` carrying a namespace addressed
    /// `/persistentvolumes/<ns>/<name>`, which is nothing.
    #[test]
    fn a_cluster_scoped_owner_carries_no_namespace() {
        let cluster: Vec<&str> = crate::resources::every_kind()
            .iter()
            .filter(|facts| facts.scope == KindScope::Cluster)
            .map(|facts| facts.kind.as_str())
            .collect();
        assert!(cluster.contains(&"PersistentVolume") && cluster.len() >= 5);
        for kind in cluster {
            assert_eq!(
                owner_ref(&owner(kind), "production").namespace,
                None,
                "{kind} is not in a namespace"
            );
        }
    }
}

#[cfg(test)]
mod walk_tests {
    use super::*;
    use crate::client::served::test_server::{failure, server};

    const PODS: &str = "/api/v1/namespaces/shop/pods";
    const SET: &str = "/apis/apps/v1/namespaces/shop/replicasets/web-7d9";

    fn pods() -> String {
        let pod = serde_json::json!({
            "metadata": {
                "name": "web-7d9-x", "namespace": "shop",
                "ownerReferences": [{
                    "apiVersion": "apps/v1", "kind": "ReplicaSet", "name": "web-7d9",
                    "uid": "rs-uid", "controller": true,
                }],
            },
        });
        serde_json::json!({ "apiVersion": "v1", "kind": "List", "metadata": {}, "items": [pod] })
            .to_string()
    }

    async fn pod_page(set: (u16, String)) -> Result<ResourceConnections> {
        let (client, _) = server(vec![(PODS, 200, pods()), (SET, set.0, set.1)]).await;
        let ctx = ResourceContext::from_client(client, "shop".to_string());
        connections_of(&ctx, "Pod", "web-7d9-x", None).await
    }

    /// Would say nothing is above the `ReplicaSet` for a token refused
    /// `get replicasets`, and drop the Deployment's autoscaler from the page.
    #[tokio::test]
    async fn a_refused_owner_is_named_unread() {
        let page = pod_page(failure(403, "Forbidden")).await.expect("a page");
        let set = page
            .not_looked_at
            .iter()
            .find(|entry| entry.kind == "ReplicaSet")
            .expect("the refused owner is named");
        assert!(matches!(
            &set.why,
            crate::resources::Unread::Unanswered { version, .. } if version == "apps/v1"
        ));
    }

    /// An owner deleted since the pod named it ends the walk, and is not a
    /// read that failed.
    #[tokio::test]
    async fn an_owner_gone_is_the_top_of_the_walk() {
        let page = pod_page(failure(404, "NotFound")).await.expect("a page");
        assert!(page.not_looked_at.iter().all(|e| e.kind != "ReplicaSet"));
    }

    /// Would leave an expired session as one owner "not looked at".
    #[tokio::test]
    async fn an_expired_session_on_the_owner_ends_the_call() {
        let page = pod_page(failure(401, "Unauthorized")).await;
        assert!(matches!(page, Err(Error::CredentialsExpired(_))));
    }
}
