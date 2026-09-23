//! A list read across the window's namespaces.
//!
//! The whole cluster is one LIST and one namespace is one LIST. Several are
//! one LIST each and never one cluster-wide LIST: a token with rights in some
//! namespaces and not the cluster is refused that, and the picker exists for
//! exactly that token. A namespace that does not answer is carried by name
//! beside the rows of the ones that did — never folded into "none there".

use std::future::Future;

use futures::future::join_all;
use kube::{Api, Client};
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

/// A namespace of the scope whose read failed, and the failure as a failed
/// command would have crossed with it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnreadNamespace {
    pub namespace: String,
    /// One of `shared/error-codes.json`: a refusal and a fault read alike
    /// here and must not on screen.
    pub code: String,
    pub message: String,
}

impl UnreadNamespace {
    #[must_use]
    pub fn of(namespace: String, error: &Error) -> Self {
        Self {
            namespace,
            code: error.code().to_string(),
            message: error.to_string(),
        }
    }
}

/// The rows the scope answered with, and the namespaces that did not answer.
///
/// `unread` is only ever filled for several namespaces. The whole cluster, or
/// one namespace, has nothing to answer beside a failure, so its read fails
/// whole; so does a read where no namespace answered at all.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scoped<T> {
    pub rows: Vec<T>,
    pub unread: Vec<UnreadNamespace>,
}

impl<T> Scoped<T> {
    #[must_use]
    pub fn whole(rows: Vec<T>) -> Self {
        Self {
            rows,
            unread: Vec::new(),
        }
    }
}

/// `scope` checked, sorted and without repeats: `None` is the whole cluster.
///
/// An empty list is refused rather than read as "every namespace": a caller
/// that lost its selection would otherwise be handed the whole cluster under
/// a label naming none of it. Sorted so two spellings of one set are one
/// question with one answer.
pub fn scope_of(scope: Option<Vec<String>>) -> Result<Option<Vec<String>>> {
    let Some(mut names) = scope else {
        return Ok(None);
    };
    if names.is_empty() {
        return Err(Error::InvalidInput(
            "A scope names at least one namespace".to_string(),
        ));
    }
    for name in &names {
        crate::validation::validate_namespace(name)?;
    }
    names.sort();
    names.dedup();
    Ok(Some(names))
}

/// Where the namespaced kinds are read: once across the cluster, or once in
/// each namespace of the scope.
#[must_use]
pub fn reaches(scope: Option<&[String]>) -> Vec<Option<&str>> {
    scope.map_or_else(
        || vec![None],
        |names| names.iter().map(|name| Some(name.as_str())).collect(),
    )
}

/// The typed API for one reach.
#[must_use]
pub fn api_in<K>(client: &Client, reach: Option<&str>) -> Api<K>
where
    K: kube::Resource<Scope = k8s_openapi::NamespaceResourceScope>,
    K::DynamicType: Default,
{
    match reach {
        Some(namespace) => Api::namespaced(client.clone(), namespace),
        None => Api::all(client.clone()),
    }
}

/// Every object of kind `K` in one reach, as its list page draws it.
pub async fn infos_in<K, Info>(client: Client, reach: Option<String>) -> Result<Vec<Info>>
where
    K: kube::Resource<Scope = k8s_openapi::NamespaceResourceScope>
        + Clone
        + std::fmt::Debug
        + serde::de::DeserializeOwned,
    K::DynamicType: Default,
    Info: for<'a> From<&'a K>,
{
    let list = api_in::<K>(&client, reach.as_deref())
        .list(&kube::api::ListParams::default())
        .await?;
    Ok(list.items.iter().map(Info::from).collect())
}

/// `read` once per reach of `scope`, all at once, gathered.
pub async fn across<T, F, Fut>(scope: Option<Vec<String>>, read: F) -> Result<Scoped<T>>
where
    F: Fn(Option<String>) -> Fut,
    Fut: Future<Output = Result<Vec<T>>>,
{
    match scope_of(scope)? {
        None => Ok(Scoped::whole(read(None).await?)),
        Some(names) if names.len() == 1 => Ok(Scoped::whole(read(names.into_iter().next()).await?)),
        Some(names) => {
            let answers = join_all(names.iter().cloned().map(|name| read(Some(name)))).await;
            gathered(names, answers)
        }
    }
}

/// Several namespaces' answers as one.
///
/// Fails whole where nothing answered, and where any namespace was told the
/// session is over: that is not about the namespace, every read is failing,
/// and only a failed command reaches the one place that signs the reader in
/// again.
pub fn gathered<T>(names: Vec<String>, answers: Vec<Result<Vec<T>>>) -> Result<Scoped<T>> {
    let mut rows = Vec::new();
    let mut unread = Vec::new();
    let mut answered = false;
    let mut first = None;
    for (namespace, answer) in names.into_iter().zip(answers) {
        match answer {
            Ok(mut part) => {
                answered = true;
                rows.append(&mut part);
            }
            Err(error @ Error::CredentialsExpired(_)) => return Err(error),
            Err(error) => {
                unread.push(UnreadNamespace::of(namespace, &error));
                first.get_or_insert(error);
            }
        }
    }
    match first {
        Some(error) if !answered => Err(error),
        _ => Ok(Scoped { rows, unread }),
    }
}

/// A `list_<kind>_in` command for a typed namespaced kind: the rows its page
/// draws, read across the scope.
macro_rules! list_in_scope {
    ($cmd:ident, $k8s:ty, $info:ty) => {
        #[tauri::command]
        pub async fn $cmd(
            scope: Option<Vec<String>>,
            state: tauri::State<'_, $crate::state::AppState>,
        ) -> $crate::error::Result<$crate::commands::helpers::Scoped<$info>> {
            let client = (*state.current_client()?).clone();
            $crate::commands::helpers::across(scope, |reach| {
                $crate::commands::helpers::infos_in::<$k8s, $info>(client.clone(), reach)
            })
            .await
        }
    };
}
pub(crate) use list_in_scope;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::served::test_server::server;
    use crate::resources::ConfigMapInfo;
    use k8s_openapi::api::core::v1::ConfigMap;
    use serde_json::json;

    fn refused() -> Error {
        Error::PermissionDenied("configmaps is forbidden".into())
    }

    /// An empty list read as "every namespace" hands a caller that lost its
    /// selection the whole cluster's numbers under a label naming none of it.
    #[test]
    fn an_empty_scope_is_refused_rather_than_read_as_the_whole_cluster() {
        assert!(matches!(scope_of(None), Ok(None)));
        assert!(matches!(
            scope_of(Some(Vec::new())),
            Err(Error::InvalidInput(_))
        ));
    }

    /// A scope is a set: the same namespaces in another order, or twice,
    /// are one question with one answer.
    #[test]
    fn a_scope_is_read_as_a_set_of_valid_names() {
        let asked = vec![
            "staging".to_string(),
            "prod".to_string(),
            "staging".to_string(),
        ];
        assert_eq!(
            scope_of(Some(asked)).expect("a valid scope"),
            Some(vec!["prod".to_string(), "staging".to_string()])
        );
        assert!(scope_of(Some(vec!["Prod_1".to_string()])).is_err());
    }

    /// The defect this exists for: two namespaces answered, one refused, and
    /// the refusal was dropped — the list read as the whole scope.
    #[test]
    fn a_namespace_that_refused_is_carried_beside_the_rows_of_the_rest() {
        let scoped = gathered(
            vec!["a".into(), "b".into(), "c".into()],
            vec![Ok(vec![1, 2]), Err(refused()), Ok(vec![3])],
        )
        .expect("two namespaces answered");
        assert_eq!(scoped.rows, [1, 2, 3]);
        assert_eq!(scoped.unread.len(), 1);
        assert_eq!(scoped.unread[0].namespace, "b");
        assert_eq!(scoped.unread[0].code, "PERMISSION_DENIED");
    }

    /// An empty answer is an answer: a namespace with none of the kind next
    /// to a refused one is "none in a, b unread", not a failure of both.
    #[test]
    fn an_empty_answer_still_counts_as_one() {
        let scoped = gathered::<u8>(
            vec!["a".into(), "b".into()],
            vec![Ok(vec![]), Err(refused())],
        )
        .expect("a answered, with nothing");
        assert!(scoped.rows.is_empty());
        assert_eq!(scoped.unread[0].namespace, "b");
    }

    #[test]
    fn nothing_answered_is_a_failure_and_not_an_empty_list() {
        let answer = gathered::<u8>(
            vec!["a".into(), "b".into()],
            vec![Err(refused()), Err(Error::Timeout("slow".into()))],
        );
        assert!(matches!(answer, Err(Error::PermissionDenied(_))));
    }

    /// Carried as one namespace's trouble, an expired session would never
    /// reach the command wrapper that sends the reader to sign in again.
    #[test]
    fn an_expired_session_fails_the_read_whatever_else_answered() {
        let answer = gathered(
            vec!["a".into(), "b".into()],
            vec![Ok(vec![1]), Err(Error::CredentialsExpired("gone".into()))],
        );
        assert!(matches!(answer, Err(Error::CredentialsExpired(_))));
    }

    fn config_maps(namespace: &str, names: &[&str]) -> String {
        let items: Vec<_> = names
            .iter()
            .map(|name| json!({ "metadata": { "name": name, "namespace": namespace } }))
            .collect();
        json!({ "apiVersion": "v1", "kind": "ConfigMapList", "metadata": {}, "items": items })
            .to_string()
    }

    /// Against an API server: one LIST per namespace, never the cluster-wide
    /// one a namespace-scoped token is refused, and the 403 carried by name.
    #[tokio::test]
    async fn several_namespaces_are_read_one_apiece_and_a_refusal_is_named() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let forbidden = json!({
            "kind": "Status", "apiVersion": "v1", "status": "Failure",
            "message": "configmaps is forbidden", "reason": "Forbidden", "code": 403,
        })
        .to_string();
        let (client, hits) = server(vec![
            (
                "/api/v1/namespaces/prod/configmaps",
                200,
                config_maps("prod", &["app"]),
            ),
            ("/api/v1/namespaces/staging/configmaps", 403, forbidden),
        ])
        .await;

        let scoped = across(Some(vec!["staging".into(), "prod".into()]), |reach| {
            infos_in::<ConfigMap, ConfigMapInfo>(client.clone(), reach)
        })
        .await
        .expect("prod answered");

        assert_eq!(scoped.rows.len(), 1);
        assert_eq!(scoped.rows[0].namespace, "prod");
        assert_eq!(scoped.unread.len(), 1);
        assert_eq!(scoped.unread[0].namespace, "staging");
        assert_eq!(scoped.unread[0].code, "PERMISSION_DENIED");
        let hits = hits.lock().unwrap();
        assert!(
            !hits.contains_key("/api/v1/configmaps"),
            "never cluster-wide"
        );
    }

    /// One namespace has nothing to carry a failure beside; it fails whole,
    /// as the command always did.
    #[tokio::test]
    async fn one_namespace_that_refused_fails_the_read() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let (client, _) = server(vec![(
            "/api/v1/namespaces/prod/configmaps",
            403,
            json!({ "kind": "Status", "status": "Failure", "reason": "Forbidden", "code": 403 })
                .to_string(),
        )])
        .await;
        let answer = across(Some(vec!["prod".into()]), |reach| {
            infos_in::<ConfigMap, ConfigMapInfo>(client.clone(), reach)
        })
        .await;
        assert!(answer.is_err_and(|error| error.is_refusal()));
    }
}
