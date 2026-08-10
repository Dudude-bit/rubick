//! One label query, read the way the API server reads it.
//!
//! Every selector test in this app used to be `match_labels` and a subset
//! check, which answers "matches nothing" for the half of the API that uses
//! `matchExpressions` — and a Service chain that says *where the path stops*
//! cannot afford to say it stops at a selector that is working.
//!
//! Two shapes, because Kubernetes has two and they disagree about the empty
//! case. `metav1.LabelSelector` — a PodDisruptionBudget's, a workload's —
//! matches **everything** when it is `{}` and nothing when it is absent. A
//! Service's `spec.selector` is a plain `map[string]string` with no
//! expressions at all, and an empty one selects **nothing**: the endpoints are
//! written by hand, or the Service is an ExternalName. Collapsing the second
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
    /// Whether one object's labels satisfy this query.
    #[must_use]
    pub fn matches(&self, labels: &BTreeMap<String, String>) -> bool {
        match self {
            Self::Equality(selector) => {
                !selector.is_empty() && selector.iter().all(|(k, v)| labels.get(k) == Some(v))
            }
            Self::Query(None) => false,
            Self::Query(Some(selector)) => {
                selector
                    .match_labels
                    .iter()
                    .flatten()
                    .all(|(k, v)| labels.get(k) == Some(v))
                    && selector
                        .match_expressions
                        .iter()
                        .flatten()
                        .all(|req| requirement_matches(req, labels))
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
/// it.
///
/// The two asymmetries are the whole reason this is not a subset check.
/// `NotIn` is satisfied by a key the object does not carry — it is not the
/// negation of `In` — and a requirement the API server would refuse matches
/// nothing rather than being skipped: a query this app cannot read the way
/// the cluster reads it must not be answered with a guess.
fn requirement_matches(req: &LabelSelectorRequirement, labels: &BTreeMap<String, String>) -> bool {
    let values = req.values.as_deref().unwrap_or_default();
    match req.operator.as_str() {
        // An empty values list is invalid for both set operators; the API
        // server rejects it and so does every controller that reads one.
        "In" => !values.is_empty() && labels.get(&req.key).is_some_and(|v| values.contains(v)),
        "NotIn" => !values.is_empty() && labels.get(&req.key).is_none_or(|v| !values.contains(v)),
        // Presence, and only presence — the values are never compared. A
        // values list is invalid here for exactly that reason.
        "Exists" => values.is_empty() && labels.contains_key(&req.key),
        "DoesNotExist" => values.is_empty() && !labels.contains_key(&req.key),
        _ => false,
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

    /// The operator table, against what `kubectl get pods -l …` returns for
    /// the same requirement. Every row is a rule the old subset test had no
    /// way to express.
    #[test]
    fn every_operator_answers_what_kubectl_answers() {
        let pod = labels(&[("app", "shop"), ("tier", "web"), ("blank", "")]);

        // key, operator, values, expected
        let table: &[(&str, &str, &[&str], bool)] = &[
            ("tier", "In", &["web", "api"], true),
            ("tier", "In", &["api"], false),
            // A key the object does not carry is in no set at all.
            ("missing", "In", &["web"], false),
            ("tier", "NotIn", &["api", "worker"], true),
            ("tier", "NotIn", &["web"], false),
            // NotIn is not the negation of In: an absent key satisfies it.
            ("missing", "NotIn", &["web"], true),
            ("app", "Exists", &[], true),
            ("missing", "Exists", &[], false),
            // A label with an empty value is still a label that is there.
            ("blank", "Exists", &[], true),
            ("missing", "DoesNotExist", &[], true),
            ("app", "DoesNotExist", &[], false),
            // The API server refuses an empty values list on a set operator,
            // so neither form may quietly match.
            ("tier", "In", &[], false),
            ("tier", "NotIn", &[], false),
            // …and refuses values on a presence test, for the same reason.
            ("app", "Exists", &["shop"], false),
            ("missing", "DoesNotExist", &["shop"], false),
            // An operator no version of the API defines matches nothing.
            ("app", "Equals", &["shop"], false),
        ];

        for (key, operator, values, expected) in table {
            let selector = query(&[], vec![requirement(key, operator, values)]);
            assert_eq!(
                Selector::Query(Some(&selector)).matches(&pod),
                *expected,
                "{key} {operator} {values:?}"
            );
        }
    }

    #[test]
    fn match_labels_and_match_expressions_are_anded() {
        let pod = labels(&[("app", "shop"), ("tier", "web")]);
        let both = query(
            &[("app", "shop")],
            vec![requirement("tier", "In", &["web", "api"])],
        );
        assert!(Selector::Query(Some(&both)).matches(&pod));

        let disagrees = query(
            &[("app", "other")],
            vec![requirement("tier", "In", &["web"])],
        );
        assert!(!Selector::Query(Some(&disagrees)).matches(&pod));
    }

    #[test]
    fn a_label_with_an_empty_value_is_matched_by_an_empty_value() {
        let pod = labels(&[("blank", "")]);
        let selector = query(&[("blank", "")], vec![]);
        assert!(Selector::Query(Some(&selector)).matches(&pod));
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
        assert!(!Selector::Equality(&BTreeMap::new()).matches(&pod));
        assert_eq!(Selector::Equality(&BTreeMap::new()).query_text(), None);

        // A budget with `selector: {}` covers every pod in its namespace.
        let empty = query(&[], vec![]);
        assert!(Selector::Query(Some(&empty)).matches(&pod));
        assert_eq!(
            Selector::Query(Some(&empty)).query_text().as_deref(),
            Some("")
        );
        assert_eq!(
            Selector::Query(Some(&empty)).says().as_deref(),
            Some("every pod in the namespace")
        );

        // A budget with no selector at all matches no pods.
        assert!(!Selector::Query(None).matches(&pod));
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
        assert!(Selector::Equality(&selector).matches(&labels(&[
            ("app", "shop"),
            ("tier", "web"),
            ("pod-template-hash", "abc")
        ])));
        assert!(!Selector::Equality(&selector).matches(&labels(&[("app", "shop")])));
    }
}
