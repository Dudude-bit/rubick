//! What the cluster map carries across IPC: objects as the Connections tab
//! names them, each with the input its own page's verdict reads.

use serde::{Deserialize, Serialize};

use super::{
    facts_of, ChainStop, ConditionInfo, IngressInfo, ObjectRef, Relation, Rollout,
    ServicePublished, UnexploredKind,
};

/// One object on the map.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopologyNode {
    /// `{group}/{kind}/{namespace}/{name}`, by [`node_id`].
    pub id: String,
    #[serde(rename = "ref")]
    pub object: ObjectRef,
    /// The namespace whose card it is drawn in: its own, or for a
    /// cluster-scoped owner the namespace of what it owns.
    pub home: Option<String>,
    pub verdict: NodeVerdict,
    /// `app.kubernetes.io/part-of`, then `instance`, then `name`; an object
    /// carrying none takes the one its neighbours agree on.
    pub app: Option<String>,
    /// The pods folded into it; `None` where the namespace's pods were not read.
    pub pods: Option<PodTally>,
    /// Which `NetworkPolicies` select it, on a workload.
    pub cover: Option<PolicyCover>,
}

/// What a node's own page reads to give it a verdict, kind by kind.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "says", rename_all = "camelCase")]
pub enum NodeVerdict {
    /// A Deployment, `StatefulSet` or `DaemonSet`: the rollout its page reads,
    /// its own pods asked.
    Rollout {
        rollout: Rollout,
    },
    /// A Job's status code, as its list prints it.
    Job {
        status: String,
    },
    CronJob {
        suspend: bool,
    },
    /// A `ReplicaSet` no drawn Deployment controls.
    Replicas {
        ready: i32,
        desired: i32,
    },
    /// What a Service publishes, as its page reads it; `None` where none of
    /// the three sources was read, and `unread` then says why.
    Service {
        published: Option<ServicePublished>,
        unread: Option<String>,
    },
    Ingress {
        row: IngressInfo,
    },
    /// A Gateway API route: where a path through it stops, and whether every
    /// parent accepted it (`None` where one has not said).
    Route {
        stops: Vec<ChainStop>,
        accepted: Option<bool>,
    },
    Gateway {
        programmed: Option<ConditionInfo>,
    },
    Claim {
        phase: Option<String>,
    },
    /// Read off the reference's facts, as the Connections tab reads them.
    Autoscaler,
    Budget,
    /// How many of the namespace's pods it picks; `None` where they were not read.
    Policy {
        selected: Option<usize>,
    },
    /// A `ConfigMap`, Secret or `ServiceAccount`: there, missing, or not read.
    Exists,
    /// Named by an owner reference or holding pods nothing else claims, and
    /// never read itself.
    Owner,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PodTally {
    pub total: usize,
    pub ready: usize,
}

/// Which `NetworkPolicies` select a workload's pods.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "says", rename_all = "camelCase")]
pub enum PolicyCover {
    Covered {
        policies: Vec<String>,
    },
    /// Every policy here was read and none selects it.
    None,
    /// No policy here selects it, and something that might was not read:
    /// another engine's kinds in force here, or a selector that cannot be evaluated.
    Unknown {
        because: Vec<String>,
    },
    Unread {
        said: String,
    },
}

/// One edge: every relation stated between the same two objects in the same verb.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopologyEdge {
    pub id: String,
    pub from: String,
    pub to: String,
    pub relations: Vec<Relation>,
}

/// How many objects of a kind a namespace holds, where they were read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapKindCount {
    pub kind: String,
    /// `None` where the kind was not read here, or is not counted whole.
    pub count: Option<usize>,
    /// How many of them something on the map uses, for the kinds drawn only when used.
    pub used: Option<usize>,
}

/// One namespace as the map read it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamespaceRead {
    pub namespace: String,
    pub counts: Vec<MapKindCount>,
    pub not_looked_at: Vec<UnexploredKind>,
}

/// How one kind is being read across the scope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "says", rename_all = "camelCase")]
pub enum MapKindReading {
    Live,
    /// Its first list has not answered since `since`.
    Syncing {
        since: String,
    },
    /// Refused across the cluster and read in `namespaces` instead.
    NamespacesOnly {
        namespaces: Vec<String>,
        said: String,
    },
    Refused {
        said: String,
    },
    /// It failed before it ever answered.
    Failed {
        said: String,
    },
    /// The read broke at `since`; what is drawn of it is from then.
    Stale {
        since: String,
        said: String,
    },
    /// The cluster does not serve it: Gateway API not installed.
    NotServed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapKindState {
    pub kind: String,
    pub reading: MapKindReading,
}

/// One change to what a map stream has sent, applied in order.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "is", rename_all = "camelCase")]
pub enum TopologyPiece {
    Node { node: TopologyNode },
    Edge { edge: TopologyEdge },
    NodeGone { id: String },
    EdgeGone { id: String },
    Namespace { read: NamespaceRead },
    NamespaceGone { namespace: String },
    Kinds { kinds: Vec<MapKindState> },
}

/// Why a map stream ended. Every stream ends with exactly one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "says", rename_all = "camelCase")]
pub enum TopologyEnd {
    Closed,
    /// Its subscriber never came.
    Unsubscribed,
    /// The cluster's credentials or connection were replaced: open it again.
    Replaced,
    Failed {
        said: String,
    },
}

/// `{group}/{kind}/{namespace}/{name}`: the same string on both sides of
/// IPC, held to `src/contracts/topology-ids.json`.
#[must_use]
pub fn node_id(object: &ObjectRef) -> String {
    let group = object.group.clone().unwrap_or_else(|| {
        facts_of(&object.kind)
            .map(|facts| facts.group.clone())
            .unwrap_or_default()
    });
    format!(
        "{group}/{}/{}/{}",
        object.kind,
        object.namespace.as_deref().unwrap_or_default(),
        object.name
    )
}

/// The verb an edge's id is keyed by.
#[must_use]
pub fn verb_of(relation: &Relation) -> &'static str {
    match relation {
        Relation::Owns { .. } => "owns",
        Relation::Selects { .. } => "selects",
        Relation::Uses { .. } => "uses",
        Relation::Routes { .. } => "routes",
        Relation::RuleRoutes { .. } => "ruleRoutes",
        Relation::AttachesTo { .. } => "attachesTo",
        Relation::RunsOn => "runsOn",
        Relation::Binds => "binds",
        Relation::Governs { .. } => "governs",
    }
}

/// The app an object belongs to, by the recommended labels in order.
#[must_use]
pub fn app_of(labels: &std::collections::BTreeMap<String, String>) -> Option<String> {
    [
        "app.kubernetes.io/part-of",
        "app.kubernetes.io/instance",
        "app.kubernetes.io/name",
    ]
    .iter()
    .find_map(|key| labels.get(*key).filter(|value| !value.is_empty()).cloned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resources::Existence;

    #[derive(Deserialize)]
    struct Case {
        kind: String,
        name: String,
        namespace: Option<String>,
        group: Option<String>,
        id: String,
    }

    /// The Traffic page builds the id of a workload a flow names on the
    /// frontend and looks it up among these: a second spelling here would
    /// leave every flow pointing at no node.
    #[test]
    fn every_node_id_in_the_shared_corpus_is_spelled_the_same_here() {
        let cases: Vec<Case> =
            serde_json::from_str(include_str!("../../../contracts/topology-ids.json"))
                .expect("the corpus parses");
        assert!(!cases.is_empty());
        for case in cases {
            let mut object =
                ObjectRef::new(&case.kind, &case.name, case.namespace, Existence::Present);
            object.group = case.group;
            assert_eq!(node_id(&object), case.id);
        }
    }

    /// A ConfigMap with no app label of its own is placed by its users; one
    /// labelled with an empty value must not open a group named "".
    #[test]
    fn the_app_is_the_first_recommended_label_with_a_value() {
        let labels = |pairs: &[(&str, &str)]| {
            pairs
                .iter()
                .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
                .collect()
        };
        assert_eq!(
            app_of(&labels(&[
                ("app.kubernetes.io/name", "web"),
                ("app.kubernetes.io/part-of", "shop")
            ])),
            Some("shop".to_string())
        );
        assert_eq!(
            app_of(&labels(&[
                ("app.kubernetes.io/part-of", ""),
                ("app.kubernetes.io/instance", "shop-eu")
            ])),
            Some("shop-eu".to_string())
        );
        assert_eq!(app_of(&labels(&[("app", "web")])), None);
    }
}
