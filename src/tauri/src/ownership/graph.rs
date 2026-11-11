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

/// How many dependents one answer carries: a page, whatever the owner holds.
pub const DEPENDENTS_PAGE: usize = 100;

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

    /// The dependents of `owner` with their nodes, by kind and then name.
    fn sorted(&self, owner: &str) -> Vec<(&String, &Node)> {
        let mut found: Vec<(&String, &Node)> = self
            .dependents
            .get(owner)
            .into_iter()
            .flatten()
            .filter_map(|uid| Some((uid, self.nodes.get(uid)?)))
            .collect();
        found.sort_by(|(_, a), (_, b)| {
            (&a.kind, &a.namespace, &a.name).cmp(&(&b.kind, &b.namespace, &b.name))
        });
        found
    }

    fn dependent(&self, owner: &str, uid: &str, node: &Node) -> Dependent {
        Dependent {
            uid: uid.to_string(),
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
        }
    }

    /// One page of the direct dependents of `owner`, by kind and then name:
    /// the page asked for, or the last there is, and how many there are in
    /// all.
    #[must_use]
    pub fn dependents_of(&self, owner: &str, page: usize) -> (Vec<Dependent>, usize, usize) {
        let found = self.sorted(owner);
        let total = found.len();
        let page = page.min(total.saturating_sub(1) / DEPENDENTS_PAGE);
        let rows = found
            .into_iter()
            .skip(page * DEPENDENTS_PAGE)
            .take(DEPENDENTS_PAGE)
            .map(|(uid, node)| self.dependent(owner, uid, node))
            .collect();
        (rows, page, total)
    }

    /// The dependents of `owner` on either side of `uid` among those of its
    /// kind, in the order `dependents_of` lists them.
    #[must_use]
    pub fn beside(&self, owner: &str, uid: &str) -> (Option<Dependent>, Option<Dependent>) {
        let found = self.sorted(owner);
        let Some(at) = found.iter().position(|(held, _)| *held == uid) else {
            return (None, None);
        };
        let kind = &found[at].1.kind;
        let same = |at: Option<usize>| {
            let (uid, node) = found.get(at?)?;
            (node.kind == *kind).then(|| self.dependent(owner, uid, node))
        };
        (same(at.checked_sub(1)), same(Some(at + 1)))
    }

    #[must_use]
    pub fn node(&self, uid: &str) -> Option<&Node> {
        self.nodes.get(uid)
    }

    /// Every object of one kind the index holds, wherever it was read.
    #[must_use]
    pub fn of_kind(&self, kind: &KindKey) -> Vec<String> {
        self.slots
            .iter()
            .filter(|(slot, _)| slot.kind == *kind)
            .flat_map(|(_, members)| members.iter().cloned())
            .collect()
    }

    /// Every object inside one namespace.
    #[must_use]
    pub fn inside(&self, namespace: &str) -> Vec<String> {
        self.nodes
            .iter()
            .filter(|(_, node)| node.namespace.as_deref() == Some(namespace))
            .map(|(uid, _)| uid.clone())
            .collect()
    }

    /// What deleting `root` takes with it, as the garbage collector decides:
    /// a dependent goes only once every one of its owners is going. One
    /// that another living object also owns stays. `contents` go whatever
    /// owns them, as a CRD's objects and a namespace's do.
    #[must_use]
    pub fn cascade(&self, root: &str, contents: &[String]) -> Vec<KindCount> {
        let mut going: HashSet<String> = HashSet::from([root.to_string()]);
        let mut frontier = vec![root.to_string()];
        for uid in contents {
            if going.insert(uid.clone()) {
                frontier.push(uid.clone());
            }
        }
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
        let (replicasets, ..) = graph.dependents_of("d", 0);
        assert_eq!(replicasets.len(), 1);
        assert_eq!(replicasets[0].name, "api-7f9");
        assert!(replicasets[0].controlled);
        assert_eq!(replicasets[0].dependents, 2);
        assert!(graph.dependents_of("api", 0).0.is_empty());
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
        assert_eq!(graph.dependents_of("r", 0).0.len(), 1);
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
        assert_eq!(graph.dependents_of("r", 0).0.len(), 1);
    }

    #[test]
    fn a_cascade_takes_every_descendant_whose_owners_all_go() {
        let graph = deployment_tree();
        let counts = graph.cascade("d", &[]);
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
            .cascade("d", &[])
            .into_iter()
            .find(|c| c.kind == "Pod")
            .map(|c| c.count);
        assert_eq!(pods, Some(1));
    }

    /// A namespace's objects go with it whoever owns them, and what they own
    /// goes with them.
    #[test]
    fn contents_go_whatever_owns_them_and_take_their_dependents() {
        let mut graph = deployment_tree();
        graph.apply(
            &slot("configmaps"),
            "c".into(),
            node(
                "configmaps",
                "ConfigMap",
                "settings",
                &[("elsewhere", false)],
            ),
        );
        let inside = graph.inside("shop");
        assert_eq!(inside.len(), 5);
        let by_kind: Vec<_> = graph
            .cascade("ns", &inside)
            .into_iter()
            .map(|c| (c.kind, c.count))
            .collect();
        assert_eq!(
            by_kind,
            [
                ("ConfigMap".to_string(), 1),
                ("Deployment".to_string(), 1),
                ("Pod".to_string(), 2),
                ("ReplicaSet".to_string(), 1)
            ]
        );
    }

    fn workflow(pods: usize) -> Graph {
        let mut graph = Graph::default();
        graph.apply(
            &slot("configmaps"),
            "c".into(),
            node("configmaps", "ConfigMap", "steps", &[("w", false)]),
        );
        for n in 0..pods {
            graph.apply(
                &slot("pods"),
                format!("p{n:04}"),
                node("pods", "Pod", &format!("step-{n:04}"), &[("w", true)]),
            );
        }
        graph
    }

    /// An Argo Workflow's 5000 step pods went to the window in one answer
    /// of about a megabyte, every two seconds. Fails if an answer carries
    /// more than a page, loses count of the rest, or cannot reach them.
    #[test]
    fn an_owner_of_thousands_is_answered_a_page_at_a_time() {
        let graph = workflow(250);
        let (first, page, total) = graph.dependents_of("w", 0);
        assert_eq!((first.len(), page, total), (DEPENDENTS_PAGE, 0, 251));
        assert_eq!(first[0].name, "steps");
        assert_eq!(first[1].name, "step-0000");

        let (last, page, _) = graph.dependents_of("w", 2);
        assert_eq!((last.len(), page), (51, 2));
        assert_eq!(last[50].name, "step-0249");
    }

    /// Pods finished and went while the tab stood on its last page. Fails
    /// if a page past the end answers nothing, which reads as "owns nothing".
    #[test]
    fn a_page_past_the_end_is_the_last_page_there_is() {
        let graph = workflow(120);
        let (rows, page, total) = graph.dependents_of("w", 7);
        assert_eq!((rows.len(), page, total), (21, 1, 121));
    }

    /// Alt and the side arrows step through an owner's objects of one kind;
    /// they found the neighbour in the list of all of them, which is no
    /// longer sent. Fails if a neighbour on another page is not found, or if
    /// one of another kind is offered.
    #[test]
    fn a_dependent_finds_its_neighbours_of_its_kind_wherever_they_sort() {
        let graph = workflow(250);
        let names = |(before, after): (Option<Dependent>, Option<Dependent>)| {
            (before.map(|d| d.name), after.map(|d| d.name))
        };
        assert_eq!(
            names(graph.beside("w", "p0099")),
            (Some("step-0098".to_string()), Some("step-0100".to_string()))
        );
        assert_eq!(
            names(graph.beside("w", "p0000")),
            (None, Some("step-0001".to_string()))
        );
        assert_eq!(names(graph.beside("w", "c")), (None, None));
        assert_eq!(names(graph.beside("w", "gone")), (None, None));
    }

    #[test]
    fn every_object_of_a_kind_is_found_by_its_kind() {
        let graph = deployment_tree();
        assert_eq!(graph.of_kind(&key("pods")).len(), 2);
        assert!(graph.of_kind(&key("widgets")).is_empty());
    }
}
