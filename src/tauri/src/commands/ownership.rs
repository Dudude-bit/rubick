//! The ownership tree of any object: its controllers up to the top, what it
//! owns, and what deleting it would take with it.

use k8s_openapi::apimachinery::pkg::apis::meta::v1::{ObjectMeta, OwnerReference};
use kube::api::{Api, DynamicObject};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::client::served::Served;
use crate::commands::helpers::{scope_of, ResourceContext};
use crate::error::{Error, Result};
use crate::ownership::{Dependent, KindCount, NotRead};
use crate::state::AppState;

/// Deeper than any controller chain a cluster builds; a loop stops here.
const MAX_DEPTH: usize = 8;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dependents {
    pub dependents: Vec<Dependent>,
    pub not_read: NotRead,
}

/// What `uid` owns directly. Starts the index on first use.
#[tauri::command]
pub async fn list_dependents(
    uid: String,
    scope: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<Dependents> {
    validate_uid(&uid)?;
    let index = state.ownership.ensure(&state, scope_of(scope)?).await?;
    let (dependents, not_read) = index.dependents(&uid);
    Ok(Dependents {
        dependents,
        not_read,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cascade {
    pub takes: Vec<KindCount>,
    pub not_read: NotRead,
}

/// What deleting `uid` would take with it, as the garbage collector decides.
#[tauri::command]
pub async fn preview_cascade(
    uid: String,
    scope: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<Cascade> {
    validate_uid(&uid)?;
    let index = state.ownership.ensure(&state, scope_of(scope)?).await?;
    let (takes, not_read) = index.cascade(&uid);
    Ok(Cascade { takes, not_read })
}

fn validate_uid(uid: &str) -> Result<()> {
    if uid.is_empty()
        || uid.len() > 64
        || !uid.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err(Error::InvalidInput(format!("'{uid}' is not a uid")));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ancestor {
    pub uid: String,
    pub kind: String,
    pub group: String,
    pub plural: String,
    pub name: String,
    pub namespace: Option<String>,
}

/// An owner the chain did not follow: not the controller.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OtherOwner {
    pub kind: String,
    pub group: String,
    pub name: String,
}

/// Why the chain ends where it does, when it is not the top.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "says", rename_all = "camelCase")]
pub enum LineageStop {
    /// The reference names an object that is gone, or one with the same name
    /// and another uid: the owner it meant was deleted.
    OwnerGone {
        kind: String,
        name: String,
    },
    OwnerUnread {
        kind: String,
        name: String,
        code: String,
        message: String,
    },
    /// The owner's kind is not served here.
    KindNotServed {
        kind: String,
        group: String,
    },
    /// Several owners and none of them the controller: no one chain.
    Several,
    TooDeep,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lineage {
    /// The object's own uid, which its dependents are found by.
    pub uid: Option<String>,
    /// Controllers above it, nearest first.
    pub ancestors: Vec<Ancestor>,
    pub others: Vec<OtherOwner>,
    pub stop: Option<LineageStop>,
}

fn group_of(api_version: &str) -> &str {
    api_version.split_once('/').map_or("", |(group, _)| group)
}

/// The owner a chain follows: the controller, or the only owner there is.
fn followed(owners: &[OwnerReference]) -> std::result::Result<Option<&OwnerReference>, ()> {
    if let Some(controller) = owners.iter().find(|o| o.controller == Some(true)) {
        return Ok(Some(controller));
    }
    match owners {
        [] => Ok(None),
        [only] => Ok(Some(only)),
        _ => Err(()),
    }
}

async fn metadata(
    state: &AppState,
    served: &Served,
    name: &str,
    namespace: Option<String>,
) -> Result<ObjectMeta> {
    let api: Api<DynamicObject> = if served.namespaced {
        ResourceContext::for_command(state, namespace)?
            .dynamic_api_for_resource(&served.resource, false)
    } else {
        ResourceContext::for_list(state, None)?.dynamic_api_for_resource(&served.resource, true)
    };
    let answer = api.get_metadata(name).await;
    Ok(state
        .served_answer(&served.resource.group, answer)?
        .metadata)
}

/// The controllers above one object, read a GET a level, each checked by uid.
#[tauri::command]
pub async fn object_lineage(
    group: String,
    plural: String,
    name: String,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> Result<Lineage> {
    crate::validation::validate_path_segment(&name)?;
    if !group.is_empty() {
        crate::validation::validate_dns_subdomain(&group)?;
    }
    crate::validation::validate_dns_label(&plural)?;
    let served = state
        .served(&group, &plural)
        .await?
        .ok_or_else(|| Error::not_found("APIResource", plural.clone(), ""))?;
    let subject = metadata(&state, &served, &name, namespace.clone()).await?;
    lineage_of(&state, subject, namespace).await
}

async fn lineage_of(
    state: &AppState,
    subject: ObjectMeta,
    namespace: Option<String>,
) -> Result<Lineage> {
    let owners = subject.owner_references.clone().unwrap_or_default();
    let mut lineage = Lineage {
        uid: subject.uid.clone(),
        ancestors: Vec::new(),
        others: owners
            .iter()
            .filter(|owner| owner.controller != Some(true))
            .filter(|_| owners.len() > 1)
            .map(|owner| OtherOwner {
                kind: owner.kind.clone(),
                group: group_of(&owner.api_version).to_string(),
                name: owner.name.clone(),
            })
            .collect(),
        stop: None,
    };
    let Ok(first) = followed(&owners) else {
        lineage.stop = Some(LineageStop::Several);
        return Ok(lineage);
    };
    let mut next = first.cloned();
    let mut child_namespace = namespace;
    while let Some(owner) = next.take() {
        if lineage.ancestors.len() == MAX_DEPTH {
            lineage.stop = Some(LineageStop::TooDeep);
            break;
        }
        let group = group_of(&owner.api_version).to_string();
        let unread = |error: &Error| LineageStop::OwnerUnread {
            kind: owner.kind.clone(),
            name: owner.name.clone(),
            code: error.code().to_string(),
            message: error.to_string(),
        };
        let kinds = match state.served_kinds(&group).await {
            Ok(kinds) => kinds.unwrap_or_default(),
            Err(error) => {
                lineage.stop = Some(unread(&error));
                break;
            }
        };
        let Some(kind) = kinds.into_iter().find(|kind| kind.kind == owner.kind) else {
            lineage.stop = Some(LineageStop::KindNotServed {
                kind: owner.kind.clone(),
                group,
            });
            break;
        };
        let served = match state.served(&group, &kind.plural).await {
            Ok(Some(served)) => served,
            Ok(None) => {
                lineage.stop = Some(LineageStop::KindNotServed {
                    kind: owner.kind.clone(),
                    group,
                });
                break;
            }
            Err(error) => {
                lineage.stop = Some(unread(&error));
                break;
            }
        };
        let owner_namespace = if served.namespaced {
            child_namespace.clone()
        } else {
            None
        };
        match metadata(state, &served, &owner.name, owner_namespace.clone()).await {
            Ok(meta) if meta.uid.as_deref() == Some(owner.uid.as_str()) => {
                lineage.ancestors.push(Ancestor {
                    uid: owner.uid.clone(),
                    kind: owner.kind.clone(),
                    group: group.clone(),
                    plural: kind.plural.clone(),
                    name: owner.name.clone(),
                    namespace: owner_namespace.clone(),
                });
                match followed(meta.owner_references.as_deref().unwrap_or_default()) {
                    Ok(found) => next = found.cloned(),
                    Err(()) => lineage.stop = Some(LineageStop::Several),
                }
                child_namespace = owner_namespace;
            }
            Ok(_) => {
                lineage.stop = Some(LineageStop::OwnerGone {
                    kind: owner.kind.clone(),
                    name: owner.name.clone(),
                });
            }
            Err(error) if error.code() == "NOT_FOUND" => {
                lineage.stop = Some(LineageStop::OwnerGone {
                    kind: owner.kind.clone(),
                    name: owner.name.clone(),
                });
            }
            Err(error) => lineage.stop = Some(unread(&error)),
        }
    }
    Ok(lineage)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::served::test_server::{connected, failure};
    use crate::client::served::ServedIndex;
    use serde_json::json;

    fn apps(kinds: &[(&str, &str)]) -> String {
        json!({
            "kind": "APIResourceList",
            "groupVersion": "apps/v1",
            "resources": kinds.iter().map(|(plural, kind)| json!({
                "name": plural, "singularName": "", "namespaced": true,
                "kind": kind, "verbs": ["get", "list", "watch"],
            })).collect::<Vec<_>>(),
        })
        .to_string()
    }

    fn object(name: &str, uid: &str, owner: Option<(&str, &str, &str)>) -> String {
        let owners: Vec<_> = owner
            .into_iter()
            .map(|(kind, name, uid)| {
                json!({ "apiVersion": "apps/v1", "kind": kind, "name": name, "uid": uid, "controller": true })
            })
            .collect();
        json!({
            "apiVersion": "meta.k8s.io/v1",
            "kind": "PartialObjectMetadata",
            "metadata": { "name": name, "namespace": "shop", "uid": uid, "ownerReferences": owners },
        })
        .to_string()
    }

    fn pod_of_replicaset() -> ObjectMeta {
        ObjectMeta {
            name: Some("api-7f9-x".to_string()),
            namespace: Some("shop".to_string()),
            uid: Some("p".to_string()),
            owner_references: Some(vec![OwnerReference {
                api_version: "apps/v1".to_string(),
                kind: "ReplicaSet".to_string(),
                name: "api-7f9".to_string(),
                uid: "r".to_string(),
                controller: Some(true),
                ..OwnerReference::default()
            }]),
            ..ObjectMeta::default()
        }
    }

    fn discovery(path: &str) -> Option<(u16, String)> {
        match path {
            "/apis" => Some((
                200,
                json!({ "kind": "APIGroupList", "groups": [{
                    "name": "apps",
                    "versions": [{ "groupVersion": "apps/v1", "version": "v1" }],
                    "preferredVersion": { "groupVersion": "apps/v1", "version": "v1" },
                }]})
                .to_string(),
            )),
            "/apis/apps/v1" => Some((
                200,
                apps(&[("replicasets", "ReplicaSet"), ("deployments", "Deployment")]),
            )),
            _ => None,
        }
    }

    /// A pod's chain is its replica set and that one's deployment, each the
    /// object the reference meant.
    #[tokio::test]
    async fn the_chain_follows_each_controller_to_the_top() {
        let (state, _) = connected(ServedIndex::default(), |path, _| {
            discovery(path).unwrap_or_else(|| match path {
                "/apis/apps/v1/namespaces/shop/replicasets/api-7f9" => (
                    200,
                    object("api-7f9", "r", Some(("Deployment", "api", "d"))),
                ),
                "/apis/apps/v1/namespaces/shop/deployments/api" => (200, object("api", "d", None)),
                _ => (404, "{}".to_string()),
            })
        })
        .await;
        let lineage = lineage_of(&state, pod_of_replicaset(), Some("shop".to_string()))
            .await
            .expect("lineage");
        let names: Vec<_> = lineage.ancestors.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(names, ["api-7f9", "api"]);
        assert_eq!(lineage.stop, None);
    }

    /// The same name with another uid is a different object: the owner the
    /// reference meant was deleted, and the chain says so rather than
    /// claiming the newcomer.
    #[tokio::test]
    async fn an_owner_recreated_under_the_same_name_is_gone() {
        let (state, _) = connected(ServedIndex::default(), |path, _| {
            discovery(path).unwrap_or_else(|| match path {
                "/apis/apps/v1/namespaces/shop/replicasets/api-7f9" => {
                    (200, object("api-7f9", "someone-else", None))
                }
                _ => (404, "{}".to_string()),
            })
        })
        .await;
        let lineage = lineage_of(&state, pod_of_replicaset(), Some("shop".to_string()))
            .await
            .expect("lineage");
        assert!(lineage.ancestors.is_empty());
        assert!(matches!(lineage.stop, Some(LineageStop::OwnerGone { .. })));
    }

    /// A refused read is not a missing owner.
    #[tokio::test]
    async fn an_owner_that_could_not_be_read_is_not_called_gone() {
        let (state, _) = connected(ServedIndex::default(), |path, _| {
            discovery(path).unwrap_or_else(|| failure(403, "Forbidden"))
        })
        .await;
        let lineage = lineage_of(&state, pod_of_replicaset(), Some("shop".to_string()))
            .await
            .expect("lineage");
        assert!(matches!(
            lineage.stop,
            Some(LineageStop::OwnerUnread { ref code, .. }) if code == "PERMISSION_DENIED"
        ));
    }
}
