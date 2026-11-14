//! What the timeline compares of an object it follows, and how two readings
//! of one object differ, in the object's own field paths.
//!
//! An object is read as leaves: `spec.template.spec.containers[api].image`,
//! with a list of named things keyed by name so a reorder is no change. Each
//! leaf keeps the text it showed and a digest of what it was. An env literal
//! and every `ConfigMap` or `Secret` value keep the digest alone.
//!
//! The digest is keyed `SipHash` with keys drawn once per process and held
//! nowhere but in this process's memory. Without the keys a digest cannot
//! be tested against a guess, and with them, so can every bearer token this
//! process holds beside them; a digest never reaches a row, a file or the
//! window, which `tests` holds. A change to the value moves the digest, which
//! is the one thing the timeline asks of it.

use std::collections::btree_map::BTreeMap;
use std::hash::{BuildHasher, RandomState};
use std::sync::LazyLock;

use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
use serde_json::Value;

use super::FieldMove;
use crate::resources::{annotations_of, shown_text};

/// Never diffed: it holds the whole object as last applied, a Secret's
/// values included.
pub const LAST_APPLIED: &str = "kubectl.kubernetes.io/last-applied-configuration";

/// A kept value past this is clipped in what a row says; the digest still
/// tells any change.
const VALUE_CHARS: usize = 256;

/// The most fields one row names; the rest are counted.
pub const ROW_FIELDS: usize = 40;

static KEYS: LazyLock<RandomState> = LazyLock::new(RandomState::new);

pub(super) fn digest(text: &str) -> u64 {
    KEYS.hash_one(text)
}

/// A part of an object compared beyond its labels and annotations.
#[derive(Debug)]
enum Part {
    Spec,
    /// A map whose values are not kept: only its keys and digests.
    Values(&'static str),
    /// One field, by its path.
    Field(&'static [&'static str]),
    /// Each condition's `status`, by its type: not its times or its words.
    Conditions,
}

/// Where an object names the revision it runs.
#[derive(Debug)]
enum Runs {
    Nothing,
    Annotation(&'static str),
    Status(&'static str),
}

/// A kind the timeline reads whole.
#[derive(Debug)]
pub struct Followed {
    pub kind: &'static str,
    pub group: &'static str,
    pub plural: &'static str,
    parts: &'static [Part],
    runs: Runs,
}

const fn spec(kind: &'static str, group: &'static str, plural: &'static str) -> Followed {
    Followed {
        kind,
        group,
        plural,
        parts: &[Part::Spec],
        runs: Runs::Nothing,
    }
}

const GATEWAY: &str = "gateway.networking.k8s.io";

/// Every kind the timeline reads whole, beside the cluster's events.
pub const FOLLOWED: &[Followed] = &[
    Followed {
        kind: "Deployment",
        group: "apps",
        plural: "deployments",
        parts: &[Part::Spec],
        runs: Runs::Annotation("deployment.kubernetes.io/revision"),
    },
    Followed {
        kind: "StatefulSet",
        group: "apps",
        plural: "statefulsets",
        parts: &[Part::Spec],
        runs: Runs::Status("updateRevision"),
    },
    spec("DaemonSet", "apps", "daemonsets"),
    spec("Service", "", "services"),
    spec("Ingress", "networking.k8s.io", "ingresses"),
    spec("HTTPRoute", GATEWAY, "httproutes"),
    spec("GRPCRoute", GATEWAY, "grpcroutes"),
    spec("TCPRoute", GATEWAY, "tcproutes"),
    spec("TLSRoute", GATEWAY, "tlsroutes"),
    spec("UDPRoute", GATEWAY, "udproutes"),
    Followed {
        kind: "ConfigMap",
        group: "",
        plural: "configmaps",
        parts: &[
            Part::Values("data"),
            Part::Values("binaryData"),
            Part::Field(&["immutable"]),
        ],
        runs: Runs::Nothing,
    },
    Followed {
        kind: "Secret",
        group: "",
        plural: "secrets",
        parts: &[
            Part::Values("data"),
            Part::Field(&["type"]),
            Part::Field(&["immutable"]),
        ],
        runs: Runs::Nothing,
    },
    spec(
        "HorizontalPodAutoscaler",
        "autoscaling",
        "horizontalpodautoscalers",
    ),
    spec("PodDisruptionBudget", "policy", "poddisruptionbudgets"),
    Followed {
        kind: "PersistentVolumeClaim",
        group: "",
        plural: "persistentvolumeclaims",
        parts: &[
            Part::Spec,
            Part::Field(&["status", "phase"]),
            Part::Field(&["status", "capacity"]),
        ],
        runs: Runs::Nothing,
    },
    spec("NetworkPolicy", "networking.k8s.io", "networkpolicies"),
    Followed {
        kind: "Node",
        group: "",
        plural: "nodes",
        parts: &[Part::Spec, Part::Conditions],
        runs: Runs::Nothing,
    },
    Followed {
        kind: "Namespace",
        group: "",
        plural: "namespaces",
        parts: &[Part::Spec, Part::Field(&["status", "phase"])],
        runs: Runs::Nothing,
    },
];

/// The followed kind by the group and plural discovery names it by.
#[must_use]
pub fn followed_by(group: &str, plural: &str) -> Option<&'static Followed> {
    FOLLOWED
        .iter()
        .find(|followed| followed.group == group && followed.plural == plural)
}

/// The followed kind by its name and group.
#[must_use]
pub fn followed(kind: &str, group: &str) -> Option<&'static Followed> {
    FOLLOWED
        .iter()
        .find(|followed| followed.kind == kind && followed.group == group)
}

/// One leaf: the text a row may show, `None` for a value not kept, and a
/// digest of what it was.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Leaf {
    shown: Option<Box<str>>,
    digest: u64,
}

/// What the timeline holds of one object between two readings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    /// The creation time, which tells a recreated object from the one it replaced.
    pub born: Option<String>,
    pub generation: Option<i64>,
    /// The revision the object names as running, where it names one.
    pub runs: Option<String>,
    /// Sorted by path.
    leaves: Vec<(Box<str>, Leaf)>,
}

impl Snapshot {
    /// Roughly what this snapshot holds on the heap, for the bounds the
    /// timeline states.
    #[must_use]
    pub fn heap_bytes(&self) -> usize {
        self.leaves.capacity() * std::mem::size_of::<(Box<str>, Leaf)>()
            + self
                .leaves
                .iter()
                .map(|(path, leaf)| path.len() + leaf.shown.as_ref().map_or(0, |s| s.len()))
                .sum::<usize>()
    }
}

/// How one list item is keyed, where every item has the field and no two
/// share it: a container by name, a condition by type.
const LIST_KEYS: [&str; 4] = ["name", "type", "mountPath", "containerPort"];

fn list_key(items: &[Value]) -> Option<&'static str> {
    LIST_KEYS.into_iter().find(|key| {
        let mut seen = std::collections::BTreeSet::new();
        items.iter().all(|item| {
            item.get(key)
                .map(|value| match value {
                    Value::String(text) => text.clone(),
                    other => other.to_string(),
                })
                .is_some_and(|said| seen.insert(said))
        })
    })
}

fn segment_of(item: &Value, key: &str) -> String {
    match item.get(key) {
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

/// `spec.selector[app.kubernetes.io/name]`: a key that is not a plain word
/// is bracketed, as a list item's key is.
fn child(path: &str, key: &str) -> String {
    let plain = key
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    match (path.is_empty(), plain) {
        (true, true) => key.to_string(),
        (false, true) => format!("{path}.{key}"),
        (_, false) => format!("{path}[{key}]"),
    }
}

struct Leaves(BTreeMap<String, Leaf>);

impl Leaves {
    fn put(&mut self, path: String, text: &str, kept: bool) {
        let shown = kept.then(|| {
            let shown = shown_text(text);
            let clipped: String = shown.chars().take(VALUE_CHARS).collect();
            if clipped.len() < shown.len() {
                format!("{clipped}…").into_boxed_str()
            } else {
                clipped.into_boxed_str()
            }
        });
        self.0.insert(
            path,
            Leaf {
                shown,
                digest: digest(text),
            },
        );
    }

    /// Every leaf under `value`. `kept` is false under a map whose values
    /// are not kept; an env item keeps everything but its literal.
    fn walk(&mut self, value: &Value, path: String, kept: bool, env_item: bool) {
        match value {
            Value::Array(items) if items.is_empty() => self.put(path, "[]", kept),
            Value::Array(items) => {
                let env = path == "env" || path.rsplit('.').next() == Some("env");
                if let Some(key) = list_key(items) {
                    for item in items {
                        let at = format!("{path}[{}]", segment_of(item, key));
                        self.walk(item, at, kept, env);
                    }
                } else if items.iter().all(|item| !item.is_object()) {
                    self.put(path, &Value::Array(items.clone()).to_string(), kept);
                } else {
                    for (index, item) in items.iter().enumerate() {
                        self.walk(item, format!("{path}[{index}]"), kept, env);
                    }
                }
            }
            Value::Object(map) if map.is_empty() => self.put(path, "{}", kept),
            Value::Object(map) => {
                for (key, item) in map {
                    let literal = env_item && key == "value";
                    self.walk(item, child(&path, key), kept && !literal, false);
                }
            }
            Value::String(text) => self.put(path, text, kept),
            Value::Null => {}
            other => self.put(path, &other.to_string(), kept),
        }
    }
}

fn pointer<'a>(object: &'a Value, path: &[&str]) -> Option<&'a Value> {
    path.iter().try_fold(object, |at, key| at.get(key))
}

/// What the timeline holds of `object`, a followed kind read as the API
/// server serves it.
#[must_use]
pub fn snapshot(followed: &Followed, object: &Value) -> Snapshot {
    let mut leaves = Leaves(BTreeMap::new());
    let meta = object.get("metadata");
    if let Some(labels) = meta.and_then(|m| m.get("labels")) {
        leaves.walk(labels, "metadata.labels".to_string(), true, false);
    }
    let read: Option<ObjectMeta> = meta.and_then(|m| serde_json::from_value(m.clone()).ok());
    // Through the one door every annotation leaves this process by.
    let annotations = read.as_ref().map(annotations_of).unwrap_or_default();
    for (key, value) in &annotations {
        if key != LAST_APPLIED {
            leaves.put(child("metadata.annotations", key), value, true);
        }
    }
    for part in followed.parts {
        match part {
            Part::Spec => {
                if let Some(spec) = object.get("spec") {
                    leaves.walk(spec, "spec".to_string(), true, false);
                }
            }
            Part::Values(key) => {
                if let Some(values) = object.get(*key) {
                    leaves.walk(values, (*key).to_string(), false, false);
                }
            }
            Part::Field(path) => {
                if let Some(value) = pointer(object, path) {
                    leaves.walk(value, path.join("."), true, false);
                }
            }
            Part::Conditions => {
                let conditions =
                    pointer(object, &["status", "conditions"]).and_then(Value::as_array);
                for condition in conditions.into_iter().flatten() {
                    let (Some(kind), Some(status)) = (
                        condition.get("type").and_then(Value::as_str),
                        condition.get("status").and_then(Value::as_str),
                    ) else {
                        continue;
                    };
                    leaves.put(format!("status.conditions[{kind}].status"), status, true);
                }
            }
        }
    }
    let runs = match followed.runs {
        Runs::Nothing => None,
        Runs::Annotation(key) => annotations.get(key).cloned(),
        Runs::Status(field) => pointer(object, &["status", field])
            .and_then(Value::as_str)
            .map(str::to_string),
    };
    Snapshot {
        born: meta
            .and_then(|m| m.get("creationTimestamp"))
            .and_then(Value::as_str)
            .map(str::to_string),
        generation: meta
            .and_then(|m| m.get("generation"))
            .and_then(Value::as_i64),
        runs,
        leaves: leaves
            .0
            .into_iter()
            .map(|(path, leaf)| (path.into_boxed_str(), leaf))
            .collect(),
    }
}

fn moved(path: &str, before: Option<&Leaf>, after: Option<&Leaf>) -> FieldMove {
    let kept = before.or(after).is_some_and(|leaf| leaf.shown.is_some());
    if kept {
        let text = |leaf: Option<&Leaf>| leaf.and_then(|l| l.shown.as_deref()).map(str::to_string);
        FieldMove::Moved {
            path: path.to_string(),
            from: text(before),
            to: text(after),
        }
    } else {
        FieldMove::NotKept {
            path: path.to_string(),
            was: before.is_some(),
            is: after.is_some(),
        }
    }
}

/// What differs between two readings of one object, by path.
#[must_use]
pub fn moves(before: &Snapshot, after: &Snapshot) -> Vec<FieldMove> {
    let mut out = Vec::new();
    let (mut a, mut b) = (
        before.leaves.iter().peekable(),
        after.leaves.iter().peekable(),
    );
    loop {
        match (a.peek(), b.peek()) {
            (None, None) => return out,
            (Some((path, leaf)), None) => {
                out.push(moved(path, Some(leaf), None));
                a.next();
            }
            (None, Some((path, leaf))) => {
                out.push(moved(path, None, Some(leaf)));
                b.next();
            }
            (Some((pa, la)), Some((pb, lb))) => match pa.cmp(pb) {
                std::cmp::Ordering::Less => {
                    out.push(moved(pa, Some(la), None));
                    a.next();
                }
                std::cmp::Ordering::Greater => {
                    out.push(moved(pb, None, Some(lb)));
                    b.next();
                }
                std::cmp::Ordering::Equal => {
                    if la.digest != lb.digest {
                        out.push(moved(pa, Some(la), Some(lb)));
                    }
                    a.next();
                    b.next();
                }
            },
        }
    }
}

/// What a change row says of two readings, or `None` where nothing it
/// compares moved. A change to the template names the revision before it.
#[must_use]
pub fn changed(before: &Snapshot, after: &Snapshot) -> Option<super::RowSays> {
    let mut fields = moves(before, after);
    if fields.is_empty() {
        return None;
    }
    let template = fields.iter().any(|field| {
        let (FieldMove::Moved { path, .. } | FieldMove::NotKept { path, .. }) = field;
        path.starts_with("spec.template")
    });
    let more = fields.len().saturating_sub(ROW_FIELDS);
    fields.truncate(ROW_FIELDS);
    Some(super::RowSays::Changed {
        fields,
        more,
        before: if template { before.runs.clone() } else { None },
    })
}
