//! Where a kind is served, per context: one API group's discovery, read once
//! and shared by every command that asks while it is fresh.
//!
//! Every custom-resource command used to GET the whole CRD — its schema runs
//! to a megabyte — to learn a group, a version and a scope, and a page polling
//! a list paid it on every tick. The group's discovery document says the same
//! in a few kilobytes, lists only versions that are actually served, and
//! answers for every kind in the group at once.

use std::sync::Arc;
use std::time::{Duration, Instant};

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

/// One group's discovery, and when it was read.
#[derive(Clone)]
struct Discovered {
    at: Instant,
    group: Option<Arc<ApiGroup>>,
}

/// One read's answer, a failure included: everyone who joined the read gets
/// it, and the next caller reads again.
type Answer = std::result::Result<Discovered, Arc<kube::Error>>;

type Entry = Arc<OnceCell<Answer>>;

/// How long an answer that holds what was asked for is kept. A kind added to
/// a group in use, or a version dropped from it, shows up within this.
const FRESH_FOR: Duration = Duration::from_secs(60);

/// How long an answer that lacks what was asked for is kept. A miss is what
/// most clusters say about most kinds, asked on every poll; a group in use
/// is read again by its hits anyway, so this paces only groups nobody has.
const MISSING_FOR: Duration = Duration::from_mins(2);

/// How old an answer has to be for a 404 to send it back: a deleted
/// object's open page 404s on every poll.
const RECHECK_AFTER: Duration = Duration::from_secs(30);

/// Discovered groups by (context, group).
///
/// One `OnceCell` per key, so callers that arrive together wait on one
/// request, failed or not. A failed read is kept for no one after them: a
/// refusal cached as "not served" would say a kind is not installed for as
/// long as the app runs. Nor is an answer kept for good: a kind installed
/// after it was read would stay "not installed" until the next connection.
pub struct ServedIndex {
    groups: DashMap<(String, String), Entry>,
    fresh_for: Duration,
    missing_for: Duration,
    recheck_after: Duration,
}

impl Default for ServedIndex {
    fn default() -> Self {
        Self {
            groups: DashMap::new(),
            fresh_for: FRESH_FOR,
            missing_for: MISSING_FOR,
            recheck_after: RECHECK_AFTER,
        }
    }
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
        let Some(api_group) = self
            .group(context, client, group, |found| {
                find(found, plural).is_some()
            })
            .await?
        else {
            return Ok(None);
        };
        Ok(find(&api_group, plural))
    }

    /// `plural` in `group` with every version that serves it; `None` where
    /// the cluster serves no such kind. A miss asks again, as `resource`
    /// does — `kinds` cannot, not knowing what was wanted of it.
    ///
    /// # Errors
    ///
    /// Where discovery could not be read.
    pub async fn kind(
        &self,
        context: &str,
        client: &Client,
        group: &str,
        plural: &str,
    ) -> Result<Option<ServedKind>> {
        Ok(self
            .group(context, client, group, |found| {
                find(found, plural).is_some()
            })
            .await?
            .and_then(|api_group| {
                kinds_of(&api_group)
                    .into_iter()
                    .find(|kind| kind.plural == plural)
            }))
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
            .group(context, client, group, |_| true)
            .await?
            .map(|api_group| kinds_of(&api_group)))
    }

    /// The group as discovered, read again where the answer held is too old
    /// for what `answers` wanted of it.
    async fn group(
        &self,
        context: &str,
        client: &Client,
        group: &str,
        answers: impl Fn(&ApiGroup) -> bool,
    ) -> Result<Option<Arc<ApiGroup>>> {
        let key = (context.to_string(), group.to_string());
        let (cell, found) = self.read(&key, client).await?;
        let kept_for = if found.group.as_deref().is_some_and(answers) {
            self.fresh_for
        } else {
            self.missing_for
        };
        if found.at.elapsed() < kept_for {
            return Ok(found.group);
        }
        // Only the answer this call judged: one a caller beside it already
        // replaced is the re-read, and is joined rather than thrown away.
        self.groups
            .remove_if(&key, |_, held| Arc::ptr_eq(held, &cell));
        Ok(self.read(&key, client).await?.1.group)
    }

    async fn read(&self, key: &(String, String), client: &Client) -> Result<(Entry, Discovered)> {
        let cell = self.groups.entry(key.clone()).or_default().clone();
        let answer = cell
            .get_or_init(|| async {
                let group = match discovery::group(client, &key.1).await {
                    Ok(found) => Some(Arc::new(found)),
                    Err(kube::Error::Discovery(kube::error::DiscoveryError::MissingApiGroup(
                        _,
                    ))) => None,
                    Err(e) => return Err(Arc::new(e)),
                };
                Ok(Discovered {
                    at: Instant::now(),
                    group,
                })
            })
            .await
            .clone();
        match answer {
            Ok(found) => Ok((cell, found)),
            Err(failed) => {
                self.groups
                    .remove_if(key, |_, held| Arc::ptr_eq(held, &cell));
                Err(crate::error::Error::from(again(&failed)))
            }
        }
    }

    /// A request's answer from where this index put a kind of `group`. A 404
    /// is taken as discovery having moved on — a CRD reinstalled without the
    /// version asked for — and the next caller looks again.
    pub fn answered<T>(
        &self,
        context: &str,
        group: &str,
        answer: kube::Result<T>,
    ) -> kube::Result<T> {
        if matches!(&answer, Err(kube::Error::Api(status)) if status.code == 404) {
            self.forget_group(context, group);
        }
        answer
    }

    /// Forget one group. An answer read since the one a 404 came from is
    /// kept: it has already said where the kind is.
    fn forget_group(&self, context: &str, group: &str) {
        self.groups
            .remove_if(&(context.to_string(), group.to_string()), |_, held| {
                held.get().is_some_and(|answer| {
                    answer
                        .as_ref()
                        .is_ok_and(|found| found.at.elapsed() >= self.recheck_after)
                })
            });
    }

    /// Forget a context, when its client goes.
    pub fn forget(&self, context: &str) {
        self.groups.retain(|(held, _), _| held != context);
    }

    pub fn clear(&self) {
        self.groups.clear();
    }
}

#[cfg(test)]
impl ServedIndex {
    /// An index whose answers age as fast as a test can wait.
    pub(crate) fn aged(
        fresh_for: Duration,
        missing_for: Duration,
        recheck_after: Duration,
    ) -> Self {
        Self {
            fresh_for,
            missing_for,
            recheck_after,
            ..Self::default()
        }
    }

    /// The real floors, `by` times shorter.
    pub(crate) fn scaled(by: u32) -> Self {
        Self::aged(FRESH_FOR / by, MISSING_FOR / by, RECHECK_AFTER / by)
    }
}

/// The same failure for each caller that shared it, told apart the way the
/// original is: a status keeps its code, and anything else keeps its words
/// and its causes, a deadline among them.
fn again(failed: &Arc<kube::Error>) -> kube::Error {
    match failed.as_ref() {
        kube::Error::Api(status) => kube::Error::Api(status.clone()),
        kube::Error::Service(inner) => kube::Error::Service(Box::new(Shared {
            failed: failed.clone(),
            shown: inner.to_string(),
            cause: Cause::Inner,
        })),
        other => kube::Error::Service(Box::new(Shared {
            failed: failed.clone(),
            shown: other.to_string(),
            cause: Cause::Itself,
        })),
    }
}

#[derive(Debug)]
enum Cause {
    /// A `Service` failure, standing in for what it wraps.
    Inner,
    /// Any other, standing in for itself.
    Itself,
}

#[derive(Debug)]
struct Shared {
    failed: Arc<kube::Error>,
    shown: String,
    cause: Cause,
}

impl std::fmt::Display for Shared {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.shown)
    }
}

impl std::error::Error for Shared {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self.cause {
            Cause::Inner => self.failed.source(),
            Cause::Itself => Some(self.failed.as_ref()),
        }
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
        let (url, hits) = listening(answer).await;
        let config = kube::Config::new(url.parse().expect("cluster url"));
        (Client::try_from(config).expect("client"), hits)
    }

    /// The app's own state, its current context connected to an API server
    /// answering as `answering` does, and discovery read through `served`.
    pub(crate) async fn connected(
        served: super::ServedIndex,
        answer: impl Fn(&str, usize) -> (u16, String) + Send + Sync + 'static,
    ) -> (crate::state::AppState, Hits) {
        let (url, hits) = listening(answer).await;
        let mut state = crate::state::AppState::new().expect("state");
        state.client_manager = Arc::new(crate::client::K8sClientManager::with_served(served));
        let kubeconfig = kube::config::Kubeconfig::from_yaml(&format!(
            "apiVersion: v1\nkind: Config\ncurrent-context: fake\n\
             clusters: [{{name: fake, cluster: {{server: '{url}'}}}}]\n\
             users: [{{name: fake, user: {{}}}}]\n\
             contexts: [{{name: fake, context: {{cluster: fake, user: fake}}}}]\n"
        ))
        .expect("kubeconfig");
        state
            .client_manager
            .connect_with_kubeconfig("fake", kubeconfig)
            .await
            .expect("connected");
        state.set_current_context(Some("fake".to_string()));
        (state, hits)
    }

    /// A failure as the API server words it.
    pub(crate) fn failure(code: u16, reason: &str) -> (u16, String) {
        (
            code,
            serde_json::json!({
                "kind": "Status",
                "apiVersion": "v1",
                "status": "Failure",
                "reason": reason,
                "code": code,
            })
            .to_string(),
        )
    }

    async fn listening(
        answer: impl Fn(&str, usize) -> (u16, String) + Send + Sync + 'static,
    ) -> (String, Hits) {
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
        (format!("http://127.0.0.1:{port}"), hits)
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
    use super::test_server::{answering, groups, resources, server};
    use super::*;

    const GROUP: &str = "gateway.networking.k8s.io";

    fn groups_none() -> String {
        serde_json::json!({ "kind": "APIGroupList", "apiVersion": "v1", "groups": [] }).to_string()
    }

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
        let (client, _) = server(vec![("/apis", 200, groups_none())]).await;
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

    /// Would read discovery once per caller, one after another, while it
    /// kept failing: each waiter ran its own read when the one before it
    /// failed. The refusal reaches every joiner as a refusal, and the next
    /// caller asks again.
    #[tokio::test]
    async fn callers_together_share_one_failed_read_and_the_next_asks_again() {
        let (client, hits) = server(vec![(
            "/apis",
            403,
            super::test_server::failure(403, "Forbidden").1,
        )])
        .await;
        let index = ServedIndex::default();

        let asks = (0..10).map(|_| index.resource("kind", &client, GROUP, "gateways"));
        for answer in futures::future::join_all(asks).await {
            let error = answer.expect_err("a refused read is not an answer");
            assert!(error.is_refusal(), "{error:?}");
        }
        assert_eq!(hits.lock().unwrap().get("/apis"), Some(&1));

        let again = index.resource("kind", &client, GROUP, "gateways").await;
        assert!(again.is_err());
        assert_eq!(hits.lock().unwrap().get("/apis"), Some(&2));
    }

    /// Would keep a page waiting one deadline per caller on a server that
    /// hangs, and must not turn the deadline into some other failure for the
    /// callers who joined it: the frontend offers a narrower read on it.
    #[tokio::test]
    async fn callers_waiting_on_a_hung_server_all_hear_one_deadline() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind");
        let port = listener.local_addr().expect("addr").port();
        tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((socket, _)) = listener.accept().await {
                held.push(socket);
            }
        });
        let config = kube::Config::new(format!("http://127.0.0.1:{port}").parse().expect("url"));
        let client =
            super::super::client_with_deadline(config, Duration::from_millis(200)).expect("client");
        let index = ServedIndex::default();

        let started = Instant::now();
        let asks = (0..5).map(|_| index.resource("kind", &client, GROUP, "gateways"));
        for answer in futures::future::join_all(asks).await {
            assert!(
                matches!(answer, Err(crate::error::Error::ReadDeadline { .. })),
                "{answer:?}"
            );
        }
        assert!(
            started.elapsed() < Duration::from_millis(800),
            "{:?}",
            started.elapsed()
        );
    }

    fn aged(fresh_for: u64, missing_for: u64) -> ServedIndex {
        ServedIndex::aged(
            Duration::from_millis(fresh_for),
            Duration::from_millis(missing_for),
            RECHECK_AFTER,
        )
    }

    fn gateways_only() -> Vec<(&'static str, u16, String)> {
        vec![
            ("/apis", 200, groups("v1", &["v1"])),
            (
                "/apis/gateway.networking.k8s.io/v1",
                200,
                resources("v1", &[("gateways", "Gateway", true)]),
            ),
        ]
    }

    /// Would have the Gateway pages read `/apis` and the whole group again
    /// every few seconds on most clusters, for a `ListenerSet` nobody
    /// installed: a miss was kept 5 s. The real floors, scaled down — at the
    /// age a hit is read again, a miss is still kept.
    #[tokio::test]
    async fn a_miss_is_kept_after_a_hit_has_aged_out() {
        let (client, hits) = server(gateways_only()).await;
        let index = ServedIndex::scaled(300);
        let asked = || hits.lock().unwrap().get("/apis").copied();
        let listener_sets = || index.resource("kind", &client, GROUP, "listenersets");

        assert!(listener_sets().await.expect("read").is_none());
        tokio::time::sleep(FRESH_FOR / 200).await;
        assert!(listener_sets().await.expect("read").is_none());
        assert_eq!(asked(), Some(1), "a miss is kept past a hit's age");

        index
            .resource("kind", &client, GROUP, "gateways")
            .await
            .expect("read");
        assert_eq!(asked(), Some(2), "a hit this old is read again");
    }

    /// Would send a discovery read per caller where one answers them all:
    /// a page's burst of requests arrives together once the answer is old.
    #[tokio::test]
    async fn callers_together_share_one_read_again() {
        let (client, hits) = server(gateways_only()).await;
        let index = aged(100, 100);
        index
            .resource("kind", &client, GROUP, "gateways")
            .await
            .expect("read");
        tokio::time::sleep(Duration::from_millis(150)).await;

        let asks = (0..10).map(|_| index.resource("kind", &client, GROUP, "gateways"));
        for answer in futures::future::join_all(asks).await {
            assert!(answer.expect("read").is_some());
        }
        assert_eq!(hits.lock().unwrap().get("/apis"), Some(&2));
    }

    /// Would read discovery on every poll of a deleted object's page: each
    /// 404 sent back an answer read moments before, which had already said
    /// where the kind is served. An older one still goes.
    #[tokio::test]
    async fn a_404_sends_back_only_an_answer_older_than_the_floor() {
        let (client, hits) = server(gateways_only()).await;
        let index = ServedIndex::aged(
            Duration::from_mins(1),
            Duration::from_mins(2),
            Duration::from_millis(100),
        );
        let asked = || hits.lock().unwrap().get("/apis").copied();
        let read = || index.resource("kind", &client, GROUP, "gateways");

        let a_404 = || {
            let status = kube::core::Status::failure("gone", "NotFound").with_code(404);
            index.answered::<()>("kind", GROUP, Err(kube::Error::Api(Box::new(status))))
        };

        read().await.expect("read");
        assert!(a_404().is_err());
        read().await.expect("read");
        assert_eq!(asked(), Some(1), "an answer this young is kept");

        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(a_404().is_err());
        read().await.expect("read");
        assert_eq!(asked(), Some(2), "an older one is read again");
    }

    /// Gateway API installed under a connected window. "Not served" was kept
    /// for the whole connection, so the Routes pages said no CRDs were
    /// installed until the reader reconnected.
    #[tokio::test]
    async fn a_group_installed_after_it_was_read_missing_is_found() {
        let (client, hits) = answering(|path, nth| match path {
            "/apis" if nth == 1 => (200, groups_none()),
            "/apis" => (200, groups("v1", &["v1"])),
            _ => (200, resources("v1", &[("httproutes", "HTTPRoute", true)])),
        })
        .await;
        let index = aged(60_000, 100);

        assert!(index
            .kinds("kind", &client, GROUP)
            .await
            .expect("read")
            .is_none());
        assert!(index
            .kinds("kind", &client, GROUP)
            .await
            .expect("read")
            .is_none());
        assert_eq!(
            hits.lock().unwrap().get("/apis"),
            Some(&1),
            "a miss this young is kept"
        );

        tokio::time::sleep(Duration::from_millis(150)).await;
        let kinds = index.kinds("kind", &client, GROUP).await.expect("read");
        assert_eq!(kinds.expect("installed now")[0].kind, "HTTPRoute");
    }

    /// An operator upgrade adds a kind to a group already read. Its CRD page
    /// said the CRD did not exist, because nothing asked discovery again.
    #[tokio::test]
    async fn a_kind_added_to_a_group_already_read_is_found() {
        let (client, _) = answering(|path, nth| match path {
            "/apis" => (200, groups("v1", &["v1"])),
            _ if nth == 1 => (200, resources("v1", &[("httproutes", "HTTPRoute", true)])),
            _ => (
                200,
                resources(
                    "v1",
                    &[
                        ("httproutes", "HTTPRoute", true),
                        ("listenersets", "ListenerSet", true),
                    ],
                ),
            ),
        })
        .await;
        let index = aged(60_000, 100);

        assert!(index
            .resource("kind", &client, GROUP, "listenersets")
            .await
            .expect("read")
            .is_none());
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(index
            .resource("kind", &client, GROUP, "listenersets")
            .await
            .expect("read")
            .is_some());
    }

    /// Even an answer that has what was asked for ages out: a version the
    /// cluster stopped serving, or a kind `kinds` could not know to miss.
    #[tokio::test]
    async fn an_answer_that_holds_the_kind_is_read_again_once_old() {
        let (client, hits) = server(vec![
            ("/apis", 200, groups("v1", &["v1"])),
            (
                "/apis/gateway.networking.k8s.io/v1",
                200,
                resources("v1", &[("tcproutes", "TCPRoute", true)]),
            ),
        ])
        .await;
        let index = aged(100, 100);

        index.kinds("kind", &client, GROUP).await.expect("read");
        index.kinds("kind", &client, GROUP).await.expect("read");
        assert_eq!(hits.lock().unwrap().get("/apis"), Some(&1));
        tokio::time::sleep(Duration::from_millis(150)).await;
        index.kinds("kind", &client, GROUP).await.expect("read");
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
