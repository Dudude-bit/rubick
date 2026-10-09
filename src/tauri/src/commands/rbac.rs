//! Who a binding grants which role: `RoleBinding` and `ClusterRoleBinding`
//! objects, read down to the two facts a reverse lookup needs.

use k8s_openapi::api::rbac::v1::{ClusterRoleBinding, RoleBinding, RoleRef, Subject};
use kube::api::{Api, ListParams};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::helpers::list_in_scope;
use crate::error::Result;
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
    let list = Api::<ClusterRoleBinding>::all(client)
        .list(&ListParams::default())
        .await?;
    Ok(list.items.iter().map(BindingInfo::from).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
