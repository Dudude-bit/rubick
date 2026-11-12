//! Who a binding grants which role: `RoleBinding` and `ClusterRoleBinding`
//! objects, read down to the two facts a reverse lookup needs, and which
//! `ClusterRole` the control plane copies into which.

use k8s_openapi::api::rbac::v1::{ClusterRole, ClusterRoleBinding, RoleBinding, RoleRef, Subject};
use kube::api::{Api, ListParams};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::helpers::list_in_scope;
use crate::error::Result;
use crate::resources::Selector;
use crate::state::AppState;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubjectInfo {
    pub kind: String,
    pub name: String,
    pub namespace: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleRefInfo {
    pub kind: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingInfo {
    pub kind: String,
    pub name: String,
    pub namespace: Option<String>,
    pub role_ref: RoleRefInfo,
    pub subjects: Vec<SubjectInfo>,
}

fn binding(
    kind: &str,
    metadata: &kube::api::ObjectMeta,
    role_ref: &RoleRef,
    subjects: Option<&Vec<Subject>>,
) -> BindingInfo {
    BindingInfo {
        kind: kind.to_string(),
        name: metadata.name.clone().unwrap_or_default(),
        namespace: metadata.namespace.clone(),
        role_ref: RoleRefInfo {
            kind: role_ref.kind.clone(),
            name: role_ref.name.clone(),
        },
        subjects: subjects
            .into_iter()
            .flatten()
            .map(|subject| SubjectInfo {
                kind: subject.kind.clone(),
                name: subject.name.clone(),
                namespace: subject.namespace.clone(),
            })
            .collect(),
    }
}

impl From<&RoleBinding> for BindingInfo {
    fn from(object: &RoleBinding) -> Self {
        binding(
            "RoleBinding",
            &object.metadata,
            &object.role_ref,
            object.subjects.as_ref(),
        )
    }
}

impl From<&ClusterRoleBinding> for BindingInfo {
    fn from(object: &ClusterRoleBinding) -> Self {
        binding(
            "ClusterRoleBinding",
            &object.metadata,
            &object.role_ref,
            object.subjects.as_ref(),
        )
    }
}

list_in_scope!(list_role_bindings_in, RoleBinding, BindingInfo);

#[tauri::command]
pub async fn list_cluster_role_bindings(state: State<'_, AppState>) -> Result<Vec<BindingInfo>> {
    let client = (*state.current_client()?).clone();
    let list = crate::client::clock::timed(
        &state.perf,
        "listClusterRoleBindings",
        Api::<ClusterRoleBinding>::all(client).list(&ListParams::default()),
    )
    .await?;
    Ok(list.items.iter().map(BindingInfo::from).collect())
}

/// A `ClusterRole` the control plane fills with the rules of others: whoever
/// is bound to it holds the rules of every role it gathers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AggregationInfo {
    pub role: String,
    /// The roles its selectors pick. `None` where one of them could not be
    /// evaluated, which is not a role that gathers nothing.
    pub gathers: Option<Vec<String>>,
}

/// Each aggregating role with the roles it gathers, as the aggregation
/// controller picks them: any selector matching, itself excepted.
#[must_use]
fn aggregations(roles: &[ClusterRole]) -> Vec<AggregationInfo> {
    roles
        .iter()
        .filter_map(|role| {
            let selectors = role
                .aggregation_rule
                .as_ref()?
                .cluster_role_selectors
                .as_ref()?;
            let name = role.metadata.name.as_ref()?;
            let gathers = roles
                .iter()
                .filter(|other| other.metadata.name.as_ref() != Some(name))
                .try_fold(Vec::new(), |mut gathered, other| {
                    let labels = other.metadata.labels.clone().unwrap_or_default();
                    let picked = selectors.iter().try_fold(false, |any, selector| {
                        Some(any | Selector::Query(Some(selector)).matches(&labels)?)
                    })?;
                    if picked {
                        gathered.push(other.metadata.name.clone().unwrap_or_default());
                    }
                    Some(gathered)
                });
            Some(AggregationInfo {
                role: name.clone(),
                gathers,
            })
        })
        .collect()
}

/// Which `ClusterRole`s aggregate which. A role nothing binds may still
/// reach subjects through `view`, `edit` or `admin`.
#[tauri::command]
pub async fn list_cluster_role_aggregation(
    state: State<'_, AppState>,
) -> Result<Vec<AggregationInfo>> {
    let client = (*state.current_client()?).clone();
    let list = crate::client::clock::timed(
        &state.perf,
        "listClusterRoleAggregation",
        Api::<ClusterRole>::all(client).list(&ListParams::default()),
    )
    .await?;
    Ok(aggregations(&list.items))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn role(value: serde_json::Value) -> ClusterRole {
        serde_json::from_value(value).expect("cluster role")
    }

    /// `system:aggregate-to-edit` is bound by nobody and held by everyone
    /// bound to `edit`, and through `edit` by `admin`'s subjects. Fails if a
    /// role gathers itself, one no selector picks, or by all selectors at once.
    #[test]
    fn an_aggregating_role_gathers_the_roles_any_of_its_selectors_picks() {
        let label = |to: &str| format!("rbac.authorization.k8s.io/aggregate-to-{to}");
        let roles = [
            role(json!({
                "metadata": { "name": "edit", "labels": { label("admin"): "true", label("edit"): "true" } },
                "aggregationRule": { "clusterRoleSelectors": [
                    { "matchLabels": { label("edit"): "true" } },
                    { "matchLabels": { "team": "platform" } },
                ] },
            })),
            role(json!({
                "metadata": { "name": "admin" },
                "aggregationRule": { "clusterRoleSelectors": [{ "matchLabels": { label("admin"): "true" } }] },
            })),
            role(json!({
                "metadata": { "name": "widgets-editor", "labels": { label("edit"): "true" } },
            })),
            role(
                json!({ "metadata": { "name": "platform-extras", "labels": { "team": "platform" } } }),
            ),
            role(json!({ "metadata": { "name": "view" } })),
        ];
        assert_eq!(
            aggregations(&roles),
            vec![
                AggregationInfo {
                    role: "edit".into(),
                    gathers: Some(vec!["widgets-editor".into(), "platform-extras".into()]),
                },
                AggregationInfo {
                    role: "admin".into(),
                    gathers: Some(vec!["edit".into()]),
                },
            ]
        );
    }

    /// A selector Kubernetes would refuse to build picks an unknown set of
    /// roles. Fails if it is answered as a role that gathers none.
    #[test]
    fn a_selector_that_cannot_be_evaluated_is_not_a_role_that_gathers_nothing() {
        let roles = [
            role(json!({
                "metadata": { "name": "odd" },
                "aggregationRule": { "clusterRoleSelectors": [
                    { "matchExpressions": [{ "key": "tier", "operator": "Near", "values": ["a"] }] },
                ] },
            })),
            role(json!({ "metadata": { "name": "other", "labels": { "tier": "a" } } })),
        ];
        assert_eq!(
            aggregations(&roles),
            vec![AggregationInfo {
                role: "odd".into(),
                gathers: None
            }]
        );
    }

    /// A binding with no subjects is legal and binds nobody; it must not be
    /// dropped or fail the whole list.
    #[test]
    fn a_binding_reads_as_its_role_and_subjects() {
        let object: RoleBinding = serde_json::from_value(json!({
            "metadata": { "name": "marco-developer", "namespace": "team-checkout" },
            "roleRef": { "apiGroup": "rbac.authorization.k8s.io", "kind": "Role", "name": "developer" },
            "subjects": [{ "kind": "ServiceAccount", "name": "marco", "namespace": "team-checkout" }],
        }))
        .expect("binding");
        let info = BindingInfo::from(&object);
        assert_eq!(info.kind, "RoleBinding");
        assert_eq!(info.namespace.as_deref(), Some("team-checkout"));
        assert_eq!(
            info.role_ref,
            RoleRefInfo {
                kind: "Role".into(),
                name: "developer".into()
            }
        );
        assert_eq!(info.subjects[0].name, "marco");

        let empty: ClusterRoleBinding = serde_json::from_value(json!({
            "metadata": { "name": "nobody" },
            "roleRef": { "apiGroup": "rbac.authorization.k8s.io", "kind": "ClusterRole", "name": "view" },
        }))
        .expect("binding");
        let info = BindingInfo::from(&empty);
        assert_eq!(info.kind, "ClusterRoleBinding");
        assert!(info.subjects.is_empty());
    }
}
