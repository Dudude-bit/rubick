//! Where a kind is served, per context: one API group's discovery, read once
//! and shared by every command that asks.
//!
//! Every custom-resource command used to GET the whole CRD — its schema runs
//! to a megabyte — to learn a group, a version and a scope, and a page polling
//! a list paid it on every tick. The group's discovery document says the same
//! in a few kilobytes, lists only versions that are actually served, and
//! answers for every kind in the group at once.

use std::sync::Arc;

use dashmap::DashMap;
use kube::discovery::{self, ApiGroup, ApiResource, Scope};
use kube::Client;
use tokio::sync::OnceCell;

use crate::error::Result;

/// Where one kind is served.
#[derive(Debug, Clone)]
pub struct Served {
    pub resource: ApiResource,
    pub namespaced: bool,
}

/// One kind a group serves, and every version that serves it, most stable
/// first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServedKind {
    pub kind: String,
    pub plural: String,
    pub versions: Vec<String>,
    pub namespaced: bool,
}

type Entry = Arc<OnceCell<Option<Arc<ApiGroup>>>>;

/// Discovered groups by (context, group).
///
/// One `OnceCell` per key, so callers that arrive together wait on one
/// request. A failed read is never kept: a refusal cached as "not served"
/// would say a kind is not installed for as long as the app runs.
#[derive(Default)]
pub struct ServedIndex {
    groups: DashMap<(String, String), Entry>,
}

impl ServedIndex {
    /// Where `plural` in `group` is served, the group's preferred version
    /// first; `None` where the cluster serves no such kind.
    ///
    /// # Errors
    ///
    /// Where discovery could not be read, which is not the same answer.
    pub async fn resource(
        &self,
        context: &str,
        client: &Client,
        group: &str,
        plural: &str,
    ) -> Result<Option<Served>> {
        let Some(api_group) = self.group(context, client, group).await? else {
            return Ok(None);
        };
        Ok(find(&api_group, plural))
    }

    /// Every kind `group` serves; `None` where the cluster serves no such
    /// group.
    ///
    /// # Errors
    ///
    /// Where discovery could not be read.
    pub async fn kinds(
        &self,
        context: &str,
        client: &Client,
        group: &str,
    ) -> Result<Option<Vec<ServedKind>>> {
        Ok(self
            .group(context, client, group)
            .await?
            .map(|api_group| kinds_of(&api_group)))
    }

    async fn group(
        &self,
        context: &str,
        client: &Client,
        group: &str,
    ) -> Result<Option<Arc<ApiGroup>>> {
        let cell = self
            .groups
            .entry((context.to_string(), group.to_string()))
            .or_default()
            .clone();
        let found = cell
            .get_or_try_init(|| async {
                match discovery::group(client, group).await {
                    Ok(found) => Ok(Some(Arc::new(found))),
                    Err(kube::Error::Discovery(kube::error::DiscoveryError::MissingApiGroup(
                        _,
                    ))) => Ok(None),
                    Err(e) => Err(crate::error::Error::from(e)),
                }
            })
            .await?;
        Ok(found.clone())
    }

    /// Forget one group, after a 404 says what was discovered has moved: a
    /// CRD reinstalled without the version this app was asking for.
    pub fn forget_group(&self, context: &str, group: &str) {
        self.groups
            .remove(&(context.to_string(), group.to_string()));
    }

    /// Forget a context, when its client goes.
    pub fn forget(&self, context: &str) {
        self.groups.retain(|(held, _), _| held != context);
    }

    pub fn clear(&self) {
        self.groups.clear();
    }
}

/// The preferred version first — kubectl's choice — then the rest, most
/// stable first: a kind may be missing from the preferred version, which
/// is the common pitfall `ApiGroup` warns about.
fn find(api_group: &ApiGroup, plural: &str) -> Option<Served> {
    let preferred = api_group.preferred_version();
    preferred
        .into_iter()
        .chain(
            api_group
                .versions()
                .filter(|version| Some(*version) != preferred),
        )
        .find_map(|version| {
            api_group
                .versioned_resources(version)
                .into_iter()
                .find(|(resource, _)| resource.plural == plural)
        })
        .map(|(resource, caps)| Served {
            resource,
            namespaced: caps.scope == Scope::Namespaced,
        })
}

fn kinds_of(api_group: &ApiGroup) -> Vec<ServedKind> {
    let mut kinds: Vec<ServedKind> = Vec::new();
    for version in api_group.versions() {
        for (resource, caps) in api_group.versioned_resources(version) {
            match kinds
                .iter_mut()
                .find(|known| known.plural == resource.plural)
            {
                Some(known) => known.versions.push(version.to_string()),
                None => kinds.push(ServedKind {
                    kind: resource.kind,
                    plural: resource.plural,
                    versions: vec![version.to_string()],
                    namespaced: caps.scope == Scope::Namespaced,
                }),
            }
        }
    }
    kinds
}

/// A fake API server for discovery, for tests here and in the modules that
/// read through the index.
#[cfg(test)]
pub(crate) mod test_server {
    use kube::Client;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// Paths asked, and what each answers.
    pub(crate) type Hits = Arc<Mutex<HashMap<String, usize>>>;

    /// An API server that answers discovery for one group from a table:
    /// `(path, status, body)`. Anything else is a 404.
    pub(crate) async fn server(routes: Vec<(&'static str, u16, String)>) -> (Client, Hits) {
        answering(move |path, _| {
            routes
                .iter()
                .find(|(route, _, _)| *route == path)
                .map_or((404, "{}".to_string()), |(_, status, body)| {
                    (*status, body.clone())
                })
        })
        .await
    }

    /// An API server whose answer to a path may change with each time it is
    /// asked: `answer(path, nth)`, counting from 1.
    pub(crate) async fn answering(
        answer: impl Fn(&str, usize) -> (u16, String) + Send + Sync + 'static,
    ) -> (Client, Hits) {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let hits: Hits = Arc::default();
        let seen = hits.clone();
        let answer = Arc::new(answer);
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let answer = answer.clone();
                let seen = seen.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 8192];
                    let n = socket.read(&mut buf).await.unwrap_or(0);
                    let request = String::from_utf8_lossy(&buf[..n]);
                    let path = request
                        .split_whitespace()
                        .nth(1)
                        .unwrap_or("")
                        .split('?')
                        .next()
                        .unwrap_or("")
                        .to_string();
                    let nth = {
                        let mut seen = seen.lock().unwrap();
                        let count = seen.entry(path.clone()).or_default();
                        *count += 1;
                        *count
                    };
                    // Slow enough that callers arriving together overlap.
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    let (status, body) = answer(&path, nth);
                    let reply = format!(
                        "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = socket.write_all(reply.as_bytes()).await;
                });
            }
        });
        let config = kube::Config::new(
            format!("http://127.0.0.1:{port}")
                .parse()
                .expect("cluster url"),
        );
        (Client::try_from(config).expect("client"), hits)
    }

    pub(crate) fn groups(preferred: &str, versions: &[&str]) -> String {
        let versions: Vec<_> = versions
            .iter()
            .map(|v| serde_json::json!({ "groupVersion": format!("gateway.networking.k8s.io/{v}"), "version": v }))
            .collect();
        serde_json::json!({
            "kind": "APIGroupList",
            "apiVersion": "v1",
            "groups": [{
                "name": "gateway.networking.k8s.io",
                "versions": versions,
                "preferredVersion": {
                    "groupVersion": format!("gateway.networking.k8s.io/{preferred}"),
                    "version": preferred,
                },
            }],
        })
        .to_string()
    }

    pub(crate) fn resources(version: &str, kinds: &[(&str, &str, bool)]) -> String {
        let resources: Vec<_> = kinds
            .iter()
            .map(|(plural, kind, namespaced)| {
                serde_json::json!({
                    "name": plural,
                    "singularName": "",
                    "namespaced": namespaced,
                    "kind": kind,
                    "verbs": ["get", "list", "watch"],
                })
            })
            .collect();
        serde_json::json!({
            "kind": "APIResourceList",
            "apiVersion": "v1",
            "groupVersion": format!("gateway.networking.k8s.io/{version}"),
            "resources": resources,
        })
        .to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::test_server::{groups, resources, server};
    use super::*;

    const GROUP: &str = "gateway.networking.k8s.io";

    /// The case that 404'd search on Gateway API 1.6: the route trio is
    /// served at `v1` only. A kind the preferred version lacks is still found
    /// at the version that has it, and a kind nothing serves is `None`.
    #[tokio::test]
    async fn a_kind_is_found_at_the_version_that_serves_it() {
        let (client, _) = server(vec![
            ("/apis", 200, groups("v1", &["v1", "v1alpha2"])),
            (
                "/apis/gateway.networking.k8s.io/v1",
                200,
                resources(
                    "v1",
                    &[
                        ("tcproutes", "TCPRoute", true),
                        ("gatewayclasses", "GatewayClass", false),
                    ],
                ),
            ),
            (
                "/apis/gateway.networking.k8s.io/v1alpha2",
                200,
                resources(
                    "v1alpha2",
                    &[("xbackendtrafficpolicies", "XBackendTrafficPolicy", true)],
                ),
            ),
        ])
        .await;
        let index = ServedIndex::default();

        let tcp = index
            .resource("kind", &client, GROUP, "tcproutes")
            .await
            .expect("read")
            .expect("served");
        assert_eq!(tcp.resource.version, "v1");
        assert!(tcp.namespaced);

        let class = index
            .resource("kind", &client, GROUP, "gatewayclasses")
            .await
            .expect("read")
            .expect("served");
        assert!(!class.namespaced);

        let alpha = index
            .resource("kind", &client, GROUP, "xbackendtrafficpolicies")
            .await
            .expect("read")
            .expect("served below the preferred version");
        assert_eq!(alpha.resource.version, "v1alpha2");

        assert!(index
            .resource("kind", &client, GROUP, "udproutes")
            .await
            .expect("read")
            .is_none());
    }

    /// Each kind with the versions that serve it, most stable first — what
    /// Gateway detection reads its `read_version` from.
    #[tokio::test]
    async fn every_kind_lists_the_versions_that_serve_it() {
        let (client, _) = server(vec![
            ("/apis", 200, groups("v1", &["v1", "v1alpha2"])),
            (
                "/apis/gateway.networking.k8s.io/v1",
                200,
                resources("v1", &[("httproutes", "HTTPRoute", true)]),
            ),
            (
                "/apis/gateway.networking.k8s.io/v1alpha2",
                200,
                resources(
                    "v1alpha2",
                    &[
                        ("httproutes", "HTTPRoute", true),
                        ("tcproutes", "TCPRoute", true),
                    ],
                ),
            ),
        ])
        .await;
        let kinds = ServedIndex::default()
            .kinds("kind", &client, GROUP)
            .await
            .expect("read")
            .expect("served");
        let http = kinds.iter().find(|k| k.kind == "HTTPRoute").expect("http");
        assert_eq!(http.versions, vec!["v1", "v1alpha2"]);
        let tcp = kinds.iter().find(|k| k.kind == "TCPRoute").expect("tcp");
        assert_eq!(tcp.versions, vec!["v1alpha2"]);
    }

    /// A group the cluster does not serve is "not installed", an answer; a
    /// discovery that failed is not, and must not come back as one.
    #[tokio::test]
    async fn a_missing_group_is_none_and_a_refused_one_is_an_error() {
        let (client, _) = server(vec![(
            "/apis",
            200,
            serde_json::json!({ "kind": "APIGroupList", "apiVersion": "v1", "groups": [] })
                .to_string(),
        )])
        .await;
        let index = ServedIndex::default();
        assert!(index
            .resource("kind", &client, GROUP, "tcproutes")
            .await
            .expect("an answer")
            .is_none());

        let (refused, _) = server(vec![("/apis", 403, "{}".to_string())]).await;
        assert!(ServedIndex::default()
            .resource("kind", &refused, GROUP, "tcproutes")
            .await
            .is_err());
    }

    /// Ten callers at once are one discovery, and a second round is none;
    /// forgetting the context asks again. Without the cell each caller read
    /// the whole `/apis` list for itself.
    #[tokio::test]
    async fn callers_together_share_one_discovery_until_it_is_forgotten() {
        let (client, hits) = server(vec![
            ("/apis", 200, groups("v1", &["v1"])),
            (
                "/apis/gateway.networking.k8s.io/v1",
                200,
                resources("v1", &[("tcproutes", "TCPRoute", true)]),
            ),
        ])
        .await;
        let index = ServedIndex::default();

        let asks = (0..10).map(|_| index.resource("kind", &client, GROUP, "tcproutes"));
        for answer in futures::future::join_all(asks).await {
            assert!(answer.expect("read").is_some());
        }
        index
            .resource("kind", &client, GROUP, "tcproutes")
            .await
            .expect("read");
        assert_eq!(hits.lock().unwrap().get("/apis"), Some(&1));

        index.forget("kind");
        index
            .resource("kind", &client, GROUP, "tcproutes")
            .await
            .expect("read");
        assert_eq!(hits.lock().unwrap().get("/apis"), Some(&2));
    }

    /// A refusal is not kept: the next call asks the cluster again rather
    /// than repeating a failure the reader may already have fixed.
    #[tokio::test]
    async fn a_failed_discovery_is_asked_again() {
        let (client, hits) = server(vec![("/apis", 403, "{}".to_string())]).await;
        let index = ServedIndex::default();
        assert!(index
            .resource("kind", &client, GROUP, "tcproutes")
            .await
            .is_err());
        assert!(index
            .resource("kind", &client, GROUP, "tcproutes")
            .await
            .is_err());
        assert_eq!(hits.lock().unwrap().get("/apis"), Some(&2));
    }
}
