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
pub(super) async fn owner_chain(
    ctx: &ResourceContext,
    ns: &str,
    child: ObjectRef,
    owners: Vec<OwnerReference>,
    seen: &mut HashSet<String>,
    out: &mut Neighbourhood,
) {
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
        let Some(next) = fetch_owners(ctx, &controller.kind, &controller.name).await else {
            break;
        };
        child = ObjectRef::new(
            &controller.kind,
            &controller.name,
            Some(ns.to_string()),
            Existence::Present,
        );
        owners = next;
    }
}

/// The owner references of the only two kinds that have any.
///
/// A Deployment, a `StatefulSet`, a `DaemonSet` and a `CronJob` are tops; fetching
/// them would buy nothing, so the walk ends there rather than spending a
/// request to learn that.
pub(super) async fn fetch_owners(
    ctx: &ResourceContext,
    kind: &str,
    name: &str,
) -> Option<Vec<OwnerReference>> {
    match kind {
        "ReplicaSet" => ctx
            .namespaced_api::<ReplicaSet>()
            .get(name)
            .await
            .ok()
            .map(|rs| rs.owner_references().to_vec()),
        "Job" => ctx
            .namespaced_api::<Job>()
            .get(name)
            .await
            .ok()
            .map(|job| job.owner_references().to_vec()),
        _ => None,
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
