//! Who talks to whom, from series that name both ends of a flow.
//!
//! The `PromQL` and the labels each query names its ends by are built in
//! `src/ui/integrations/prometheus/traffic.ts`; nothing here knows a source.
//! An end is resolved to a workload by the app's own pod rule (`cost_key`):
//! by the kind and name a series carries, by a pod it names, or by a bare
//! name equal to one workload's, one pod's or the source's own name label.
//! Never by a prefix, and never by picking one of two.

#![allow(clippy::needless_pass_by_value)]

use std::collections::{BTreeMap, BTreeSet, HashMap};

use futures::future::join_all;
use k8s_openapi::api::core::v1::Pod;
use serde::{Deserialize, Serialize};
use tauri::State;

use super::{configured_in, get_json, parse_result, unreachable, PromSeries};
use crate::commands::cost::{cost_key, scoped_pods, ReadFailure, ScopedPods, WorkloadKey};
use crate::commands::helpers::{scope_of, UnreadNamespace};
use crate::error::{Error, Result};
use crate::resources::facts_of;
use crate::state::AppState;

/// The most flows one answer carries; `src/contracts/traffic-budget.json`.
pub const MAX_FLOW_ROWS: usize = 1000;
const MAX_QUERIES: usize = 24;
const MAX_MARKERS: usize = 8;

/// What a query measures; a flow's `values` are in this order, as
/// `src/contracts/traffic-budget.json` lists them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Measure {
    Requests,
    Errors,
    P50,
    P95,
    P99,
    Bytes,
    Events,
    Drops,
}

const MEASURES: [Measure; 8] = [
    Measure::Requests,
    Measure::Errors,
    Measure::P50,
    Measure::P95,
    Measure::P99,
    Measure::Bytes,
    Measure::Events,
    Measure::Drops,
];

impl Measure {
    fn at(self) -> usize {
        MEASURES.iter().position(|m| *m == self).unwrap_or_default()
    }

    /// A percentile of two series is not their sum.
    fn adds(self) -> bool {
        !matches!(self, Self::P50 | Self::P95 | Self::P99)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EndIs {
    Pod,
    Node,
    Service,
    Address,
}

/// A word the source's kind label writes for something that is not a workload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KindAs {
    pub word: String,
    pub is: EndIs,
}

/// Which labels of a series hold one end.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndLabels {
    pub namespace: Option<String>,
    pub kind: Option<String>,
    pub name: Option<String>,
    pub pod: Option<String>,
    pub service: Option<String>,
    pub service_namespace: Option<String>,
    pub address: Option<String>,
    /// A pod label whose value the source names the workload by, over its owner.
    pub name_label: Option<String>,
    pub kind_as: Vec<KindAs>,
    /// What the source writes where it could not tell; empty is always one.
    pub unknown: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowQuery {
    pub source: u8,
    pub measure: Measure,
    pub query: String,
    pub from: EndLabels,
    pub to: EndLabels,
    pub protocol: Option<String>,
    pub reason: Option<String>,
    /// The label naming which proxy of the pair reported a series.
    pub side: Option<String>,
    /// A pair this source saw that this query, answering, has no series
    /// for is at zero: a count of a subset (errors, drops) where none fell.
    pub zero_when_absent: bool,
}

/// What marks a pod as seen by a source: a container's name, or an
/// annotation as `key` or `key=value`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PodMarker {
    pub source: u8,
    pub containers: Vec<String>,
    pub annotated: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NotListedWhy {
    NoSuch,
    PodsUnread,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(tag = "is", rename_all = "camelCase")]
pub enum FlowEnd {
    Workload {
        key: WorkloadKey,
    },
    /// A bare name that names more than one workload here.
    Ambiguous {
        namespace: String,
        name: String,
        kinds: Vec<String>,
    },
    #[serde(rename_all = "camelCase")]
    NotListed {
        namespace: String,
        name: String,
        kind: Option<String>,
        why: NotListedWhy,
    },
    Service {
        namespace: Option<String>,
        name: String,
    },
    Node {
        name: String,
    },
    Address {
        address: String,
    },
    /// The source could not tell; `word` is what it wrote.
    Unidentified {
        namespace: Option<String>,
        word: String,
    },
    /// In another cluster of a Cluster Mesh: no object here is it.
    Remote {
        cluster: String,
        namespace: String,
        kind: String,
        name: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DropRate {
    pub reason: String,
    pub rate: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Flow {
    pub source: u8,
    pub from: u32,
    pub to: u32,
    pub protocols: Vec<String>,
    /// Which proxies of the pair the numbers came from, where the source has
    /// two: `server`, `caller`.
    pub sides: Vec<String>,
    /// Per second over the window, positionally by `Measure`; `None` where
    /// no series of the source had one for this pair.
    pub values: Vec<Option<f64>>,
    pub reasons: Vec<DropRate>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "says", rename_all = "camelCase")]
pub enum QueryState {
    Read { series: u32 },
    NoSeries,
    Failed { code: String, message: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryRead {
    pub source: u8,
    pub measure: Measure,
    pub state: QueryState,
}

/// How many of the subject's pods a source's marker marks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Observed {
    pub source: u8,
    pub pods: u32,
    pub marked: u32,
}

/// Across the scope: workloads with every pod marked, with some, of all.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Coverage {
    pub source: u8,
    pub workloads: u32,
    pub marked: u32,
    pub partly: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficAnswer {
    pub ends: Vec<FlowEnd>,
    pub flows: Vec<Flow>,
    pub reads: Vec<QueryRead>,
    /// For the subject only; `None` where none was asked about or pods were not read.
    pub observed: Option<Vec<Observed>>,
    pub coverage: Vec<Coverage>,
    pub pods_unread: Vec<UnreadNamespace>,
    pub pods_failed: Option<ReadFailure>,
    /// Flows past `MAX_FLOW_ROWS`, the quietest, left out.
    pub cut: u32,
}

#[tauri::command]
pub async fn prometheus_flows(
    queries: Vec<FlowQuery>,
    scope: Option<Vec<String>>,
    subject: Option<WorkloadKey>,
    markers: Vec<PodMarker>,
    state: State<'_, AppState>,
) -> Result<TrafficAnswer> {
    crate::client::clock::timed(
        &state.perf,
        "prometheusFlows",
        Box::pin(flows(&state, queries, scope, subject, markers)),
    )
    .await
}

async fn flows(
    state: &AppState,
    queries: Vec<FlowQuery>,
    scope: Option<Vec<String>>,
    subject: Option<WorkloadKey>,
    markers: Vec<PodMarker>,
) -> Result<TrafficAnswer> {
    if queries.is_empty() || queries.len() > MAX_QUERIES || markers.len() > MAX_MARKERS {
        return Err(Error::InvalidInput(format!(
            "Between 1 and {MAX_QUERIES} queries and at most {MAX_MARKERS} markers, not {} and {}",
            queries.len(),
            markers.len()
        )));
    }
    let scope = scope_of(scope)?;
    if let Some(subject) = &subject {
        crate::validation::validate_namespace(&subject.namespace)?;
    }
    // One read of which cluster this is, for the series and the pods alike.
    let here = state.here()?;
    let entry = configured_in(state, &here.context)?;
    let answers = join_all(queries.iter().map(|asked| {
        let entry = entry.clone();
        let query = asked.query.clone();
        async move {
            let value = get_json(&entry, "/api/v1/query", &[("query", query)])
                .await
                .map_err(unreachable)?;
            parse_result(&value)
        }
    }))
    .await;
    let reach = namespaces_to_read(&queries, &answers, scope.as_deref(), subject.as_ref());
    let (read, failed) = match scoped_pods(state, &here, reach.as_deref()).await {
        Ok(read) => (Some(read), None),
        Err(error @ Error::CredentialsExpired(_)) => return Err(error),
        Err(error) => (
            None,
            Some(ReadFailure {
                code: error.code().to_string(),
                message: error.said(),
            }),
        ),
    };
    Ok(fold(
        &queries,
        answers,
        read.as_ref(),
        failed,
        scope.as_deref(),
        subject.as_ref(),
        &markers,
    ))
}

fn value_of<'a>(series: &'a PromSeries, label: Option<&String>) -> Option<&'a str> {
    series
        .labels
        .get(label?)
        .map(String::as_str)
        .filter(|v| !v.is_empty())
}

fn known<'a>(series: &'a PromSeries, label: Option<&String>, end: &EndLabels) -> Option<&'a str> {
    value_of(series, label).filter(|v| !end.unknown.iter().any(|u| u == v))
}

/// The scope, and every namespace a series names an end in that only pods
/// can resolve; `None` reads every namespace.
fn namespaces_to_read(
    queries: &[FlowQuery],
    answers: &[Result<Vec<PromSeries>>],
    scope: Option<&[String]>,
    subject: Option<&WorkloadKey>,
) -> Option<Vec<String>> {
    let scope = scope?;
    let mut names: BTreeSet<String> = scope.iter().cloned().collect();
    if let Some(subject) = subject {
        names.insert(subject.namespace.clone());
    }
    for (asked, answer) in queries.iter().zip(answers) {
        for series in answer.iter().flatten() {
            for end in [&asked.from, &asked.to] {
                if let Some(ns) = known(series, end.namespace.as_ref(), end) {
                    if crate::validation::validate_namespace(ns).is_ok() {
                        names.insert(ns.to_string());
                    }
                }
            }
        }
    }
    Some(names.into_iter().collect())
}

/// `(namespace, name)` to every workload a bare name could mean there.
type NameIndex = HashMap<(String, String), BTreeSet<WorkloadKey>>;

/// Every pod's workload, and every name a bare name could mean.
struct Pods<'a> {
    of: HashMap<(&'a str, &'a str), WorkloadKey>,
    listed: Vec<(&'a Pod, WorkloadKey)>,
    unread: BTreeSet<&'a str>,
    names: HashMap<Option<String>, NameIndex>,
    read: bool,
}

impl<'a> Pods<'a> {
    fn new(read: Option<&'a ScopedPods>) -> Self {
        let mut pods = Vec::new();
        let mut of = HashMap::new();
        let mut unread = BTreeSet::new();
        if let Some(read) = read {
            for pod in &read.pods {
                let (Some(ns), Some(name)) = (
                    pod.metadata.namespace.as_deref(),
                    pod.metadata.name.as_deref(),
                ) else {
                    continue;
                };
                let key = cost_key(pod, &read.cron_of);
                of.insert((ns, name), key.clone());
                pods.push((pod.as_ref(), key));
            }
            unread = read.unread.iter().map(|u| u.namespace.as_str()).collect();
        }
        Self {
            of,
            listed: pods,
            unread,
            names: HashMap::new(),
            read: read.is_some(),
        }
    }

    fn not_listed(&self, namespace: &str, name: &str, kind: Option<&str>) -> FlowEnd {
        FlowEnd::NotListed {
            namespace: namespace.to_string(),
            name: name.to_string(),
            kind: kind.map(str::to_string),
            why: if !self.read || self.unread.contains(namespace) {
                NotListedWhy::PodsUnread
            } else {
                NotListedWhy::NoSuch
            },
        }
    }

    fn pod(&self, namespace: &str, pod: &str) -> FlowEnd {
        match self.of.get(&(namespace, pod)) {
            Some(key) => FlowEnd::Workload { key: key.clone() },
            None => self.not_listed(namespace, pod, Some("Pod")),
        }
    }

    fn named(&mut self, namespace: &str, name: &str, label: Option<&String>) -> FlowEnd {
        let pods = &self.listed;
        let index = self.names.entry(label.cloned()).or_insert_with(|| {
            let mut index = NameIndex::new();
            for (pod, key) in pods {
                let ns = key.namespace.clone();
                let mut by = |name: &str| {
                    index
                        .entry((ns.clone(), name.to_string()))
                        .or_default()
                        .insert(key.clone());
                };
                by(&key.name);
                if let Some(own) = pod.metadata.name.as_deref() {
                    by(own);
                }
                if let Some(value) = label.and_then(|l| pod.metadata.labels.as_ref()?.get(l)) {
                    by(value);
                }
            }
            index
        });
        let found: Vec<WorkloadKey> = index
            .get(&(namespace.to_string(), name.to_string()))
            .map(|keys| keys.iter().cloned().collect())
            .unwrap_or_default();
        match found.as_slice() {
            [] => self.not_listed(namespace, name, None),
            [key] => FlowEnd::Workload { key: key.clone() },
            keys => FlowEnd::Ambiguous {
                namespace: namespace.to_string(),
                name: name.to_string(),
                kinds: keys.iter().map(|k| k.kind.clone()).collect(),
            },
        }
    }

    fn workload(&self, namespace: &str, kind: &str, name: &str) -> FlowEnd {
        let group = facts_of(kind).map(|f| f.group.clone()).or_else(|| {
            self.listed
                .iter()
                .map(|(_, key)| key)
                .find(|k| k.namespace == namespace && k.kind == kind && k.name == name)
                .map(|k| k.group.clone())
        });
        FlowEnd::Workload {
            key: WorkloadKey {
                namespace: namespace.to_string(),
                group: group.unwrap_or_default(),
                kind: kind.to_string(),
                name: name.to_string(),
            },
        }
    }

    fn end(&mut self, series: &PromSeries, end: &EndLabels) -> FlowEnd {
        let namespace = known(series, end.namespace.as_ref(), end);
        let name = known(series, end.name.as_ref(), end);
        let kind = known(series, end.kind.as_ref(), end);
        if let (Some(kind), Some(name)) = (kind, name) {
            match end.kind_as.iter().find(|k| k.word == kind).map(|k| k.is) {
                Some(EndIs::Node) => return FlowEnd::Node { name: name.into() },
                Some(EndIs::Address) => {
                    return FlowEnd::Address {
                        address: name.into(),
                    }
                }
                Some(EndIs::Service) => {
                    return FlowEnd::Service {
                        namespace: namespace.map(str::to_string),
                        name: name.into(),
                    }
                }
                Some(EndIs::Pod) => {
                    if let Some(ns) = namespace {
                        return self.pod(ns, name);
                    }
                }
                None => {
                    if let Some(ns) = namespace {
                        return self.workload(ns, kind, name);
                    }
                }
            }
        }
        if let (Some(ns), Some(name)) = (namespace, name) {
            return self.named(ns, name, end.name_label.as_ref());
        }
        if let (Some(ns), Some(pod)) = (namespace, known(series, end.pod.as_ref(), end)) {
            return self.pod(ns, pod);
        }
        if let Some(service) = known(series, end.service.as_ref(), end) {
            return FlowEnd::Service {
                namespace: known(series, end.service_namespace.as_ref(), end)
                    .or(namespace)
                    .map(str::to_string),
                name: service.into(),
            };
        }
        if let Some(address) = known(series, end.address.as_ref(), end) {
            return FlowEnd::Address {
                address: address.into(),
            };
        }
        FlowEnd::Unidentified {
            namespace: namespace.map(str::to_string),
            word: value_of(series, end.name.as_ref())
                .unwrap_or_default()
                .to_string(),
        }
    }
}

fn namespace_of(end: &FlowEnd) -> Option<&str> {
    match end {
        FlowEnd::Workload { key } => Some(&key.namespace),
        FlowEnd::Ambiguous { namespace, .. } | FlowEnd::NotListed { namespace, .. } => {
            Some(namespace)
        }
        FlowEnd::Service { namespace, .. } | FlowEnd::Unidentified { namespace, .. } => {
            namespace.as_deref()
        }
        FlowEnd::Node { .. } | FlowEnd::Address { .. } | FlowEnd::Remote { .. } => None,
    }
}

#[derive(Default)]
struct Joined {
    values: [Option<f64>; 8],
    protocols: BTreeSet<String>,
    sides: BTreeSet<String>,
    reasons: BTreeMap<String, f64>,
}

fn marks(pod: &Pod, marker: &PodMarker) -> bool {
    let spec = pod.spec.as_ref();
    let named = spec
        .map(|s| {
            s.containers
                .iter()
                .chain(s.init_containers.iter().flatten())
        })
        .into_iter()
        .flatten()
        .any(|c| marker.containers.contains(&c.name));
    named
        || marker.annotated.iter().any(|mark| {
            let (key, want) = mark
                .split_once('=')
                .map_or((mark.as_str(), None), |(k, v)| (k, Some(v)));
            pod.metadata
                .annotations
                .as_ref()
                .and_then(|a| a.get(key))
                .is_some_and(|v| want.is_none_or(|w| v.as_str() == w))
        })
}

/// Five significant digits: what a rate is read to, and a third of the bytes.
#[allow(clippy::cast_possible_truncation)]
fn rounded(value: f64) -> f64 {
    if value == 0.0 || !value.is_finite() {
        return value;
    }
    let scale = 10f64.powi(4 - value.abs().log10().floor() as i32);
    (value * scale).round() / scale
}

pub(crate) fn fold(
    asked: &[FlowQuery],
    answers: Vec<Result<Vec<PromSeries>>>,
    read: Option<&ScopedPods>,
    pods_failed: Option<ReadFailure>,
    scope: Option<&[String]>,
    subject: Option<&WorkloadKey>,
    markers: &[PodMarker],
) -> TrafficAnswer {
    let mut pods = Pods::new(read);
    let in_scope = |end: &FlowEnd| {
        scope.is_none_or(|s| namespace_of(end).is_some_and(|ns| s.iter().any(|n| n == ns)))
    };
    let is_subject = |end: &FlowEnd| {
        subject.is_some_and(|s| matches!(end, FlowEnd::Workload { key } if key == s))
    };

    let mut reads = Vec::with_capacity(asked.len());
    let mut joined: BTreeMap<(u8, FlowEnd, FlowEnd), Joined> = BTreeMap::new();
    for (query, answer) in asked.iter().zip(answers.iter()) {
        let series = match answer {
            Ok(series) => series,
            Err(error) => {
                reads.push(QueryRead {
                    source: query.source,
                    measure: query.measure,
                    state: QueryState::Failed {
                        code: error.code().to_string(),
                        message: error.said(),
                    },
                });
                continue;
            }
        };
        reads.push(QueryRead {
            source: query.source,
            measure: query.measure,
            state: if series.is_empty() {
                QueryState::NoSeries
            } else {
                QueryState::Read {
                    series: u32::try_from(series.len()).unwrap_or(u32::MAX),
                }
            },
        });
        for one in series {
            let Some(value) = one.points.last().and_then(|p| p.v) else {
                continue;
            };
            let from = pods.end(one, &query.from);
            let to = pods.end(one, &query.to);
            if !(in_scope(&from) || in_scope(&to)) {
                continue;
            }
            if subject.is_some() && !(is_subject(&from) || is_subject(&to)) {
                continue;
            }
            let pair = joined.entry((query.source, from, to)).or_default();
            if let Some(reason) = value_of(one, query.reason.as_ref()) {
                *pair.reasons.entry(reason.to_string()).or_default() += value;
            }
            if let Some(protocol) = value_of(one, query.protocol.as_ref()) {
                pair.protocols.insert(protocol.to_string());
            }
            if let Some(side) = value_of(one, query.side.as_ref()) {
                pair.sides.insert(side.to_string());
            }
            let slot = &mut pair.values[query.measure.at()];
            *slot = Some(match *slot {
                None => value,
                Some(was) if query.measure.adds() => was + value,
                // ponytail: two series on one pair after resolving keep the higher percentile.
                Some(was) => was.max(value),
            });
        }
    }
    for (query, answer) in asked.iter().zip(answers.iter()) {
        if !query.zero_when_absent || answer.is_err() {
            continue;
        }
        for ((source, _, _), pair) in &mut joined {
            let slot = &mut pair.values[query.measure.at()];
            if *source == query.source && slot.is_none() {
                *slot = Some(0.0);
            }
        }
    }

    // A flow's place is its best rank among the busiest of each family, so
    // the cap keeps the busiest requests, bytes, events and drops in turn.
    let ranked: Vec<_> = joined.into_iter().collect();
    let mut place = vec![usize::MAX; ranked.len()];
    for family in [
        Measure::Requests,
        Measure::Bytes,
        Measure::Events,
        Measure::Drops,
    ] {
        let value = |i: usize| ranked[i].1.values[family.at()];
        let mut having: Vec<usize> = (0..ranked.len()).filter(|&i| value(i).is_some()).collect();
        having.sort_by(|&a, &b| {
            value(b)
                .unwrap_or_default()
                .total_cmp(&value(a).unwrap_or_default())
                .then_with(|| ranked[a].0.cmp(&ranked[b].0))
        });
        for (rank, i) in having.into_iter().enumerate() {
            place[i] = place[i].min(rank);
        }
    }
    let mut placed: Vec<_> = ranked.into_iter().zip(place).collect();
    placed.sort_by(|((a, _), a_at), ((b, _), b_at)| a_at.cmp(b_at).then_with(|| a.cmp(b)));
    let mut ranked: Vec<_> = placed.into_iter().map(|(flow, _)| flow).collect();
    let cut = ranked.len().saturating_sub(MAX_FLOW_ROWS);
    ranked.truncate(MAX_FLOW_ROWS);

    let mut ends: Vec<FlowEnd> = Vec::new();
    let mut index: HashMap<FlowEnd, u32> = HashMap::new();
    let mut intern = |end: FlowEnd| {
        *index.entry(end.clone()).or_insert_with(|| {
            ends.push(end);
            u32::try_from(ends.len() - 1).unwrap_or(u32::MAX)
        })
    };
    let flows = ranked
        .into_iter()
        .map(|((source, from, to), pair)| Flow {
            source,
            from: intern(from),
            to: intern(to),
            protocols: pair.protocols.into_iter().collect(),
            sides: pair.sides.into_iter().collect(),
            values: pair.values.iter().map(|v| v.map(rounded)).collect(),
            reasons: pair
                .reasons
                .into_iter()
                .map(|(reason, rate)| DropRate {
                    reason,
                    rate: rounded(rate),
                })
                .collect(),
        })
        .collect();

    let in_scope_pod = |key: &WorkloadKey| scope.is_none_or(|s| s.contains(&key.namespace));
    let observed = subject.filter(|_| pods.read).map(|subject| {
        markers
            .iter()
            .map(|marker| {
                let mine: Vec<_> = pods
                    .listed
                    .iter()
                    .filter(|(_, key)| key == subject)
                    .collect();
                Observed {
                    source: marker.source,
                    pods: u32::try_from(mine.len()).unwrap_or(u32::MAX),
                    marked: u32::try_from(
                        mine.iter().filter(|(pod, _)| marks(pod, marker)).count(),
                    )
                    .unwrap_or(u32::MAX),
                }
            })
            .collect()
    });
    let coverage = if pods.read {
        markers
            .iter()
            .map(|marker| {
                let mut by: BTreeMap<&WorkloadKey, (u32, u32)> = BTreeMap::new();
                for (pod, key) in pods.listed.iter().filter(|(_, key)| in_scope_pod(key)) {
                    let tally = by.entry(key).or_default();
                    tally.0 += 1;
                    tally.1 += u32::from(marks(pod, marker));
                }
                Coverage {
                    source: marker.source,
                    workloads: u32::try_from(by.len()).unwrap_or(u32::MAX),
                    marked: u32::try_from(by.values().filter(|(n, m)| n == m).count())
                        .unwrap_or(u32::MAX),
                    partly: u32::try_from(by.values().filter(|(n, m)| *m > 0 && m < n).count())
                        .unwrap_or(u32::MAX),
                }
            })
            .collect()
    } else {
        Vec::new()
    };

    TrafficAnswer {
        ends,
        flows,
        reads,
        observed,
        coverage,
        pods_unread: read.map(|r| r.unread.clone()).unwrap_or_default(),
        pods_failed,
        cut: u32::try_from(cut).unwrap_or(u32::MAX),
    }
}

#[cfg(test)]
#[allow(
    clippy::float_cmp,
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation
)]
mod tests {
    use super::*;
    use crate::commands::cost::tests::read_of;
    use crate::integrations::prometheus::PromPoint;
    use serde_json::json;
    use std::sync::Arc;

    fn pod(
        ns: &str,
        name: &str,
        owner: Option<(&str, &str)>,
        extra: serde_json::Value,
    ) -> Arc<Pod> {
        let owners: Vec<_> = owner
            .iter()
            .map(|(kind, name)| json!({"apiVersion": "apps/v1", "kind": kind, "name": name, "uid": name, "controller": true}))
            .collect();
        let mut value = json!({
            "metadata": {"namespace": ns, "name": name, "ownerReferences": owners, "labels": {}},
            "spec": {"nodeName": "n", "containers": [{"name": "app"}]},
            "status": {"phase": "Running"},
        });
        merge(&mut value, extra);
        Arc::new(serde_json::from_value(value).expect("a pod"))
    }

    fn merge(into: &mut serde_json::Value, from: serde_json::Value) {
        match (into, from) {
            (serde_json::Value::Object(a), serde_json::Value::Object(b)) => {
                for (k, v) in b {
                    merge(a.entry(k).or_insert(serde_json::Value::Null), v);
                }
            }
            (slot, value) => *slot = value,
        }
    }

    /// A `Deployment`'s pod, through its `ReplicaSet`, as the cluster writes it.
    fn deployed(ns: &str, deployment: &str, suffix: &str) -> Arc<Pod> {
        pod(
            ns,
            &format!("{deployment}-7d9f-{suffix}"),
            Some(("ReplicaSet", &format!("{deployment}-7d9f"))),
            json!({"metadata": {"labels": {"pod-template-hash": "7d9f"}}}),
        )
    }

    fn series(labels: &[(&str, &str)], v: Option<f64>) -> PromSeries {
        PromSeries {
            labels: labels
                .iter()
                .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
                .collect(),
            points: vec![PromPoint { t: 0.0, v }],
        }
    }

    fn named_by(ns: &str, name: &str) -> EndLabels {
        EndLabels {
            namespace: Some(ns.into()),
            name: Some(name.into()),
            unknown: vec!["unknown".into()],
            ..EndLabels::default()
        }
    }

    fn query(source: u8, measure: Measure, from: EndLabels, to: EndLabels) -> FlowQuery {
        FlowQuery {
            source,
            measure,
            query: String::new(),
            from,
            to,
            protocol: None,
            reason: None,
            side: None,
            zero_when_absent: matches!(measure, Measure::Errors | Measure::Drops),
        }
    }

    fn by_name(source: u8, measure: Measure) -> FlowQuery {
        query(
            source,
            measure,
            named_by("sns", "sw"),
            named_by("dns", "dw"),
        )
    }

    fn pair(from: &str, to: &str, v: f64) -> PromSeries {
        series(
            &[("sns", "shop"), ("sw", from), ("dns", "shop"), ("dw", to)],
            Some(v),
        )
    }

    fn key(kind: &str, name: &str) -> WorkloadKey {
        WorkloadKey {
            namespace: "shop".into(),
            group: facts_of(kind).map(|f| f.group.clone()).unwrap_or_default(),
            kind: kind.into(),
            name: name.into(),
        }
    }

    fn end_of(answer: &TrafficAnswer, at: u32) -> &FlowEnd {
        &answer.ends[at as usize]
    }

    fn fold_one(
        asked: &[FlowQuery],
        answers: Vec<Result<Vec<PromSeries>>>,
        read: &ScopedPods,
    ) -> TrafficAnswer {
        fold(asked, answers, Some(read), None, None, None, &[])
    }

    /// The three ways a series names a workload all land on the key the app
    /// gives the pod: its kind and name, one of its pods, or a bare name.
    #[test]
    fn kind_and_name_a_pod_and_a_bare_name_each_resolve_to_the_apps_own_workload() {
        let read = read_of(vec![
            deployed("shop", "cart", "a"),
            deployed("shop", "pay", "b"),
        ]);
        let kinded = query(
            0,
            Measure::Events,
            EndLabels {
                kind: Some("sk".into()),
                ..named_by("sns", "sw")
            },
            EndLabels {
                pod: Some("dp".into()),
                ..EndLabels {
                    namespace: Some("dns".into()),
                    ..EndLabels::default()
                }
            },
        );
        let answer = fold_one(
            &[kinded, by_name(1, Measure::Requests)],
            vec![
                Ok(vec![series(
                    &[
                        ("sns", "shop"),
                        ("sw", "cart"),
                        ("sk", "Deployment"),
                        ("dns", "shop"),
                        ("dp", "pay-7d9f-b"),
                    ],
                    Some(1.0),
                )]),
                Ok(vec![pair("cart", "pay", 2.0)]),
            ],
            &read,
        );
        let cart = FlowEnd::Workload {
            key: key("Deployment", "cart"),
        };
        let pay = FlowEnd::Workload {
            key: key("Deployment", "pay"),
        };
        assert_eq!(answer.flows.len(), 2);
        for flow in &answer.flows {
            assert_eq!(end_of(&answer, flow.from), &cart);
            assert_eq!(end_of(&answer, flow.to), &pay);
        }
    }

    /// A bare name two workloads answer to is said as both, never as the first
    /// one found: the page draws it apart and names the kinds.
    #[test]
    fn a_bare_name_two_kinds_share_is_ambiguous_and_never_the_first() {
        let read = read_of(vec![
            deployed("shop", "db", "a"),
            pod("shop", "db-0", Some(("StatefulSet", "db")), json!({})),
            deployed("shop", "web", "c"),
        ]);
        let answer = fold_one(
            &[by_name(0, Measure::Requests)],
            vec![Ok(vec![pair("web", "db", 1.0)])],
            &read,
        );
        assert_eq!(
            end_of(&answer, answer.flows[0].to),
            &FlowEnd::Ambiguous {
                namespace: "shop".into(),
                name: "db".into(),
                kinds: vec!["Deployment".into(), "StatefulSet".into()],
            }
        );
    }

    /// A kind the series carries settles a name two workloads share: it is
    /// that kind's, not ambiguous, and not looked up by name at all.
    #[test]
    fn a_kind_the_series_carries_settles_a_shared_name() {
        let read = read_of(vec![
            deployed("shop", "db", "a"),
            pod("shop", "db-0", Some(("StatefulSet", "db")), json!({})),
        ]);
        let kinded = query(
            0,
            Measure::Events,
            EndLabels {
                kind: Some("sk".into()),
                ..named_by("sns", "sw")
            },
            EndLabels {
                kind: Some("dk".into()),
                ..named_by("dns", "dw")
            },
        );
        let answer = fold_one(
            &[kinded],
            vec![Ok(vec![series(
                &[
                    ("sns", "shop"),
                    ("sw", "db"),
                    ("sk", "StatefulSet"),
                    ("dns", "shop"),
                    ("dw", "gone"),
                    ("dk", "Deployment"),
                ],
                Some(1.0),
            )])],
            &read,
        );
        assert_eq!(
            end_of(&answer, answer.flows[0].from),
            &FlowEnd::Workload {
                key: key("StatefulSet", "db")
            }
        );
        assert_eq!(
            end_of(&answer, answer.flows[0].to),
            &FlowEnd::Workload {
                key: key("Deployment", "gone")
            }
        );
    }

    /// A pod named by itself, and a workload renamed by the source's label,
    /// are matched by equality with the pod's own name or that label.
    #[test]
    fn a_pods_own_name_and_the_sources_name_label_match_exactly() {
        let read = read_of(vec![
            pod("shop", "web-0", Some(("StatefulSet", "web")), json!({})),
            deployed("shop", "api", "a"),
            pod(
                "shop",
                "worker-1",
                Some(("DaemonSet", "worker")),
                json!({"metadata": {"labels": {"workload-name": "jobs"}}}),
            ),
        ]);
        let mut asked = by_name(0, Measure::Requests);
        asked.to.name_label = Some("workload-name".into());
        let answer = fold_one(
            &[asked],
            vec![Ok(vec![
                pair("api", "web-0", 1.0),
                pair("api", "jobs", 1.0),
                pair("api", "ap", 1.0),
            ])],
            &read,
        );
        let to: Vec<_> = answer
            .flows
            .iter()
            .map(|f| end_of(&answer, f.to).clone())
            .collect();
        assert!(to.contains(&FlowEnd::Workload {
            key: key("StatefulSet", "web")
        }));
        assert!(to.contains(&FlowEnd::Workload {
            key: key("DaemonSet", "worker")
        }));
        assert!(to.contains(&FlowEnd::NotListed {
            namespace: "shop".into(),
            name: "ap".into(),
            kind: None,
            why: NotListedWhy::NoSuch,
        }));
    }

    /// Where the namespace's pods could not be read, a bare name is not
    /// "nobody": it is a name the app could not check.
    #[test]
    fn a_name_in_a_namespace_whose_pods_were_not_read_is_not_listed_for_that_reason() {
        let mut read = read_of(vec![]);
        read.unread.push(UnreadNamespace::of(
            "shop".into(),
            &Error::PermissionDenied("pods is forbidden".into()),
        ));
        let answer = fold_one(
            &[by_name(0, Measure::Requests)],
            vec![Ok(vec![pair("a", "b", 1.0)])],
            &read,
        );
        assert!(matches!(
            end_of(&answer, answer.flows[0].from),
            FlowEnd::NotListed {
                why: NotListedWhy::PodsUnread,
                ..
            }
        ));
        let failed = fold(
            &[by_name(0, Measure::Requests)],
            vec![Ok(vec![pair("a", "b", 1.0)])],
            None,
            Some(ReadFailure {
                code: "PERMISSION_DENIED".into(),
                message: "no".into(),
            }),
            None,
            None,
            &[],
        );
        assert!(matches!(
            end_of(&failed, failed.flows[0].from),
            FlowEnd::NotListed {
                why: NotListedWhy::PodsUnread,
                ..
            }
        ));
        assert_eq!(
            failed.pods_failed.map(|f| f.code),
            Some("PERMISSION_DENIED".to_string())
        );
    }

    /// What the source wrote where it could not tell stays its word; a
    /// destination it named as a service keeps that name.
    #[test]
    fn an_unknown_side_is_unidentified_with_the_sources_word_and_a_service_is_kept() {
        let read = read_of(vec![deployed("shop", "web", "a")]);
        let mut asked = by_name(0, Measure::Requests);
        asked.to.service = Some("svc".into());
        let answer = fold_one(
            &[asked],
            vec![Ok(vec![series(
                &[
                    ("sns", "unknown"),
                    ("sw", "unknown"),
                    ("dns", "shop"),
                    ("dw", "unknown"),
                    ("svc", "PassthroughCluster"),
                ],
                Some(1.0),
            )])],
            &read,
        );
        assert_eq!(
            end_of(&answer, answer.flows[0].from),
            &FlowEnd::Unidentified {
                namespace: None,
                word: "unknown".into()
            }
        );
        assert_eq!(
            end_of(&answer, answer.flows[0].to),
            &FlowEnd::Service {
                namespace: Some("shop".into()),
                name: "PassthroughCluster".into()
            }
        );
    }

    /// Errors absent for a pair are zero only where the errors query
    /// answered; a failed one leaves every pair's errors unknown.
    #[test]
    fn errors_are_zero_only_where_the_errors_query_answered() {
        let read = read_of(vec![deployed("shop", "a", "x"), deployed("shop", "b", "y")]);
        let asked = [by_name(0, Measure::Requests), by_name(0, Measure::Errors)];
        let answered = fold_one(
            &asked,
            vec![Ok(vec![pair("a", "b", 3.0)]), Ok(vec![])],
            &read,
        );
        assert_eq!(answered.flows[0].values[Measure::Errors.at()], Some(0.0));
        assert_eq!(answered.reads[1].state, QueryState::NoSeries);
        let failed = fold_one(
            &asked,
            vec![
                Ok(vec![pair("a", "b", 3.0)]),
                Err(Error::Connection("timed out after 20s".into())),
            ],
            &read,
        );
        assert_eq!(failed.flows[0].values[Measure::Errors.at()], None);
        assert!(
            matches!(&failed.reads[1].state, QueryState::Failed { message, .. } if message.contains("timed out"))
        );
    }

    /// One source failing is that source's sentence; another source's
    /// flows still arrive, and the failure is never read as "no series".
    #[test]
    fn a_failed_source_is_failed_not_empty_and_another_sources_flows_still_come() {
        let read = read_of(vec![deployed("shop", "a", "x"), deployed("shop", "b", "y")]);
        let answer = fold_one(
            &[by_name(0, Measure::Requests), by_name(1, Measure::Events)],
            vec![
                Err(Error::Connection("bad_data".into())),
                Ok(vec![pair("a", "b", 5.0)]),
            ],
            &read,
        );
        assert!(matches!(answer.reads[0].state, QueryState::Failed { .. }));
        assert_eq!(answer.flows.len(), 1);
        assert_eq!(answer.flows[0].source, 1);
    }

    /// Two series on one pair from one source add up; two sources on one
    /// pair stay two rows, so the page can say which number is whose.
    #[test]
    fn two_sources_on_one_pair_stay_two_flows_and_one_sources_series_add() {
        let read = read_of(vec![deployed("shop", "a", "x"), deployed("shop", "b", "y")]);
        let mut with_protocol = by_name(0, Measure::Requests);
        with_protocol.protocol = Some("p".into());
        let http = series(
            &[
                ("sns", "shop"),
                ("sw", "a"),
                ("dns", "shop"),
                ("dw", "b"),
                ("p", "http"),
            ],
            Some(2.0),
        );
        let grpc = series(
            &[
                ("sns", "shop"),
                ("sw", "a"),
                ("dns", "shop"),
                ("dw", "b"),
                ("p", "grpc"),
            ],
            Some(3.0),
        );
        let answer = fold_one(
            &[with_protocol, by_name(1, Measure::Bytes)],
            vec![Ok(vec![http, grpc]), Ok(vec![pair("a", "b", 100.0)])],
            &read,
        );
        assert_eq!(answer.flows.len(), 2);
        let istio = answer
            .flows
            .iter()
            .find(|f| f.source == 0)
            .expect("source 0");
        assert_eq!(istio.values[Measure::Requests.at()], Some(5.0));
        assert_eq!(
            istio.protocols,
            vec!["grpc".to_string(), "http".to_string()]
        );
    }

    /// The scope keeps a flow either end of which is in it; a subject keeps
    /// only the flows it is an end of.
    #[test]
    fn scope_keeps_flows_touching_it_and_a_subject_only_its_own() {
        let read = read_of(vec![
            deployed("shop", "a", "x"),
            deployed("shop", "b", "y"),
            deployed("bank", "c", "z"),
        ]);
        let asked = [by_name(0, Measure::Requests)];
        let cross = series(
            &[("sns", "bank"), ("sw", "c"), ("dns", "shop"), ("dw", "a")],
            Some(1.0),
        );
        let elsewhere = series(
            &[("sns", "bank"), ("sw", "c"), ("dns", "bank"), ("dw", "c")],
            Some(1.0),
        );
        let scope = ["shop".to_string()];
        let scoped = fold(
            &asked,
            vec![Ok(vec![cross.clone(), elsewhere, pair("a", "b", 1.0)])],
            Some(&read),
            None,
            Some(&scope),
            None,
            &[],
        );
        assert_eq!(scoped.flows.len(), 2);
        let subject = key("Deployment", "b");
        let mine = fold(
            &asked,
            vec![Ok(vec![cross, pair("a", "b", 1.0)])],
            Some(&read),
            None,
            None,
            Some(&subject),
            &[],
        );
        assert_eq!(mine.flows.len(), 1);
        assert_eq!(
            end_of(&mine, mine.flows[0].to),
            &FlowEnd::Workload { key: subject }
        );
    }

    /// A sidecar is a container or, in its native form, an init container;
    /// a workload none of whose pods carries it is observed on zero.
    #[test]
    fn a_marker_counts_containers_init_containers_and_annotations_and_zero_is_said() {
        let read = read_of(vec![
            pod(
                "shop",
                "a-0",
                Some(("StatefulSet", "a")),
                json!({"spec": {"containers": [{"name": "app"}, {"name": "istio-proxy"}]}}),
            ),
            pod(
                "shop",
                "a-1",
                Some(("StatefulSet", "a")),
                json!({"spec": {"initContainers": [{"name": "istio-proxy"}]}}),
            ),
            pod(
                "shop",
                "a-2",
                Some(("StatefulSet", "a")),
                json!({"metadata": {"annotations": {"ambient.istio.io/redirection": "enabled"}}}),
            ),
            pod("shop", "b-0", Some(("StatefulSet", "b")), json!({})),
        ]);
        let marker = PodMarker {
            source: 0,
            containers: vec!["istio-proxy".into()],
            annotated: vec!["ambient.istio.io/redirection=enabled".into()],
        };
        let asked = [by_name(0, Measure::Requests)];
        let seen = |name: &str| {
            fold(
                &asked,
                vec![Ok(vec![])],
                Some(&read),
                None,
                None,
                Some(&key("StatefulSet", name)),
                std::slice::from_ref(&marker),
            )
            .observed
            .expect("the subject's pods were read")
        };
        assert_eq!(
            seen("a"),
            vec![Observed {
                source: 0,
                pods: 3,
                marked: 3
            }]
        );
        assert_eq!(
            seen("b"),
            vec![Observed {
                source: 0,
                pods: 1,
                marked: 0
            }]
        );
        let all = fold(
            &asked,
            vec![Ok(vec![])],
            Some(&read),
            None,
            None,
            None,
            std::slice::from_ref(&marker),
        );
        assert_eq!(
            all.coverage,
            vec![Coverage {
                source: 0,
                workloads: 2,
                marked: 1,
                partly: 0
            }]
        );
    }

    /// A pod in Istio's ambient mesh runs no sidecar: the annotation istio-cni
    /// writes is all that says the mesh sees it, and it must reach the count
    /// through the overview store, which strips a pod, as through a list.
    #[test]
    fn an_ambient_pod_is_meshed_through_the_store_and_through_a_list() {
        let ambient = pod(
            "shop",
            "a-0",
            Some(("StatefulSet", "a")),
            json!({"metadata": {"annotations": {"ambient.istio.io/redirection": "enabled"}}}),
        );
        let mut stored = (*ambient).clone();
        crate::overview::strip_pod(&mut stored);
        let marker = PodMarker {
            source: 0,
            containers: vec!["istio-proxy".into()],
            annotated: vec!["ambient.istio.io/redirection".into()],
        };
        let asked = [by_name(0, Measure::Requests)];
        for (path, read) in [
            ("listed", read_of(vec![ambient.clone()])),
            ("stored", read_of(vec![Arc::new(stored.clone())])),
        ] {
            let observed = fold(
                &asked,
                vec![Ok(vec![])],
                Some(&read),
                None,
                None,
                Some(&key("StatefulSet", "a")),
                std::slice::from_ref(&marker),
            )
            .observed;
            assert_eq!(
                observed,
                Some(vec![Observed {
                    source: 0,
                    pods: 1,
                    marked: 1
                }]),
                "{path}"
            );
        }
    }

    /// The busiest flows are kept and the rest counted; on a mesh of 500
    /// workloads with long names and 2000 pairs the answer stays under one IPC
    /// message.
    #[test]
    fn the_answer_keeps_the_busiest_flows_counts_the_rest_and_stays_under_256_kib() {
        let ns = |i: usize| format!("payments-production-eu-west-{:02}", i % 60);
        let name = |i: usize| format!("checkout-service-worker-{i:03}");
        let mut pods = Vec::new();
        for i in 0..500 {
            pods.push(deployed(&ns(i), &name(i), "a"));
        }
        let read = read_of(pods);
        let mut answers = Vec::new();
        for measure in [
            Measure::Requests,
            Measure::Errors,
            Measure::P50,
            Measure::P95,
            Measure::P99,
            Measure::Bytes,
        ] {
            let series: Vec<_> = (0..2000)
                .map(|n| {
                    let (a, b) = (n % 500, (n % 500 + 1 + n / 500) % 500);
                    series(
                        &[
                            ("sns", &ns(a)),
                            ("sw", &name(a)),
                            ("dns", &ns(b)),
                            ("dw", &name(b)),
                        ],
                        Some(1.0 / 3.0 + n as f64),
                    )
                })
                .collect();
            answers.push((by_name(0, measure), Ok(series)));
        }
        let (asked, answers): (Vec<_>, Vec<_>) = answers.into_iter().unzip();
        let answer = fold(&asked, answers, Some(&read), None, None, None, &[]);
        assert_eq!(answer.flows.len(), MAX_FLOW_ROWS);
        assert_eq!(answer.cut, 2000 - MAX_FLOW_ROWS as u32);
        assert_eq!(
            answer.flows[0].values[Measure::Requests.at()],
            Some(rounded(1.0 / 3.0 + 1999.0))
        );
        let size = serde_json::to_vec(&answer).expect("serialises").len();
        assert!(size < 256 * 1024, "{size} bytes");
    }

    /// Both proxies of a pair report a call; the caller's alone holds one that
    /// failed before reaching the server. The two sides' series of one pair
    /// are one flow, its requests their sum, and it says which sides they were.
    #[test]
    fn a_pair_both_proxies_report_is_one_flow_that_names_its_sides() {
        let read = read_of(vec![]);
        let side = |side: &str, v: f64| {
            series(
                &[
                    ("sns", "shop"),
                    ("sw", "web"),
                    ("dns", "shop"),
                    ("dw", "api"),
                    ("rubick_side", side),
                ],
                Some(v),
            )
        };
        let requests = FlowQuery {
            side: Some("rubick_side".into()),
            ..by_name(0, Measure::Requests)
        };
        let answer = fold(
            &[requests, by_name(0, Measure::Errors)],
            vec![
                Ok(vec![side("server", 10.0), side("caller", 20.0)]),
                Ok(vec![pair("web", "api", 20.0)]),
            ],
            Some(&read),
            None,
            None,
            None,
            &[],
        );
        assert_eq!(answer.flows.len(), 1);
        let flow = &answer.flows[0];
        assert_eq!(flow.values[Measure::Requests.at()], Some(30.0));
        assert_eq!(flow.values[Measure::Errors.at()], Some(20.0));
        assert_eq!(flow.sides, vec!["caller".to_string(), "server".to_string()]);
    }

    /// Past the cap each family keeps its busiest in turn: a pair with only
    /// drops, or only bytes, is not cut behind a thousand idle requests.
    #[test]
    fn the_cap_keeps_the_busiest_of_every_family_not_requests_first() {
        let read = read_of(vec![]);
        let requests: Vec<_> = (0..MAX_FLOW_ROWS + 100)
            .map(|n| pair("web", &format!("api-{n}"), 0.0))
            .collect();
        let asked = vec![
            by_name(0, Measure::Requests),
            by_name(1, Measure::Drops),
            by_name(2, Measure::Bytes),
        ];
        let answers = vec![
            Ok(requests),
            Ok(vec![pair("intruder", "db", 500.0)]),
            Ok(vec![pair("backup", "store", 9e6)]),
        ];
        let answer = fold(&asked, answers, Some(&read), None, None, None, &[]);
        assert_eq!(answer.flows.len(), MAX_FLOW_ROWS);
        assert_eq!(answer.cut, 102);
        let kept: Vec<u8> = answer.flows.iter().map(|f| f.source).collect();
        assert!(kept.contains(&1), "the drop-only pair was cut");
        assert!(kept.contains(&2), "the bytes-only pair was cut");
    }

    /// `src/contracts/traffic-budget.json` is the other half of the row cap
    /// and of the order `values` are in.
    #[test]
    fn the_cap_and_the_measure_order_match_the_contract() {
        const BUDGET: &str = include_str!("../../../../contracts/traffic-budget.json");
        let budget: serde_json::Value = serde_json::from_str(BUDGET).expect("json");
        assert_eq!(budget["maxFlowRows"], json!(MAX_FLOW_ROWS));
        assert_eq!(
            budget["measures"],
            serde_json::to_value(MEASURES).expect("measures")
        );
    }
}
