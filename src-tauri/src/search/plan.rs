//! Pure planning for a cross-cluster search: which contexts get
//! queried, which kinds, and what the caps are. No I/O — the whole
//! "what will this search cost and who will it touch" decision is
//! testable without a cluster.

use super::types::{
    SearchFailureKind, SearchRequest, SearchTarget, SearchableKind, DEFAULT_KINDS, SEARCHABLE_KINDS,
};
use crate::error::{Error, Result};
use std::collections::BTreeSet;

/// Shortest query that may be sent to a cluster. One character matches
/// most of a namespace and turns every keystroke into a full list of
/// every kind.
pub const MIN_QUERY_LEN: usize = 2;

/// Hits kept per cluster before the search stops early. Past this the
/// list is unreadable anyway, and the cluster stops paying for it.
pub const DEFAULT_LIMIT_PER_CONTEXT: u32 = 50;
pub const MAX_LIMIT_PER_CONTEXT: u32 = 500;

/// Objects fetched per kind per cluster. Kubernetes has no substring
/// match, so filtering happens here; this bounds what "here" costs.
pub const LIST_PAGE_LIMIT: u32 = 500;

/// Clusters queried at once. Four keeps a ten-cluster fan-out from
/// opening ten TLS handshakes and ten concurrent list storms.
pub const MAX_CONTEXT_CONCURRENCY: usize = 4;

/// Kind queries in flight within one cluster.
pub const MAX_KIND_CONCURRENCY: usize = 3;

/// Hard ceiling on contexts per search, so a malformed request cannot
/// fan out across a 200-context kubeconfig.
pub const MAX_CONTEXTS: usize = 16;

/// Case-insensitive substring match on name or namespace — the same
/// rule the palette applied client-side before the search moved here.
#[must_use]
pub fn matches(needle: &str, name: &str, namespace: Option<&str>) -> bool {
    let needle = needle.to_lowercase();
    name.to_lowercase().contains(&needle)
        || namespace.is_some_and(|ns| ns.to_lowercase().contains(&needle))
}

/// Validate and normalise the query text.
pub fn normalize_query(query: &str) -> Result<String> {
    let trimmed = query.trim();
    if trimmed.chars().count() < MIN_QUERY_LEN {
        return Err(Error::InvalidInput(format!(
            "Search query must be at least {MIN_QUERY_LEN} characters"
        )));
    }
    Ok(trimmed.to_string())
}

/// Resolve requested kind labels against the searchable table.
pub fn resolve_kinds(requested: Option<&[String]>) -> Result<Vec<&'static SearchableKind>> {
    let labels: Vec<String> = match requested {
        Some(list) if !list.is_empty() => list.to_vec(),
        _ => DEFAULT_KINDS.iter().map(|k| (*k).to_string()).collect(),
    };

    labels
        .iter()
        .map(|label| {
            SEARCHABLE_KINDS
                .iter()
                .find(|k| k.label.eq_ignore_ascii_case(label))
                .ok_or_else(|| Error::InvalidInput(format!("Kind '{label}' is not searchable")))
        })
        .collect()
}

/// Decide which context names a request refers to, before any of them
/// is looked at. `known` is the kubeconfig's context set, `current` the
/// active one.
pub fn resolve_context_names(
    request: &SearchRequest,
    known: &BTreeSet<String>,
    current: Option<&str>,
) -> Result<Vec<String>> {
    let names: Vec<String> = if request.all_contexts {
        known.iter().cloned().collect()
    } else if request.contexts.is_empty() {
        vec![current
            .ok_or_else(|| Error::Internal(crate::error::messages::NO_CLUSTER.to_string()))?
            .to_string()]
    } else {
        let mut seen = BTreeSet::new();
        request
            .contexts
            .iter()
            .map(|c| c.trim().to_string())
            .filter(|c| !c.is_empty() && seen.insert(c.clone()))
            .collect()
    };

    if names.is_empty() {
        return Err(Error::InvalidInput(
            "No cluster to search: name at least one context".to_string(),
        ));
    }
    if names.len() > MAX_CONTEXTS {
        return Err(Error::InvalidInput(format!(
            "Search asked for {} clusters; the limit is {MAX_CONTEXTS}",
            names.len()
        )));
    }
    Ok(names)
}

/// Assign each requested context its starting state.
///
/// The connect-on-demand policy lives here: a context with no live
/// client is only promoted to `Connecting` when the caller explicitly
/// asked for it (`connect`). Otherwise it comes back `Skipped` with
/// `NotConnected` — visible and offerable, never silently dropped.
#[must_use]
pub fn plan_targets(
    names: &[String],
    known: &BTreeSet<String>,
    live: &BTreeSet<String>,
    connect: bool,
) -> Vec<SearchTarget> {
    names
        .iter()
        .map(|name| {
            if !known.contains(name) {
                return SearchTarget::skipped(
                    name.clone(),
                    SearchFailureKind::UnknownContext,
                    format!("No context named '{name}' in your kubeconfig"),
                );
            }
            if live.contains(name) {
                return SearchTarget::searching(name.clone());
            }
            if connect {
                SearchTarget::connecting(name.clone())
            } else {
                SearchTarget::skipped(
                    name.clone(),
                    SearchFailureKind::NotConnected,
                    format!("'{name}' is not connected — searching it opens a connection"),
                )
            }
        })
        .collect()
}

/// Clamp the caller's per-cluster hit cap.
#[must_use]
pub fn clamp_limit(requested: Option<u32>) -> u32 {
    requested
        .unwrap_or(DEFAULT_LIMIT_PER_CONTEXT)
        .clamp(1, MAX_LIMIT_PER_CONTEXT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::search::SearchContextStatus;

    fn set(items: &[&str]) -> BTreeSet<String> {
        items.iter().map(|s| (*s).to_string()).collect()
    }

    fn request(contexts: &[&str]) -> SearchRequest {
        SearchRequest {
            query: "api".to_string(),
            contexts: contexts.iter().map(|s| (*s).to_string()).collect(),
            all_contexts: false,
            namespace: None,
            kinds: None,
            connect: false,
            limit_per_context: None,
        }
    }

    #[test]
    fn matches_name_or_namespace_case_insensitively() {
        assert!(matches("API", "api-server-0", None));
        assert!(matches("prod", "web", Some("prod-eu")));
        assert!(!matches("api", "web", Some("staging")));
    }

    #[test]
    fn query_shorter_than_the_minimum_is_rejected() {
        assert!(normalize_query("a").is_err());
        assert!(normalize_query("  a  ").is_err());
        assert_eq!(normalize_query("  api  ").unwrap(), "api");
    }

    #[test]
    fn empty_contexts_means_the_current_one() {
        let names = resolve_context_names(&request(&[]), &set(&["a", "b"]), Some("b")).unwrap();
        assert_eq!(names, vec!["b".to_string()]);
    }

    #[test]
    fn empty_contexts_with_no_current_cluster_errors() {
        let err = resolve_context_names(&request(&[]), &set(&["a"]), None).unwrap_err();
        assert!(matches!(err, Error::Internal(_)), "got {err:?}");
    }

    #[test]
    fn all_contexts_expands_to_the_kubeconfig() {
        let mut req = request(&["ignored"]);
        req.all_contexts = true;
        let names = resolve_context_names(&req, &set(&["a", "b", "c"]), Some("a")).unwrap();
        assert_eq!(names, vec!["a", "b", "c"]);
    }

    #[test]
    fn duplicate_context_names_are_searched_once() {
        let names =
            resolve_context_names(&request(&["a", "a", " a ", "b"]), &set(&["a", "b"]), None)
                .unwrap();
        assert_eq!(names, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn a_fan_out_wider_than_the_cap_is_refused() {
        let wide: Vec<String> = (0..MAX_CONTEXTS + 1).map(|i| format!("c{i}")).collect();
        let mut req = request(&[]);
        req.contexts = wide;
        let err = resolve_context_names(&req, &set(&["c0"]), None).unwrap_err();
        assert!(matches!(err, Error::InvalidInput(_)), "got {err:?}");
    }

    #[test]
    fn a_cold_context_is_skipped_unless_connecting_was_asked_for() {
        let names = vec!["prod".to_string()];
        let known = set(&["prod"]);
        let live = BTreeSet::new();

        let skipped = plan_targets(&names, &known, &live, false);
        assert_eq!(skipped[0].status, SearchContextStatus::Skipped);
        assert_eq!(skipped[0].reason, Some(SearchFailureKind::NotConnected));
        assert!(
            skipped[0]
                .message
                .as_deref()
                .is_some_and(|m| m.contains("prod")),
            "the skip message must name the cluster: {:?}",
            skipped[0].message
        );
        assert!(!skipped[0].is_active());

        let connecting = plan_targets(&names, &known, &live, true);
        assert_eq!(connecting[0].status, SearchContextStatus::Connecting);
        assert!(connecting[0].is_active());
    }

    #[test]
    fn a_live_context_searches_immediately_even_without_the_connect_flag() {
        let targets = plan_targets(&["dev".to_string()], &set(&["dev"]), &set(&["dev"]), false);
        assert_eq!(targets[0].status, SearchContextStatus::Searching);
    }

    #[test]
    fn a_context_missing_from_the_kubeconfig_says_so() {
        let targets = plan_targets(&["typo".to_string()], &set(&["dev"]), &set(&["dev"]), true);
        assert_eq!(targets[0].status, SearchContextStatus::Skipped);
        assert_eq!(targets[0].reason, Some(SearchFailureKind::UnknownContext));
    }

    #[test]
    fn default_kinds_resolve_and_unknown_kinds_are_rejected() {
        let kinds = resolve_kinds(None).unwrap();
        assert_eq!(kinds.len(), DEFAULT_KINDS.len());
        assert!(kinds.iter().any(|k| k.label == "Pod"));

        let explicit = resolve_kinds(Some(&["pod".to_string()])).unwrap();
        assert_eq!(explicit.len(), 1);
        assert_eq!(explicit[0].label, "Pod");

        assert!(resolve_kinds(Some(&["Widget".to_string()])).is_err());
    }

    #[test]
    fn limits_are_clamped_into_range() {
        assert_eq!(clamp_limit(None), DEFAULT_LIMIT_PER_CONTEXT);
        assert_eq!(clamp_limit(Some(0)), 1);
        assert_eq!(clamp_limit(Some(10_000)), MAX_LIMIT_PER_CONTEXT);
        assert_eq!(clamp_limit(Some(25)), 25);
    }
}
