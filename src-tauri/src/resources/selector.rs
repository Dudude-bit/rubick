//! One label query, read the way the API server reads it.
//!
//! Every selector test in this app used to be `match_labels` and a subset
//! check, which answers "matches nothing" for the half of the API that uses
//! `matchExpressions` — and a Service chain that says *where the path stops*
//! cannot afford to say it stops at a selector that is working.
//!
//! Two shapes, because Kubernetes has two and they disagree about the empty
//! case. `metav1.LabelSelector` — a `PodDisruptionBudget`'s, a workload's —
//! matches **everything** when it is `{}` and nothing when it is absent. A
//! Service's `spec.selector` is a plain `map[string]string` with no
//! expressions at all, and an empty one selects **nothing**: the endpoints are
//! written by hand, or the Service is an `ExternalName`. Collapsing the second
//! onto the first is the one way a shared helper gets this wrong, so the
//! shapes stay apart and the caller says which it has.

use std::collections::BTreeMap;

use k8s_openapi::apimachinery::pkg::apis::meta::v1::{LabelSelector, LabelSelectorRequirement};

/// A label query, in the two shapes the API defines one in.
#[derive(Debug, Clone, Copy)]
pub enum Selector<'a> {
    /// A `metav1.LabelSelector`. `None` is a selector that is not there —
    /// it matches nothing — and `Some` of an empty one matches everything in
    /// scope.
    Query(Option<&'a LabelSelector>),
    /// A Service's `spec.selector`: equality only, and empty matches nothing.
    Equality(&'a BTreeMap<String, String>),
}

impl Selector<'_> {
    /// Whether one object's labels satisfy this query, or `None` where it
    /// cannot be evaluated: a `LabelSelector` Kubernetes would refuse to
    /// build. An equality selector always answers.
    ///
    /// `shared/label-selector-conformance.json` holds the answers, and
    /// `src/lib/label-selector.ts` owes the same ones.
    #[must_use]
    pub fn matches(&self, labels: &BTreeMap<String, String>) -> Option<bool> {
        match self {
            Self::Equality(selector) => {
                Some(!selector.is_empty() && selector.iter().all(|(k, v)| labels.get(k) == Some(v)))
            }
            Self::Query(None) => Some(false),
            Self::Query(Some(selector)) => {
                let pairs = selector.match_labels.as_ref();
                if pairs.is_some_and(|pairs| pairs.contains_key("")) {
                    return None;
                }
                // Every requirement is checked before any answer counts: the
                // conversion fails whole, even after another one has failed.
                let expressions = selector
                    .match_expressions
                    .iter()
                    .flatten()
                    .try_fold(true, |all, req| {
                        requirement_matches(req, labels).map(|hit| all && hit)
                    })?;
                Some(
                    expressions
                        && pairs
                            .into_iter()
                            .flatten()
                            .all(|(k, v)| labels.get(k) == Some(v)),
                )
            }
        }
    }

    /// The API's own text form — what `kubectl get -l` takes, and what a
    /// `ListParams` carries.
    ///
    /// `None` where the selector matches nothing, so there is no list to ask
    /// for at all. `Some("")` where it matches everything in scope, which is
    /// what an empty `LabelSelector` means and what an empty query string
    /// does — the two agree, which is why one function serves both.
    #[must_use]
    pub fn query_text(&self) -> Option<String> {
        match self {
            Self::Equality(selector) => (!selector.is_empty()).then(|| {
                selector
                    .iter()
                    .map(|(k, v)| format!("{k}={v}"))
                    .collect::<Vec<_>>()
                    .join(",")
            }),
            Self::Query(None) => None,
            Self::Query(Some(selector)) => Some(text_of(selector)),
        }
    }

    /// The same query, in the terms a reader is shown it in.
    ///
    /// The one difference is the empty `LabelSelector`: as a query string it
    /// is `""`, and "protects " followed by a blank is not a claim. It has to
    /// say what it does.
    #[must_use]
    pub fn says(&self) -> Option<String> {
        self.query_text().map(|text| {
            if text.is_empty() {
                "every pod in the namespace".to_string()
            } else {
                text
            }
        })
    }
}

/// One `matchExpressions` entry, tested as `labels.Requirement.Matches` tests
/// it, or `None` for one `labels.NewRequirement` would refuse.
///
/// `NotIn` is satisfied by a key the object does not carry: it is not the
/// negation of `In`. A set operator with no values, a presence test with
/// some, an empty key and an unknown operator are refused, and a query this
/// app cannot read the way the cluster reads it is not answered with a guess.
fn requirement_matches(
    req: &LabelSelectorRequirement,
    labels: &BTreeMap<String, String>,
) -> Option<bool> {
    if req.key.is_empty() {
        return None;
    }
    let values = req.values.as_deref().unwrap_or_default();
    let value = labels.get(&req.key);
    match req.operator.as_str() {
        "In" | "NotIn" if values.is_empty() => None,
        "Exists" | "DoesNotExist" if !values.is_empty() => None,
        "In" => Some(value.is_some_and(|v| values.contains(v))),
        "NotIn" => Some(value.is_none_or(|v| !values.contains(v))),
        "Exists" => Some(value.is_some()),
        "DoesNotExist" => Some(value.is_none()),
        _ => None,
    }
}

/// A `LabelSelector` as the string `metav1.LabelSelectorAsSelector` produces:
/// every requirement sorted by key, values sorted inside a set, joined by
/// commas.
///
/// Sorted rather than written down in spec order so the same selector reads
/// the same on every page, and so a query key built from it does not change
/// when nothing did.
fn text_of(selector: &LabelSelector) -> String {
    let mut parts: Vec<(&str, String)> = selector
        .match_labels
        .iter()
        .flatten()
        .map(|(key, value)| (key.as_str(), format!("{key}={value}")))
        .collect();

    for req in selector.match_expressions.iter().flatten() {
        let mut values = req.values.clone().unwrap_or_default();
        values.sort();
        let key = &req.key;
        let text = match req.operator.as_str() {
            "In" => format!("{key} in ({})", values.join(",")),
            "NotIn" => format!("{key} notin ({})", values.join(",")),
            "DoesNotExist" => format!("!{key}"),
            // `Exists`, and anything this app does not know a form for: a
            // bare key is what a presence test is written as.
            _ => key.clone(),
        };
        parts.push((key.as_str(), text));
    }

    parts.sort_by(|a, b| a.0.cmp(b.0));
    parts
        .into_iter()
        .map(|(_, text)| text)
        .collect::<Vec<_>>()
        .join(",")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    fn requirement(key: &str, operator: &str, values: &[&str]) -> LabelSelectorRequirement {
        LabelSelectorRequirement {
            key: key.to_string(),
            operator: operator.to_string(),
            values: Some(values.iter().map(|v| (*v).to_string()).collect()),
        }
    }

    fn query(match_labels: &[(&str, &str)], reqs: Vec<LabelSelectorRequirement>) -> LabelSelector {
        LabelSelector {
            match_labels: (!match_labels.is_empty()).then(|| labels(match_labels)),
            match_expressions: (!reqs.is_empty()).then_some(reqs),
        }
    }

    /// The corpus is the answer both halves owe. Three evaluators gave three
    /// answers for `NotIn ()` — this one said no, the Prometheus and Cilium
    /// pages said yes to every object — and a case that drifts here drifts
    /// from the frontend too.
    #[test]
    fn every_selector_in_the_shared_corpus_answers_the_same() {
        const CORPUS: &str = include_str!("../../../shared/label-selector-conformance.json");
        let corpus: serde_json::Value = serde_json::from_str(CORPUS).unwrap();
        let cases = corpus["cases"].as_array().unwrap();
        assert!(cases.len() > 30, "the corpus lost its cases");
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let labels: BTreeMap<String, String> =
                serde_json::from_value(case["labels"].clone()).unwrap();
            let want = case["matches"].as_bool();
            // A shape the typed reader cannot take is a selector nothing here
            // can evaluate; the object carrying it would not have been read.
            let got = serde_json::from_value::<LabelSelector>(case["selector"].clone())
                .ok()
                .and_then(|selector| Selector::Query(Some(&selector)).matches(&labels));
            assert_eq!(got, want, "{name}");
        }
    }

    #[test]
    fn match_labels_and_match_expressions_are_anded() {
        let pod = labels(&[("app", "shop"), ("tier", "web")]);
        let both = query(
            &[("app", "shop")],
            vec![requirement("tier", "In", &["web", "api"])],
        );
        assert_eq!(Selector::Query(Some(&both)).matches(&pod), Some(true));

        let disagrees = query(
            &[("app", "other")],
            vec![requirement("tier", "In", &["web"])],
        );
        assert_eq!(Selector::Query(Some(&disagrees)).matches(&pod), Some(false));
    }

    #[test]
    fn a_label_with_an_empty_value_is_matched_by_an_empty_value() {
        let pod = labels(&[("blank", "")]);
        let selector = query(&[("blank", "")], vec![]);
        assert_eq!(Selector::Query(Some(&selector)).matches(&pod), Some(true));
        assert_eq!(
            Selector::Query(Some(&selector)).query_text().as_deref(),
            Some("blank=")
        );
    }

    /// The asymmetry a shared helper gets wrong. Both of these are "the
    /// selector is empty", and the two kinds mean the opposite by it.
    #[test]
    fn an_empty_selector_means_the_opposite_in_the_two_shapes() {
        let pod = labels(&[("app", "shop")]);

        // A Service with no selector publishes nothing it worked out itself.
        assert_eq!(
            Selector::Equality(&BTreeMap::new()).matches(&pod),
            Some(false)
        );
        assert_eq!(Selector::Equality(&BTreeMap::new()).query_text(), None);

        // A budget with `selector: {}` covers every pod in its namespace.
        let empty = query(&[], vec![]);
        assert_eq!(Selector::Query(Some(&empty)).matches(&pod), Some(true));
        assert_eq!(
            Selector::Query(Some(&empty)).query_text().as_deref(),
            Some("")
        );
        assert_eq!(
            Selector::Query(Some(&empty)).says().as_deref(),
            Some("every pod in the namespace")
        );

        // A budget with no selector at all matches no pods.
        assert_eq!(Selector::Query(None).matches(&pod), Some(false));
        assert_eq!(Selector::Query(None).query_text(), None);
    }

    /// The text is the query. A page that prints `selects app=shop` and a
    /// list call that asks the API server for the same pods must not be two
    /// spellings of one selector.
    #[test]
    fn the_text_is_the_form_the_api_server_takes() {
        let selector = query(
            &[("app", "shop")],
            vec![
                requirement("tier", "In", &["web", "api"]),
                requirement("track", "NotIn", &["canary"]),
                requirement("ready", "Exists", &[]),
                requirement("legacy", "DoesNotExist", &[]),
            ],
        );
        assert_eq!(
            Selector::Query(Some(&selector)).query_text().as_deref(),
            // By key — `!legacy` sorts under `legacy` — which is the order
            // `ByKey` gives it, not the order the spec wrote it in.
            Some("app=shop,!legacy,ready,tier in (api,web),track notin (canary)")
        );
    }

    #[test]
    fn a_service_selector_reads_as_the_equality_pairs_it_is() {
        let selector = labels(&[("app", "shop"), ("tier", "web")]);
        assert_eq!(
            Selector::Equality(&selector).query_text().as_deref(),
            Some("app=shop,tier=web")
        );
        assert_eq!(
            Selector::Equality(&selector).matches(&labels(&[
                ("app", "shop"),
                ("tier", "web"),
                ("pod-template-hash", "abc")
            ])),
            Some(true)
        );
        assert_eq!(
            Selector::Equality(&selector).matches(&labels(&[("app", "shop")])),
            Some(false)
        );
    }
}
