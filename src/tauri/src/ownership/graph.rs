//! The ownership graph itself: objects by uid, and each owner's dependents.
//! Pure bookkeeping, fed by the watches in `slots`.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use serde::{Deserialize, Serialize};

/// A kind as discovery names it.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KindKey {
    pub group: String,
    pub plural: String,
}

/// Where one watch reads a kind: the whole cluster, or one namespace.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SlotKey {
    pub kind: KindKey,
    pub namespace: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnerLink {
    pub uid: String,
    pub controller: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Node {
    pub key: KindKey,
    pub kind: String,
    pub version: String,
    pub name: String,
    pub namespace: Option<String>,
    pub owners: Vec<OwnerLink>,
}

/// One dependent, as a tree row draws it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dependent {
    pub uid: String,
    pub kind: String,
    pub group: String,
    pub version: String,
    pub plural: String,
    pub name: String,
    pub namespace: Option<String>,
    /// The owner asked about is this object's controller, not one of several.
    pub controlled: bool,
    /// Its own dependents, counted, so a row says whether it opens.
    pub dependents: usize,
}

/// How many objects of one kind a deletion would take with it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KindCount {
    pub kind: String,
    pub group: String,
    pub plural: String,
    pub count: usize,
}

#[derive(Debug, Default)]
pub struct Graph {
    nodes: HashMap<String, Node>,
    dependents: HashMap<String, BTreeSet<String>>,
    slots: HashMap<SlotKey, HashSet<String>>,
    /// What a slot has listed since its last `Init`, swapped in at `InitDone`.
    relisting: HashMap<SlotKey, HashSet<String>>,
}

impl Graph {
    pub fn apply(&mut self, slot: &SlotKey, uid: String, node: Node) {
        self.unlink(&uid);
        for owner in &node.owners {
            self.dependents
                .entry(owner.uid.clone())
                .or_default()
                .insert(uid.clone());
        }
        self.slots
            .entry(slot.clone())
            .or_default()
            .insert(uid.clone());
        if let Some(listed) = self.relisting.get_mut(slot) {
            listed.insert(uid.clone());
        }
        self.nodes.insert(uid, node);
    }

    pub fn delete(&mut self, slot: &SlotKey, uid: &str) {
        self.unlink(uid);
        self.nodes.remove(uid);
        if let Some(members) = self.slots.get_mut(slot) {
            members.remove(uid);
        }
    }

    /// A slot starts listing again: what it lists until `listed` is all it has.
    pub fn relist(&mut self, slot: &SlotKey) {
        self.relisting.insert(slot.clone(), HashSet::new());
    }

    /// The list is complete; whatever the slot held and did not list is gone.
    pub fn listed(&mut self, slot: &SlotKey) {
        let Some(listed) = self.relisting.remove(slot) else {
            return;
        };
        let held = self.slots.get(slot).cloned().unwrap_or_default();
        for uid in held.difference(&listed) {
            self.delete(slot, uid);
        }
    }

    /// Forget everything one slot read, when it stops.
    pub fn drop_slot(&mut self, slot: &SlotKey) {
        for uid in self.slots.remove(slot).unwrap_or_default() {
            self.unlink(&uid);
            self.nodes.remove(&uid);
        }
        self.relisting.remove(slot);
    }

    fn unlink(&mut self, uid: &str) {
        let Some(old) = self.nodes.get(uid) else {
            return;
        };
        for owner in &old.owners {
            if let Some(set) = self.dependents.get_mut(&owner.uid) {
                set.remove(uid);
                if set.is_empty() {
                    self.dependents.remove(&owner.uid);
                }
            }
        }
    }

    /// The direct dependents of `owner`, by kind and then name.
    #[must_use]
    pub fn dependents_of(&self, owner: &str) -> Vec<Dependent> {
        let mut found: Vec<Dependent> = self
            .dependents
            .get(owner)
            .into_iter()
            .flatten()
            .filter_map(|uid| {
                let node = self.nodes.get(uid)?;
                Some(Dependent {
                    uid: uid.clone(),
                    kind: node.kind.clone(),
                    group: node.key.group.clone(),
                    version: node.version.clone(),
                    plural: node.key.plural.clone(),
                    name: node.name.clone(),
                    namespace: node.namespace.clone(),
                    controlled: node
                        .owners
                        .iter()
                        .any(|link| link.uid == owner && link.controller),
                    dependents: self.dependents.get(uid).map_or(0, BTreeSet::len),
                })
            })
            .collect();
        found.sort_by(|a, b| {
            (&a.kind, &a.namespace, &a.name).cmp(&(&b.kind, &b.namespace, &b.name))
        });
        found
    }

    /// What deleting `root` takes with it, as the garbage collector decides:
    /// a dependent goes only once every one of its owners is going. One
    /// that another living object also owns stays.
    #[must_use]
    pub fn cascade(&self, root: &str) -> Vec<KindCount> {
        let mut going: HashSet<String> = HashSet::from([root.to_string()]);
        let mut frontier = vec![root.to_string()];
        while let Some(owner) = frontier.pop() {
            for uid in self.dependents.get(&owner).into_iter().flatten() {
                if going.contains(uid) {
                    continue;
                }
                let Some(node) = self.nodes.get(uid) else {
                    continue;
                };
                if node.owners.iter().all(|link| going.contains(&link.uid)) {
                    going.insert(uid.clone());
                    frontier.push(uid.clone());
                }
            }
        }
        going.remove(root);
        let mut counts: BTreeMap<(String, String, String), usize> = BTreeMap::new();
        for uid in &going {
            if let Some(node) = self.nodes.get(uid) {
                *counts
                    .entry((
                        node.kind.clone(),
                        node.key.group.clone(),
                        node.key.plural.clone(),
                    ))
                    .or_default() += 1;
            }
        }
        counts
            .into_iter()
            .map(|((kind, group, plural), count)| KindCount {
                kind,
                group,
                plural,
                count,
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(plural: &str) -> KindKey {
        KindKey {
            group: "apps".to_string(),
            plural: plural.to_string(),
        }
    }

    fn slot(plural: &str) -> SlotKey {
        SlotKey {
            kind: key(plural),
            namespace: None,
        }
    }

    fn node(plural: &str, kind: &str, name: &str, owners: &[(&str, bool)]) -> Node {
        Node {
            key: key(plural),
            kind: kind.to_string(),
            version: "v1".to_string(),
            name: name.to_string(),
            namespace: Some("shop".to_string()),
            owners: owners
                .iter()
                .map(|(uid, controller)| OwnerLink {
                    uid: (*uid).to_string(),
                    controller: *controller,
                })
                .collect(),
        }
    }

    fn deployment_tree() -> Graph {
        let mut graph = Graph::default();
        graph.apply(
            &slot("deployments"),
            "d".into(),
            node("deployments", "Deployment", "api", &[]),
        );
        graph.apply(
            &slot("replicasets"),
            "r".into(),
            node("replicasets", "ReplicaSet", "api-7f9", &[("d", true)]),
        );
        graph.apply(
            &slot("pods"),
            "p1".into(),
            node("pods", "Pod", "api-7f9-a", &[("r", true)]),
        );
        graph.apply(
            &slot("pods"),
            "p2".into(),
            node("pods", "Pod", "api-7f9-b", &[("r", true)]),
        );
        graph
    }

    /// The edge is the owner's uid, never a name: a dependent of `api` is
    /// found by `api`'s uid and only by it.
    #[test]
    fn dependents_are_found_by_their_owners_uid_with_their_own_counts() {
        let graph = deployment_tree();
        let replicasets = graph.dependents_of("d");
        assert_eq!(replicasets.len(), 1);
        assert_eq!(replicasets[0].name, "api-7f9");
        assert!(replicasets[0].controlled);
        assert_eq!(replicasets[0].dependents, 2);
        assert!(graph.dependents_of("api").is_empty());
    }

    /// A re-list that no longer has an object is the object's deletion, the
    /// one the watch missed while it was down.
    #[test]
    fn a_relist_drops_what_it_no_longer_lists() {
        let mut graph = deployment_tree();
        graph.relist(&slot("pods"));
        graph.apply(
            &slot("pods"),
            "p1".into(),
            node("pods", "Pod", "api-7f9-a", &[("r", true)]),
        );
        graph.listed(&slot("pods"));
        assert_eq!(graph.dependents_of("r").len(), 1);
    }

    /// An owner moving its dependent (adopt, orphan) leaves no stale edge.
    #[test]
    fn a_changed_owner_moves_the_edge() {
        let mut graph = deployment_tree();
        graph.apply(
            &slot("pods"),
            "p1".into(),
            node("pods", "Pod", "api-7f9-a", &[]),
        );
        assert_eq!(graph.dependents_of("r").len(), 1);
    }

    #[test]
    fn a_cascade_takes_every_descendant_whose_owners_all_go() {
        let graph = deployment_tree();
        let counts = graph.cascade("d");
        let by_kind: Vec<_> = counts.iter().map(|c| (c.kind.as_str(), c.count)).collect();
        assert_eq!(by_kind, [("Pod", 2), ("ReplicaSet", 1)]);
    }

    /// The garbage collector keeps a dependent another living object owns.
    #[test]
    fn a_cascade_spares_a_dependent_with_another_owner() {
        let mut graph = deployment_tree();
        graph.apply(
            &slot("configmaps"),
            "o".into(),
            node("configmaps", "ConfigMap", "other", &[]),
        );
        graph.apply(
            &slot("pods"),
            "p2".into(),
            node("pods", "Pod", "api-7f9-b", &[("r", true), ("o", false)]),
        );
        let pods = graph
            .cascade("d")
            .into_iter()
            .find(|c| c.kind == "Pod")
            .map(|c| c.count);
        assert_eq!(pods, Some(1));
    }
}
