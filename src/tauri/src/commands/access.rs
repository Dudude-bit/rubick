//! Whether this user may list a kind, asked before they walk into the refusal.
//!
//! The answer comes from `SelfSubjectAccessReview` — the cluster's own
//! authorizer, not a reading of RBAC objects the app would have to interpret
//! for itself, so it cannot disagree with the call it is describing.
//!
//! It still is not the authority. The list call is: nothing here blocks a
//! click, and a row the review calls refused is marked rather than disabled.
//! A review that is wrong — an authorizer that admits more than RBAC says, a
//! webhook that admits less — costs a mark the real call then corrects,
//! instead of locking somebody out of a screen they could have used.

use futures::future::join_all;
use k8s_openapi::api::authorization::v1::{
    ResourceAttributes, SelfSubjectAccessReview, SelfSubjectAccessReviewSpec,
    SelfSubjectRulesReview, SelfSubjectRulesReviewSpec, SubjectRulesReviewStatus,
};
use kube::api::{Api, PostParams};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::helpers::ResourceContext;
use crate::error::Result;
use crate::state::AppState;

/// One question for the authorizer, in the terms the API server matches.
///
/// Asked in the caller's vocabulary rather than a kind this module would
/// have to interpret: the frontend registry already holds the plural, the
/// group and the scope, because it builds every URL from them. Sending a
/// name for this module to look up again would be a second copy of that
/// table, free to drift from the first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListQuery {
    /// The API group. Core resources have none — `""`, not `"v1"`.
    pub group: String,
    /// The plural the API server matches, such as `persistentvolumes`.
    pub resource: String,
    /// Whether this kind lives inside a namespace at all.
    pub namespaced: bool,
}

/// What the authorizer said about one of those questions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListAccess {
    pub resource: String,
    /// `None` where the cluster could not be asked at all — an authorizer
    /// that does not answer is not an authorizer that refused, and drawing
    /// the two the same way would put "no access" on every row of a cluster
    /// that simply predates the API.
    pub allowed: Option<bool>,
}

/// The attributes that ask "may I list this, here".
/// One verb on one resource, where a page is about to offer a button.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessQuery {
    pub group: String,
    pub resource: String,
    pub verb: String,
    pub namespace: Option<String>,
    /// The part of the object the verb reaches: `exec` in `pods/exec`.
    #[serde(default)]
    pub subresource: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessAnswer {
    pub verb: String,
    pub resource: String,
    /// `None` where the cluster would not say, which is not "no".
    pub allowed: Option<bool>,
}

/// Ask before drawing a control that a 403 would otherwise answer on click.
#[tauri::command]
pub async fn check_access(
    queries: Vec<AccessQuery>,
    state: State<'_, AppState>,
) -> Result<Vec<AccessAnswer>> {
    let ctx = ResourceContext::for_list(&state, None)?;
    let api: Api<SelfSubjectAccessReview> = Api::all(ctx.client.clone());
    let answers = join_all(queries.iter().map(|query| {
        let api = api.clone();
        let attributes = access_attributes(query);
        async move { ask(&api, attributes).await }
    }))
    .await;
    Ok(queries
        .into_iter()
        .zip(answers)
        .map(|(query, allowed)| AccessAnswer {
            verb: query.verb,
            resource: query.resource,
            allowed,
        })
        .collect())
}

/// A subresource rides in its own field: RBAC matches `pods/exec` from the
/// two, and a rule for `*/exec` only matches when they arrive apart.
#[must_use]
fn access_attributes(query: &AccessQuery) -> ResourceAttributes {
    ResourceAttributes {
        group: Some(query.group.clone()),
        resource: Some(query.resource.clone()),
        subresource: query.subresource.clone(),
        verb: Some(query.verb.clone()),
        namespace: query.namespace.clone(),
        ..ResourceAttributes::default()
    }
}

#[must_use]
fn list_attributes(query: &ListQuery, namespace: Option<&str>) -> ResourceAttributes {
    ResourceAttributes {
        group: Some(query.group.clone()),
        resource: Some(query.resource.clone()),
        verb: Some("list".to_string()),
        // A cluster-scoped kind is not "in" a namespace, and naming one asks
        // a different question than the list call will ask.
        namespace: namespace
            .filter(|_| query.namespaced)
            .map(ToString::to_string),
        ..ResourceAttributes::default()
    }
}

/// Ask the cluster which of these kinds this user may list.
///
/// `namespaces` is the selection the reader is looking at. A kind counts as
/// listable when *any* of them allows it, because that is what the row leads
/// to: a list with those namespaces' objects in it. Asking cluster-wide
/// instead would refuse a reader who holds rights in their own two
/// namespaces and none outside them — which is the shape most restricted
/// accounts have.
///
/// An empty selection means every namespace, which is a question with no
/// namespace in it.
///
/// # Errors
///
/// If there is no connected cluster. A review that fails on its own answers
/// `None` for that kind rather than failing the batch: one kind the API
/// server would not answer about should not cost the answers for the rest.
#[tauri::command]
pub async fn check_list_access(
    queries: Vec<ListQuery>,
    namespaces: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<ListAccess>> {
    let ctx = ResourceContext::for_list(&state, None)?;
    let api: Api<SelfSubjectAccessReview> = Api::all(ctx.client.clone());

    // Asked at once: a review per kind per namespace in sequence is a visible
    // pause on a remote cluster, and none of them depends on another.
    let answers = join_all(queries.iter().map(|query| {
        let api = api.clone();
        let asked = places_to_ask(query, &namespaces);
        async move {
            let each = join_all(
                asked
                    .into_iter()
                    .map(|namespace| ask(&api, list_attributes(query, namespace.as_deref()))),
            )
            .await;
            resolve(&each)
        }
    }))
    .await;

    Ok(queries
        .into_iter()
        .zip(answers)
        .map(|(query, allowed)| ListAccess {
            resource: query.resource,
            allowed,
        })
        .collect())
}

/// Whether this user may use a namespace at all.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamespaceAccess {
    pub namespace: String,
    /// `None` where the cluster could not be asked — never folded into a
    /// refusal. A namespace the app merely failed to check must keep being
    /// offered, or it would vanish from the picker as if the reader had been
    /// turned away from it.
    pub allowed: Option<bool>,
    /// Asked only where pods were refused: whether anything else may be
    /// listed there. Marco's team-blind refused pods and served Deployments,
    /// Services and Events, and was hidden as if it served nothing.
    pub other_lists: Option<bool>,
}

/// The one list a namespace is probed with: pods, the verb any grant that
/// makes a namespace worth selecting carries. One named place, spelled once.
#[must_use]
fn namespace_probe_query() -> ListQuery {
    ListQuery {
        group: String::new(),
        resource: "pods".to_string(),
        namespaced: true,
    }
}

/// Ask the cluster which of these namespaces this user may use.
///
/// One review per namespace — "may I list pods in it" — asked at once. A
/// namespace the authorizer will not answer about comes back `None`, kept
/// offered rather than hidden: the same three-state discipline as
/// [`check_list_access`].
///
/// # Errors
///
/// If there is no connected cluster.
#[tauri::command]
pub async fn check_namespace_access(
    namespaces: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<NamespaceAccess>> {
    let ctx = ResourceContext::for_list(&state, None)?;
    let api: Api<SelfSubjectAccessReview> = Api::all(ctx.client.clone());
    let probe = namespace_probe_query();

    let answers = join_all(namespaces.iter().map(|namespace| {
        let api = api.clone();
        let attributes = list_attributes(&probe, Some(namespace));
        async move { ask(&api, attributes).await }
    }))
    .await;
    let rules: Api<SelfSubjectRulesReview> = Api::all(ctx.client.clone());
    let others = join_all(namespaces.iter().zip(&answers).map(|(namespace, allowed)| {
        let rules = rules.clone();
        async move {
            if *allowed != Some(false) {
                return None;
            }
            review(&rules, namespace)
                .await
                .ok()
                .and_then(|answered| lists_something(&own_rules(namespace.clone(), answered)))
        }
    }))
    .await;

    Ok(namespaces
        .into_iter()
        .zip(answers)
        .zip(others)
        .map(|((namespace, allowed), other_lists)| NamespaceAccess {
            namespace,
            allowed,
            other_lists,
        })
        .collect())
}

/// Whether the rules grant listing anything at all; unknown where none does
/// and the authorizer said its rules were incomplete.
fn lists_something(rules: &OwnRules) -> Option<bool> {
    let lists = rules.rules.iter().any(|rule| {
        !rule.resources.is_empty() && rule.verbs.iter().any(|verb| verb == "list" || verb == "*")
    });
    if lists {
        Some(true)
    } else if rules.incomplete {
        None
    } else {
        Some(false)
    }
}

/// The namespaces one kind has to be asked about.
///
/// A cluster-scoped kind has exactly one answer however many namespaces are
/// selected, and so does an empty selection.
fn places_to_ask(query: &ListQuery, namespaces: &[String]) -> Vec<Option<String>> {
    if !query.namespaced || namespaces.is_empty() {
        return vec![None];
    }
    namespaces.iter().map(|name| Some(name.clone())).collect()
}

/// One allowed if any namespace allows it; unknown only when nothing answered.
fn resolve(answers: &[Option<bool>]) -> Option<bool> {
    if answers.iter().any(|answer| answer == &Some(true)) {
        return Some(true);
    }
    if answers.iter().any(Option::is_some) {
        return Some(false);
    }
    None
}

async fn ask(api: &Api<SelfSubjectAccessReview>, attributes: ResourceAttributes) -> Option<bool> {
    let review = SelfSubjectAccessReview {
        spec: SelfSubjectAccessReviewSpec {
            resource_attributes: Some(attributes),
            ..SelfSubjectAccessReviewSpec::default()
        },
        ..SelfSubjectAccessReview::default()
    };
    api.create(&PostParams::default(), &review)
        .await
        .ok()
        .and_then(|answered| answered.status)
        .map(|status| status.allowed)
}

/// One rule the authorizer says this user holds: a resource rule, or a
/// non-resource one when `non_resource_urls` is set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnRule {
    pub api_groups: Vec<String>,
    pub resources: Vec<String>,
    pub resource_names: Vec<String>,
    pub non_resource_urls: Vec<String>,
    pub verbs: Vec<String>,
}

/// What this user may do in one namespace, as `SelfSubjectRulesReview` says.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnRules {
    pub namespace: String,
    pub rules: Vec<OwnRule>,
    /// An authorizer could not list its rules; the user may hold more.
    pub incomplete: bool,
    pub evaluation_error: Option<String>,
}

/// The rules that apply to this user in `namespace`, cluster-wide ones included.
#[tauri::command]
pub async fn review_own_rules(namespace: String, state: State<'_, AppState>) -> Result<OwnRules> {
    crate::validation::validate_dns_label(&namespace)?;
    let ctx = ResourceContext::for_list(&state, None)?;
    let api: Api<SelfSubjectRulesReview> = Api::all(ctx.client.clone());
    let answered = review(&api, &namespace).await?;
    Ok(own_rules(namespace, answered))
}

async fn review(
    api: &Api<SelfSubjectRulesReview>,
    namespace: &str,
) -> kube::Result<Option<SubjectRulesReviewStatus>> {
    let review = SelfSubjectRulesReview {
        spec: SelfSubjectRulesReviewSpec {
            namespace: Some(namespace.to_string()),
        },
        ..SelfSubjectRulesReview::default()
    };
    Ok(api.create(&PostParams::default(), &review).await?.status)
}

/// A review answered without a status said nothing, which is not "no rules".
fn own_rules(namespace: String, status: Option<SubjectRulesReviewStatus>) -> OwnRules {
    let Some(status) = status else {
        return OwnRules {
            namespace,
            rules: Vec::new(),
            incomplete: true,
            evaluation_error: None,
        };
    };
    let resource = status.resource_rules.into_iter().map(|rule| OwnRule {
        api_groups: rule.api_groups.unwrap_or_default(),
        resources: rule.resources.unwrap_or_default(),
        resource_names: rule.resource_names.unwrap_or_default(),
        non_resource_urls: Vec::new(),
        verbs: rule.verbs,
    });
    let non_resource = status.non_resource_rules.into_iter().map(|rule| OwnRule {
        api_groups: Vec::new(),
        resources: Vec::new(),
        resource_names: Vec::new(),
        non_resource_urls: rule.non_resource_urls.unwrap_or_default(),
        verbs: rule.verbs,
    });
    OwnRules {
        namespace,
        rules: resource.chain(non_resource).collect(),
        incomplete: status.incomplete,
        evaluation_error: status.evaluation_error.filter(|error| !error.is_empty()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A webhook authorizer that cannot list rules sets `incomplete`; dropping
    /// it would present a partial list as everything the user may do.
    #[test]
    fn a_rules_review_keeps_its_incomplete_flag_and_evaluation_error() {
        let status: SubjectRulesReviewStatus = serde_json::from_value(serde_json::json!({
            "incomplete": true,
            "evaluationError": "webhook authorizer does not list rules",
            "resourceRules": [{ "apiGroups": [""], "resources": ["pods"], "verbs": ["get", "list"] }],
            "nonResourceRules": [{ "nonResourceURLs": ["/healthz"], "verbs": ["get"] }],
        }))
        .expect("status");
        let rules = own_rules("team-checkout".to_string(), Some(status));
        assert!(rules.incomplete);
        assert_eq!(
            rules.evaluation_error.as_deref(),
            Some("webhook authorizer does not list rules")
        );
        assert_eq!(rules.rules.len(), 2);
        assert_eq!(rules.rules[0].resources, ["pods"]);
        assert_eq!(rules.rules[1].non_resource_urls, ["/healthz"]);
    }

    /// Marco's team-blind refused pods and served Deployments and Services,
    /// and the picker hid it as if nothing there could be read. Fails if a
    /// namespace with any list allowed reads as shut, or an incomplete review
    /// that shows none reads as shut rather than unknown.
    #[test]
    fn a_namespace_that_lists_anything_is_not_shut() {
        let status = |incomplete: bool, rules: serde_json::Value| {
            let status: SubjectRulesReviewStatus = serde_json::from_value(serde_json::json!({
                "incomplete": incomplete,
                "resourceRules": rules,
                "nonResourceRules": [{ "nonResourceURLs": ["/api"], "verbs": ["get"] }],
            }))
            .expect("status");
            own_rules("team-blind".to_string(), Some(status))
        };
        let basic = serde_json::json!([
            { "apiGroups": ["authorization.k8s.io"], "resources": ["selfsubjectaccessreviews"], "verbs": ["create"] }
        ]);
        let deployments = serde_json::json!([
            { "apiGroups": ["apps"], "resources": ["deployments"], "verbs": ["get", "list", "watch"] }
        ]);
        assert_eq!(lists_something(&status(false, deployments)), Some(true));
        assert_eq!(lists_something(&status(false, basic.clone())), Some(false));
        assert_eq!(lists_something(&status(true, basic)), None);
    }

    /// No status at all is an answer nobody gave, and must not read as no rules.
    #[test]
    fn a_rules_review_without_a_status_is_incomplete() {
        let rules = own_rules("team-checkout".to_string(), None);
        assert!(rules.incomplete);
        assert!(rules.rules.is_empty());
    }

    fn query(group: &str, resource: &str, namespaced: bool) -> ListQuery {
        ListQuery {
            group: group.to_string(),
            resource: resource.to_string(),
            namespaced,
        }
    }

    /// Debug asks `patch pods/ephemeralcontainers`. Folded into the resource
    /// it would ask about a resource no rule names; dropped it would ask
    /// about patching the pod itself, a different right.
    #[test]
    fn an_access_question_keeps_its_subresource_apart() {
        let query: AccessQuery = serde_json::from_value(serde_json::json!({
            "group": "",
            "resource": "pods",
            "subresource": "ephemeralcontainers",
            "verb": "patch",
            "namespace": "team-checkout",
        }))
        .expect("query");
        let asked = access_attributes(&query);
        assert_eq!(asked.resource.as_deref(), Some("pods"));
        assert_eq!(asked.subresource.as_deref(), Some("ephemeralcontainers"));
        assert_eq!(asked.verb.as_deref(), Some("patch"));
        assert_eq!(asked.namespace.as_deref(), Some("team-checkout"));
    }

    /// A question about the object itself still arrives without one.
    #[test]
    fn an_access_question_without_a_subresource_asks_about_the_object() {
        let query: AccessQuery = serde_json::from_value(serde_json::json!({
            "group": "apps",
            "resource": "deployments",
            "verb": "delete",
            "namespace": null,
        }))
        .expect("query");
        assert_eq!(access_attributes(&query).subresource, None);
    }

    #[test]
    fn asks_in_the_terms_the_api_server_matches() {
        let core = list_attributes(&query("", "pods", true), Some("default"));
        assert_eq!(core.group.as_deref(), Some(""));
        assert_eq!(core.resource.as_deref(), Some("pods"));
        assert_eq!(core.verb.as_deref(), Some("list"));
        assert_eq!(core.namespace.as_deref(), Some("default"));
    }

    /// A cluster-scoped kind is not in a namespace. Naming one asks whether
    /// the user may list nodes *in* `default`, which is not the question the
    /// nav row stands for.
    #[test]
    fn leaves_the_namespace_off_a_cluster_scoped_kind() {
        assert_eq!(
            list_attributes(&query("", "nodes", false), Some("default")).namespace,
            None
        );
    }

    /// Every namespace at once is a question without a namespace in it, and
    /// the review answers it the same way the list call does.
    #[test]
    fn asks_across_every_namespace_when_none_is_chosen() {
        assert_eq!(
            list_attributes(&query("", "pods", true), None).namespace,
            None
        );
    }

    /// A reader who holds rights in their own two namespaces and none
    /// outside them is the shape most restricted accounts have. The row
    /// leads to a list of those namespaces, so one yes is a yes.
    #[test]
    fn one_namespace_that_allows_it_is_enough() {
        assert_eq!(resolve(&[Some(false), Some(true)]), Some(true));
        assert_eq!(resolve(&[Some(false), Some(false)]), Some(false));
    }

    /// An authorizer that did not answer is not an authorizer that refused.
    /// Folding the two together would mark every row of a cluster whose API
    /// could not be reached, which says something untrue about the reader.
    #[test]
    fn nothing_answering_is_not_a_refusal() {
        assert_eq!(resolve(&[None, None]), None);
        assert_eq!(resolve(&[]), None);
        assert_eq!(resolve(&[None, Some(true)]), Some(true));
        assert_eq!(resolve(&[None, Some(false)]), Some(false));
    }

    /// A namespace is probed by asking to list pods *in it* — a namespaced
    /// question, so the namespace stays on the attributes. Asking cluster-wide
    /// would answer whether the reader can list pods everywhere, which is the
    /// opposite of what a team-scoped account has.
    #[test]
    fn probes_a_namespace_by_listing_pods_in_it() {
        let attrs = list_attributes(&namespace_probe_query(), Some("team-a"));
        assert_eq!(attrs.group.as_deref(), Some(""));
        assert_eq!(attrs.resource.as_deref(), Some("pods"));
        assert_eq!(attrs.verb.as_deref(), Some("list"));
        assert_eq!(attrs.namespace.as_deref(), Some("team-a"));
    }

    #[test]
    fn asks_each_selected_namespace_but_a_cluster_kind_only_once() {
        let selection = ["a".to_string(), "b".to_string()];
        assert_eq!(
            places_to_ask(&query("", "pods", true), &selection),
            vec![Some("a".to_string()), Some("b".to_string())]
        );
        assert_eq!(
            places_to_ask(&query("", "nodes", false), &selection),
            vec![None]
        );
        assert_eq!(places_to_ask(&query("", "pods", true), &[]), vec![None]);
    }
}
