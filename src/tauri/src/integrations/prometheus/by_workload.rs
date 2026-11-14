//! Per-pod answers, added up per workload by the app's own rule.
//!
//! The `PromQL` is built in `src/ui/integrations/prometheus/cost.ts` and each
//! query answers one series per `{namespace, pod}`. Ten thousand pods are
//! ten thousand series, which stay on this side of IPC: what crosses is one
//! value per query for each workload the caller asked about, positionally,
//! plus every series that could not be put on one of them, by why.
//!
//! The workloads are named by `commands::cost::cost_key` over the same pods
//! `cost_basis` read, so a row here and a row there are one workload, and a
//! workload the basis cut is never a row here: it is in `rest`.

#![allow(clippy::needless_pass_by_value)]

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use futures::future::join_all;
use serde::{Deserialize, Serialize};
use tauri::State;

use super::{configured, get_json, parse_result, unreachable, PromSeries};
use crate::commands::cost::{
    cost_key, on_a_node, scoped_pods, ScopedPods, WorkloadKey, MAX_COST_ROWS,
};
use crate::commands::helpers::scope_of;
use crate::error::{Error, Result};
use crate::state::AppState;

/// More than a page needs; a bound on what one call costs somebody's server.
const MAX_QUERIES: usize = 8;

/// One value per query, `None` where no series of that query named a pod.
pub type Values = Vec<Option<f64>>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Unplaced {
    pub namespace: String,
    /// Pods the series named that the cluster does not list as on a node.
    pub pods: u32,
    pub values: Values,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnreadSums {
    pub namespace: String,
    pub code: String,
    pub message: String,
    pub values: Values,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkloadFold {
    /// Positional: `values[i]` is `keys[i]`'s.
    pub values: Vec<Values>,
    /// Pods on a node whose workload was not among the keys.
    pub rest: Values,
    pub unplaced: Vec<Unplaced>,
    /// Series in namespaces whose pods could not be read: summed, not dropped.
    pub unread: Vec<UnreadSums>,
    /// Series naming no namespace or no pod, which say nothing about a workload.
    pub unlabelled: u32,
}

#[tauri::command]
pub async fn prometheus_by_workload(
    queries: Vec<String>,
    scope: Option<Vec<String>>,
    keys: Vec<WorkloadKey>,
    state: State<'_, AppState>,
) -> Result<WorkloadFold> {
    crate::client::clock::timed(
        &state.perf,
        "prometheusByWorkload",
        Box::pin(by_workload(&state, queries, scope, keys)),
    )
    .await
}

async fn by_workload(
    state: &AppState,
    queries: Vec<String>,
    scope: Option<Vec<String>>,
    keys: Vec<WorkloadKey>,
) -> Result<WorkloadFold> {
    if queries.is_empty() || queries.len() > MAX_QUERIES {
        return Err(Error::InvalidInput(format!(
            "Between 1 and {MAX_QUERIES} queries, not {}",
            queries.len()
        )));
    }
    if keys.len() > MAX_COST_ROWS {
        return Err(Error::InvalidInput(format!(
            "At most {MAX_COST_ROWS} workloads, not {}",
            keys.len()
        )));
    }
    let scope = scope_of(scope)?;
    let entry = configured(state)?;
    let asked = join_all(queries.into_iter().map(|query| {
        let entry = entry.clone();
        async move {
            let value = get_json(&entry, "/api/v1/query", &[("query", query)])
                .await
                .map_err(unreachable)?;
            parse_result(&value)
        }
    }));
    let (answers, read) = tokio::join!(asked, scoped_pods(state, scope.as_deref()));
    let answers = answers.into_iter().collect::<Result<Vec<_>>>()?;
    Ok(fold(&answers, &read?, &keys, scope.as_deref()))
}

enum Place {
    Workload(WorkloadKey),
    OffNode,
}

fn add(into: &mut Values, query: usize, value: f64) {
    let slot = &mut into[query];
    *slot = Some(slot.unwrap_or(0.0) + value);
}

pub(crate) fn fold(
    answers: &[Vec<PromSeries>],
    read: &ScopedPods,
    keys: &[WorkloadKey],
    scope: Option<&[String]>,
) -> WorkloadFold {
    let width = answers.len();
    let index: HashMap<&WorkloadKey, usize> =
        keys.iter().enumerate().map(|(i, k)| (k, i)).collect();
    let places: HashMap<(&str, &str), Place> = read
        .pods
        .iter()
        .filter_map(|pod| {
            let at = (
                pod.metadata.namespace.as_deref()?,
                pod.metadata.name.as_deref()?,
            );
            let place = if on_a_node(pod) {
                Place::Workload(cost_key(pod, &read.cron_of))
            } else {
                Place::OffNode
            };
            Some((at, place))
        })
        .collect();
    let unread: HashMap<&str, _> = read
        .unread
        .iter()
        .map(|u| (u.namespace.as_str(), u))
        .collect();
    let in_scope = |namespace: &str| scope.is_none_or(|names| names.iter().any(|n| n == namespace));

    let mut fold = WorkloadFold {
        values: vec![vec![None; width]; keys.len()],
        rest: vec![None; width],
        unplaced: Vec::new(),
        unread: Vec::new(),
        unlabelled: 0,
    };
    let mut unplaced: BTreeMap<&str, (BTreeSet<&str>, Values)> = BTreeMap::new();
    let mut unread_sums: BTreeMap<&str, Values> = BTreeMap::new();
    let mut unlabelled = HashSet::new();
    for (query, series) in answers.iter().enumerate() {
        for (at, one) in series.iter().enumerate() {
            let namespace = one
                .labels
                .get("namespace")
                .map(String::as_str)
                .unwrap_or_default();
            let pod = one
                .labels
                .get("pod")
                .map(String::as_str)
                .unwrap_or_default();
            if namespace.is_empty() || pod.is_empty() {
                unlabelled.insert((query, at));
                continue;
            }
            if !in_scope(namespace) {
                continue;
            }
            let Some(value) = one.points.last().and_then(|p| p.v) else {
                continue;
            };
            if unread.contains_key(namespace) {
                add(
                    unread_sums
                        .entry(namespace)
                        .or_insert_with(|| vec![None; width]),
                    query,
                    value,
                );
                continue;
            }
            match places.get(&(namespace, pod)) {
                Some(Place::Workload(key)) => match index.get(key) {
                    Some(&row) => add(&mut fold.values[row], query, value),
                    None => add(&mut fold.rest, query, value),
                },
                Some(Place::OffNode) | None => {
                    let (pods, values) = unplaced
                        .entry(namespace)
                        .or_insert_with(|| (BTreeSet::new(), vec![None; width]));
                    pods.insert(pod);
                    add(values, query, value);
                }
            }
        }
    }
    fold.unlabelled = unlabelled.len() as u32;
    fold.unplaced = unplaced
        .into_iter()
        .map(|(namespace, (pods, values))| Unplaced {
            namespace: namespace.to_string(),
            pods: pods.len() as u32,
            values,
        })
        .collect();
    fold.unread = unread_sums
        .into_iter()
        .map(|(namespace, values)| {
            let why = unread[namespace];
            UnreadSums {
                namespace: namespace.to_string(),
                code: why.code.clone(),
                message: why.message.clone(),
                values,
            }
        })
        .collect();
    fold
}

#[cfg(test)]
#[allow(clippy::float_cmp)]
mod tests {
    use super::*;
    use crate::commands::cost::tests::{pod, read_of, running, Spec};
    use crate::commands::helpers::UnreadNamespace;
    use crate::integrations::prometheus::PromPoint;

    fn series(namespace: &str, pod: &str, v: f64) -> PromSeries {
        let mut labels = HashMap::new();
        if !namespace.is_empty() {
            labels.insert("namespace".to_string(), namespace.to_string());
        }
        if !pod.is_empty() {
            labels.insert("pod".to_string(), pod.to_string());
        }
        PromSeries {
            labels,
            points: vec![PromPoint { t: 0.0, v: Some(v) }],
        }
    }

    fn key(name: &str) -> WorkloadKey {
        WorkloadKey {
            namespace: "shop".into(),
            group: "apps".into(),
            kind: "StatefulSet".into(),
            name: name.into(),
        }
    }

    /// Rows must be the basis's rows: a workload the basis cut appearing
    /// here would be a row with a cost and nothing it requests. Its value is
    /// in `rest`, so the kept rows and the rest add up to every series.
    #[test]
    fn a_workload_cut_from_the_basis_is_never_a_row_and_kept_plus_rest_is_the_total() {
        let read = read_of(vec![
            pod(&running("shop", "kept-0", ("StatefulSet", "kept"))),
            pod(&running("shop", "cut-0", ("StatefulSet", "cut"))),
        ]);
        let answers = vec![vec![
            series("shop", "kept-0", 2.0),
            series("shop", "cut-0", 3.0),
        ]];
        let fold = fold(&answers, &read, &[key("kept")], None);
        assert_eq!(fold.values, vec![vec![Some(2.0)]]);
        assert_eq!(fold.rest, vec![Some(3.0)]);
        assert!(fold.unplaced.is_empty());
    }

    /// A series no workload's pod answers for, kept as a pod without a node
    /// or one the cluster no longer lists: counted beside, never dropped.
    #[test]
    fn a_series_for_a_pod_not_on_a_node_is_unplaced_and_not_dropped() {
        let waiting = Spec {
            node: None,
            phase: "Pending",
            ..running("shop", "kept-1", ("StatefulSet", "kept"))
        };
        let read = read_of(vec![pod(&waiting)]);
        let answers = vec![vec![
            series("shop", "kept-1", 1.0),
            series("shop", "gone-0", 2.0),
        ]];
        let fold = fold(&answers, &read, &[key("kept")], None);
        assert_eq!(fold.values, vec![vec![None]]);
        assert_eq!(fold.unplaced.len(), 1);
        assert_eq!(fold.unplaced[0].pods, 2);
        assert_eq!(fold.unplaced[0].values, vec![Some(3.0)]);
    }

    /// Where pods could not be read, no series can be placed, and summing
    /// them into the namespace keeps the namespace's cost whole.
    #[test]
    fn series_in_a_namespace_whose_pods_were_refused_are_summed_there() {
        let mut read = read_of(vec![]);
        read.unread.push(UnreadNamespace::of(
            "bank".into(),
            &Error::PermissionDenied("pods is forbidden".into()),
        ));
        let answers = vec![vec![series("bank", "teller-0", 4.0)]];
        let fold = fold(&answers, &read, &[], None);
        assert_eq!(fold.unread[0].namespace, "bank");
        assert_eq!(fold.unread[0].code, "PERMISSION_DENIED");
        assert_eq!(fold.unread[0].values, vec![Some(4.0)]);
    }

    /// A query that named none of a workload's pods has no value for it:
    /// `None`, which the page says as "not measured", never a zero.
    #[test]
    fn a_query_that_named_no_pod_of_a_workload_is_none_and_not_zero() {
        let read = read_of(vec![pod(&running(
            "shop",
            "kept-0",
            ("StatefulSet", "kept"),
        ))]);
        let answers = vec![vec![series("shop", "kept-0", 1.0)], vec![]];
        let fold = fold(&answers, &read, &[key("kept")], None);
        assert_eq!(fold.values, vec![vec![Some(1.0), None]]);
    }

    /// A series without the labels the fold joins on says nothing about any
    /// workload, and is counted so the page can say so.
    #[test]
    fn a_series_with_no_namespace_or_pod_is_counted() {
        let read = read_of(vec![]);
        let answers = vec![vec![series("", "x", 1.0), series("shop", "", 1.0)]];
        assert_eq!(fold(&answers, &read, &[], None).unlabelled, 2);
    }

    /// Four queries over ten thousand pods stay on this side of IPC: what
    /// crosses is one value per query for each kept workload.
    #[test]
    fn ten_thousand_pods_of_series_cross_as_values_per_kept_workload() {
        let names: Vec<(String, String)> = (0..10_000)
            .map(|i| {
                (
                    format!("w-{:03}", i % 600),
                    format!("w-{:03}-{i:05}", i % 600),
                )
            })
            .collect();
        let pods = names
            .iter()
            .map(|(owner, name)| pod(&running("shop", name, ("StatefulSet", owner))))
            .collect();
        let read = read_of(pods);
        let answers: Vec<Vec<PromSeries>> = (0..4)
            .map(|q| {
                names
                    .iter()
                    .map(|(_, name)| series("shop", name, f64::from(q) + 0.5))
                    .collect()
            })
            .collect();
        let keys: Vec<WorkloadKey> = (0..600).map(|i| key(&format!("w-{i:03}"))).collect();
        let started = std::time::Instant::now();
        let fold = fold(&answers, &read, &keys, None);
        let took = started.elapsed();
        let bytes = serde_json::to_vec(&fold).unwrap().len();
        eprintln!("fold of 4 x 10 000 series: {bytes} bytes, in {took:?}");
        assert_eq!(fold.values.len(), 600);
        assert!(fold.values.iter().all(|v| v.iter().all(Option::is_some)));
        assert!(bytes < 262_144, "{bytes} bytes");
    }
}
