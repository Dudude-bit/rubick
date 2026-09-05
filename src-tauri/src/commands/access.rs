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

#[cfg(test)]
mod tests {
    use super::*;

    fn query(group: &str, resource: &str, namespaced: bool) -> ListQuery {
        ListQuery {
            group: group.to_string(),
            resource: resource.to_string(),
            namespaced,
        }
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
