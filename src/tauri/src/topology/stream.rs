//! One map stream: the scope drawn namespace by namespace, then each
//! namespace a feed touched drawn again, and only what changed sent.

use std::collections::hash_map::DefaultHasher;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::hash::{Hash, Hasher};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;

use super::{ClusterMap, Touched};
use crate::commands::connections::map::{slice_of, Slice};
use crate::resources::topology::{TopologyEnd, TopologyPiece};
use crate::resources::OtherPolicies;
use crate::state::perf::{chunks_within, IPC_TARGET_BYTES};
use crate::state::AppEvent;

/// A namespace is drawn again at most this often under churn; changes past
/// it are gathered into the next drawing, never dropped.
const REDRAW_EVERY: Duration = Duration::from_secs(1);

/// How long the first drawing waits for kinds still listing. Past it the
/// map is drawn with them named as still listing, and drawn again when
/// they answer.
const FIRST_LIST_WITHIN: Duration = Duration::from_secs(20);

fn fingerprint<T: serde::Serialize>(value: &T) -> u64 {
    let mut hasher = DefaultHasher::new();
    serde_json::to_vec(value)
        .unwrap_or_default()
        .hash(&mut hasher);
    hasher.finish()
}

/// What a stream has drawn: each namespace's slice, which slices hold each
/// node and edge, and what was last sent of each.
#[derive(Default)]
pub struct Drawn {
    slices: BTreeMap<String, Slice>,
    node_holders: HashMap<String, BTreeSet<String>>,
    edge_holders: HashMap<String, BTreeSet<String>>,
    shown_nodes: HashMap<String, u64>,
    shown_edges: HashMap<String, u64>,
    shown_reads: HashMap<String, u64>,
}

impl Drawn {
    /// The namespaces drawn.
    #[must_use]
    pub fn namespaces(&self) -> BTreeSet<String> {
        self.slices.keys().cloned().collect()
    }

    /// A namespace drawn again: the pieces that changed what was sent.
    pub fn put(&mut self, slice: Slice) -> Vec<TopologyPiece> {
        let namespace = slice.read.namespace.clone();
        let read = fingerprint(&slice.read);
        let read_changed = self.shown_reads.insert(namespace.clone(), read) != Some(read);
        let read_piece = read_changed.then(|| TopologyPiece::Namespace {
            read: slice.read.clone(),
        });
        let (nodes, edges) = self.swap(&namespace, Some(slice));
        let mut pieces = self.changes(nodes, edges);
        pieces.extend(read_piece);
        pieces
    }

    /// A namespace no longer drawn: what it alone held goes.
    pub fn drop_namespace(&mut self, namespace: &str) -> Vec<TopologyPiece> {
        let (nodes, edges) = self.swap(namespace, None);
        let mut pieces = self.changes(nodes, edges);
        if self.shown_reads.remove(namespace).is_some() {
            pieces.push(TopologyPiece::NamespaceGone {
                namespace: namespace.to_string(),
            });
        }
        pieces
    }

    /// Replaces a namespace's slice; the node and edge ids either one held.
    fn swap(
        &mut self,
        namespace: &str,
        slice: Option<Slice>,
    ) -> (BTreeSet<String>, BTreeSet<String>) {
        let mut nodes = BTreeSet::new();
        let mut edges = BTreeSet::new();
        if let Some(old) = self.slices.remove(namespace) {
            for id in old.nodes.keys() {
                release(&mut self.node_holders, id, namespace);
                nodes.insert(id.clone());
            }
            for id in old.edges.keys() {
                release(&mut self.edge_holders, id, namespace);
                edges.insert(id.clone());
            }
        }
        if let Some(slice) = slice {
            for id in slice.nodes.keys() {
                self.node_holders
                    .entry(id.clone())
                    .or_default()
                    .insert(namespace.to_string());
                nodes.insert(id.clone());
            }
            for id in slice.edges.keys() {
                self.edge_holders
                    .entry(id.clone())
                    .or_default()
                    .insert(namespace.to_string());
                edges.insert(id.clone());
            }
            self.slices.insert(namespace.to_string(), slice);
        }
        (nodes, edges)
    }

    /// A node as every slice holding it agrees to draw it: its own
    /// namespace's reading wins over a reference made from another.
    fn node(&self, id: &str) -> Option<&crate::resources::topology::TopologyNode> {
        let holders = self.node_holders.get(id)?;
        let held = |ns: &String| self.slices.get(ns).and_then(|slice| slice.nodes.get(id));
        holders
            .iter()
            .find_map(|ns| held(ns).filter(|node| node.object.namespace.as_ref() == Some(ns)))
            .or_else(|| holders.iter().find_map(held))
    }

    fn edge(&self, id: &str) -> Option<&crate::resources::topology::TopologyEdge> {
        let holders = self.edge_holders.get(id)?;
        holders
            .iter()
            .find_map(|ns| self.slices.get(ns).and_then(|slice| slice.edges.get(id)))
    }

    fn changes(&mut self, nodes: BTreeSet<String>, edges: BTreeSet<String>) -> Vec<TopologyPiece> {
        let mut upserts = Vec::new();
        let mut gone = Vec::new();
        for id in &nodes {
            match self.node(id).cloned() {
                Some(node) => {
                    let print = fingerprint(&node);
                    if self.shown_nodes.insert(id.clone(), print) != Some(print) {
                        upserts.push(TopologyPiece::Node { node });
                    }
                }
                None => {
                    if self.shown_nodes.remove(id).is_some() {
                        gone.push(TopologyPiece::NodeGone { id: id.clone() });
                    }
                }
            }
        }
        let mut edge_gone = Vec::new();
        for id in &edges {
            match self.edge(id).cloned() {
                Some(edge) => {
                    let print = fingerprint(&edge);
                    if self.shown_edges.insert(id.clone(), print) != Some(print) {
                        upserts.push(TopologyPiece::Edge { edge });
                    }
                }
                None => {
                    if self.shown_edges.remove(id).is_some() {
                        edge_gone.push(TopologyPiece::EdgeGone { id: id.clone() });
                    }
                }
            }
        }
        // Edges leave before the nodes they joined, and arrive after them.
        upserts.sort_by_key(|piece| matches!(piece, TopologyPiece::Edge { .. }));
        upserts.extend(edge_gone);
        upserts.extend(gone);
        upserts
    }
}

fn release(holders: &mut HashMap<String, BTreeSet<String>>, id: &str, namespace: &str) {
    if let Some(set) = holders.get_mut(id) {
        set.remove(namespace);
        if set.is_empty() {
            holders.remove(id);
        }
    }
}

/// What a stream needs to run.
pub struct Opening {
    pub stream_id: String,
    /// The namespaces named, or `None` for every one.
    pub scope: Option<Vec<String>>,
    pub others: OtherPolicies,
    pub map: Arc<ClusterMap>,
    pub events: broadcast::Sender<AppEvent>,
    pub cancel: CancellationToken,
}

impl Opening {
    fn send(&self, pieces: Vec<TopologyPiece>) {
        for chunk in chunks_within(pieces, IPC_TARGET_BYTES) {
            let _ = self.events.send(AppEvent::TopologyBatch {
                stream_id: self.stream_id.clone(),
                pieces: chunk,
            });
        }
    }

    /// Draws `namespaces` from the stores, off the reactor: a namespace of
    /// thousands of pods is milliseconds of matching.
    async fn draw(&self, drawn: &mut Drawn, namespaces: BTreeSet<String>) {
        for namespace in namespaces {
            let now = chrono::Utc::now();
            let held = self.map.stores().held(&namespace, self.others.clone(), now);
            let Ok(slice) = tokio::task::spawn_blocking(move || slice_of(held, now)).await else {
                continue;
            };
            self.send(drawn.put(slice));
        }
    }

    fn kinds(&self) -> TopologyPiece {
        TopologyPiece::Kinds {
            kinds: self.map.stores().kinds(),
        }
    }
}

/// Runs a stream to its end, which it returns; the caller sends it.
pub async fn run(opening: Opening) -> TopologyEnd {
    let mut changes = opening.map.changes();
    let replaced = opening.map.replaced();
    let ended = |cancel: &CancellationToken| {
        if replaced.is_cancelled() {
            Some(TopologyEnd::Replaced)
        } else if cancel.is_cancelled() {
            Some(TopologyEnd::Closed)
        } else {
            None
        }
    };

    let deadline = tokio::time::Instant::now() + FIRST_LIST_WITHIN;
    while opening.map.stores().syncing() && tokio::time::Instant::now() < deadline {
        tokio::select! {
            biased;
            () = opening.cancel.cancelled() => return TopologyEnd::Closed,
            () = replaced.cancelled() => return TopologyEnd::Replaced,
            _ = changes.recv() => {}
            () = tokio::time::sleep_until(deadline) => {}
        }
    }

    let mut drawn = Drawn::default();
    opening.send(vec![opening.kinds()]);
    let first = opening.map.stores().namespaces(opening.scope.as_deref());
    opening.draw(&mut drawn, first).await;
    if let Some(end) = ended(&opening.cancel) {
        return end;
    }
    let _ = opening.events.send(AppEvent::TopologyReady {
        stream_id: opening.stream_id.clone(),
    });

    let mut last = tokio::time::Instant::now();
    loop {
        let mut touched = Touched::default();
        tokio::select! {
            biased;
            () = opening.cancel.cancelled() => return TopologyEnd::Closed,
            () = replaced.cancelled() => return TopologyEnd::Replaced,
            change = changes.recv() => match change {
                Ok(change) => touched.merge(change),
                Err(broadcast::error::RecvError::Lagged(_)) => touched.all = true,
                Err(broadcast::error::RecvError::Closed) => return TopologyEnd::Replaced,
            },
        }
        tokio::select! {
            biased;
            () = opening.cancel.cancelled() => return TopologyEnd::Closed,
            () = replaced.cancelled() => return TopologyEnd::Replaced,
            () = tokio::time::sleep_until(last + REDRAW_EVERY) => {}
        }
        loop {
            match changes.try_recv() {
                Ok(change) => touched.merge(change),
                Err(broadcast::error::TryRecvError::Lagged(_)) => touched.all = true,
                Err(_) => break,
            }
        }
        last = tokio::time::Instant::now();

        let now_drawn = opening.map.stores().namespaces(opening.scope.as_deref());
        let before = drawn.namespaces();
        for gone in before.difference(&now_drawn) {
            opening.send(drawn.drop_namespace(gone));
        }
        let again: BTreeSet<String> = if touched.all {
            now_drawn
        } else {
            let fresh: BTreeSet<String> = now_drawn.difference(&before).cloned().collect();
            touched
                .namespaces
                .intersection(&now_drawn)
                .cloned()
                .chain(fresh)
                .collect()
        };
        if touched.reads {
            opening.send(vec![opening.kinds()]);
        }
        opening.draw(&mut drawn, again).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resources::topology::{
        MapKindCount, NamespaceRead, NodeVerdict, TopologyEdge, TopologyNode,
    };
    use crate::resources::{Existence, ObjectRef, Relation};

    fn node(kind: &str, ns: &str, name: &str, verdict: NodeVerdict) -> TopologyNode {
        let object = ObjectRef::new(kind, name, Some(ns.to_string()), Existence::Present);
        TopologyNode {
            id: crate::resources::topology::node_id(&object),
            object,
            home: Some(ns.to_string()),
            verdict,
            app: None,
            pods: None,
            cover: None,
        }
    }

    fn slice(ns: &str, nodes: Vec<TopologyNode>, edges: Vec<(&str, &str)>) -> Slice {
        Slice {
            nodes: nodes.into_iter().map(|n| (n.id.clone(), n)).collect(),
            edges: edges
                .into_iter()
                .map(|(from, to)| {
                    let id = format!("{from}>selects>{to}");
                    (
                        id.clone(),
                        TopologyEdge {
                            id,
                            from: from.to_string(),
                            to: to.to_string(),
                            relations: vec![Relation::Selects {
                                selector: "app=web".into(),
                            }],
                        },
                    )
                })
                .collect(),
            read: NamespaceRead {
                namespace: ns.to_string(),
                counts: vec![MapKindCount {
                    kind: "Service".into(),
                    count: Some(1),
                    used: None,
                }],
                not_looked_at: Vec::new(),
            },
        }
    }

    fn ids(pieces: &[TopologyPiece]) -> Vec<String> {
        pieces
            .iter()
            .map(|piece| match piece {
                TopologyPiece::Node { node } => format!("+{}", node.id),
                TopologyPiece::Edge { edge } => format!("+{}", edge.id),
                TopologyPiece::NodeGone { id } | TopologyPiece::EdgeGone { id } => format!("-{id}"),
                TopologyPiece::Namespace { read } => format!("ns {}", read.namespace),
                TopologyPiece::NamespaceGone { namespace } => format!("-ns {namespace}"),
                TopologyPiece::Kinds { .. } => "kinds".into(),
            })
            .collect()
    }

    fn shop(claim: &str) -> Slice {
        slice(
            "shop",
            vec![
                node("Service", "shop", "web", NodeVerdict::Exists),
                node(
                    "PersistentVolumeClaim",
                    "shop",
                    "data",
                    NodeVerdict::Claim {
                        phase: Some(claim.into()),
                    },
                ),
            ],
            vec![("/Service/shop/web", "/PersistentVolumeClaim/shop/data")],
        )
    }

    /// The whole point of drawing a namespace again rather than the cluster:
    /// a claim changing phase must cost one node on the wire. Sending the
    /// namespace whole would re-render every node in it on the frontend.
    #[test]
    fn a_namespace_drawn_again_sends_only_the_node_that_changed() {
        let mut drawn = Drawn::default();
        let first = drawn.put(shop("Pending"));
        assert_eq!(first.len(), 4, "{:?}", ids(&first));

        let again = drawn.put(shop("Bound"));
        assert_eq!(ids(&again), vec!["+/PersistentVolumeClaim/shop/data"]);

        let same = drawn.put(shop("Bound"));
        assert!(same.is_empty(), "{:?}", ids(&same));
    }

    /// An edge pointing at a node the frontend no longer holds draws a line
    /// to nowhere; a node leaving before its edges would do exactly that.
    #[test]
    fn what_leaves_a_namespace_goes_edges_first_and_only_once() {
        let mut drawn = Drawn::default();
        drawn.put(shop("Bound"));
        let gone = drawn.drop_namespace("shop");
        assert_eq!(
            ids(&gone),
            vec![
                "-/Service/shop/web>selects>/PersistentVolumeClaim/shop/data",
                "-/PersistentVolumeClaim/shop/data",
                "-/Service/shop/web",
                "-ns shop"
            ]
        );
        assert!(drawn.drop_namespace("shop").is_empty());
    }

    /// A Gateway in `edge` is named by a route in `shop` too. Redrawing
    /// `shop` without it must not take the Gateway off the map while its own
    /// namespace still draws it, and its own namespace's reading is the one
    /// shown, not the reference made from `shop`.
    #[test]
    fn a_node_two_namespaces_hold_stays_while_either_does_and_its_own_reading_wins() {
        let mut drawn = Drawn::default();
        let own = node(
            "Gateway",
            "edge",
            "public",
            NodeVerdict::Gateway { programmed: None },
        );
        let mut referenced = own.clone();
        referenced.verdict = NodeVerdict::Exists;
        drawn.put(slice("edge", vec![own], vec![]));
        let from_shop = drawn.put(slice("shop", vec![referenced], vec![]));
        assert!(
            !ids(&from_shop)
                .contains(&"+gateway.networking.k8s.io/Gateway/edge/public".to_string()),
            "{:?}",
            ids(&from_shop)
        );
        let shop_again = drawn.put(slice("shop", vec![], vec![]));
        assert!(
            shop_again
                .iter()
                .all(|piece| !matches!(piece, TopologyPiece::NodeGone { .. })),
            "{:?}",
            ids(&shop_again)
        );
    }
}
