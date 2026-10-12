//! Lists answered from the API server's watch cache, never older than what
//! this client has already been told about the resource.
//!
//! A list with no `resourceVersion` is a consistent read, and where storage
//! is slow to range-read (k3s on kine above all) one in a dozen sat for most
//! of a second while the cache held the same answer. A page asks several at
//! once and waits on the slowest. Once a resource has answered, its lists ask
//! `resourceVersionMatch=NotOlderThan` the newest version seen of it in a
//! list, an object or a watch event: the cache answers, and never with
//! anything older than what is on screen, the watch event that asked for the
//! read included.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use dashmap::DashMap;
use http::{Method, Request, Response, StatusCode, Uri};
use http_body::{Body, Frame, SizeHint};
use kube::client::Body as KubeBody;
use tower::{Layer, Service, ServiceExt};

/// Groups the API server's own cache answers. Aggregated APIs, metrics above
/// all, keep storage of their own.
fn cached(group: &str) -> bool {
    matches!(group, "apps" | "batch" | "autoscaling" | "policy")
        || (group.ends_with(".k8s.io") && !group.ends_with("metrics.k8s.io"))
}

/// What a request path addresses.
#[derive(Debug, PartialEq, Eq)]
enum Addressed {
    /// A resource's collection, keyed without its namespace: versions are
    /// the store's, not the namespace's.
    Collection(String),
    Object(String),
}

fn addressed(path: &str) -> Option<Addressed> {
    let (prefix, rest) = if let Some(rest) = path.strip_prefix("/api/v1/") {
        ("/api/v1".to_string(), rest)
    } else {
        let mut parts = path.strip_prefix("/apis/")?.splitn(3, '/');
        let (group, version, rest) = (parts.next()?, parts.next()?, parts.next()?);
        if !cached(group) {
            return None;
        }
        (format!("/apis/{group}/{version}"), rest)
    };
    let segments: Vec<&str> = rest.split('/').filter(|s| !s.is_empty()).collect();
    match segments.as_slice() {
        ["namespaces", _, "status" | "finalize"] => None,
        ["namespaces", _, resource] | [resource] => {
            Some(Addressed::Collection(format!("{prefix}/{resource}")))
        }
        ["namespaces", _, resource, _] | [resource, _] => {
            Some(Addressed::Object(format!("{prefix}/{resource}")))
        }
        _ => None,
    }
}

fn has_param(query: &str, names: &[&str]) -> bool {
    query
        .split('&')
        .filter_map(|pair| pair.split('=').next())
        .any(|name| names.contains(&name))
}

/// The newest version seen per collection, for one client.
#[derive(Clone, Default)]
pub(super) struct Floors {
    seen: Arc<DashMap<String, u64>>,
}

impl Floors {
    fn learn(&self, collection: &str, version: u64) {
        self.seen
            .entry(collection.to_string())
            .and_modify(|held| *held = (*held).max(version))
            .or_insert(version);
    }

    fn get(&self, collection: &str) -> Option<u64> {
        self.seen.get(collection).map(|held| *held)
    }

    fn forget(&self, collection: &str) {
        self.seen.remove(collection);
    }
}

impl<S> Layer<S> for Floors {
    type Service = Floored<S>;

    fn layer(&self, inner: S) -> Self::Service {
        Floored {
            inner,
            floors: self.clone(),
        }
    }
}

#[derive(Clone)]
pub(super) struct Floored<S> {
    inner: S,
    floors: Floors,
}

/// Which versions a response is read for: the first, its own, or the first
/// on every line of a watch, each event's own.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Reading {
    First,
    EveryLine,
}

impl<S, B> Service<Request<KubeBody>> for Floored<S>
where
    S: Service<Request<KubeBody>, Response = Response<B>> + Clone + Send + 'static,
    S::Future: Send + 'static,
    B: Send + 'static,
{
    type Response = Response<Learned<B>>;
    type Error = S::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, S::Error>> + Send>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, request: Request<KubeBody>) -> Self::Future {
        let floors = self.floors.clone();
        let (key, whole) = match addressed(request.uri().path()) {
            Some(Addressed::Collection(key)) => (key, true),
            Some(Addressed::Object(key)) => (key, false),
            None => {
                let answer = self.inner.call(request);
                return Box::pin(async move { Ok(answer.await?.map(Learned::ignoring)) });
            }
        };
        let query = request.uri().query().unwrap_or_default().to_string();
        let reading = if has_param(&query, &["watch"]) {
            Reading::EveryLine
        } else {
            Reading::First
        };
        let pinned = has_param(
            &query,
            &[
                "watch",
                "resourceVersion",
                "resourceVersionMatch",
                "continue",
                "sendInitialEvents",
            ],
        );
        let floor = (whole && request.method() == Method::GET && !pinned)
            .then(|| floors.get(&key))
            .flatten();
        let Some(floor) = floor else {
            let answer = self.inner.call(request);
            return Box::pin(async move { Ok(Learned::wrap(answer.await?, floors, key, reading)) });
        };
        let as_asked = again(&request);
        let spare = self.inner.clone();
        let answer = self.inner.call(with_floor(request, &query, floor));
        Box::pin(async move {
            let response = answer.await?;
            // A floor this server's cache has not reached (another server of an
            // HA pair, a cluster restored from a backup) is refused as too large
            // after a wait, and a server that does not take the parameter
            // refuses it outright; the read goes again as it was asked, and
            // the floor starts over from what answers.
            let refused = matches!(
                response.status(),
                StatusCode::GATEWAY_TIMEOUT | StatusCode::BAD_REQUEST
            );
            let Some(as_asked) = as_asked.filter(|_| refused) else {
                return Ok(Learned::wrap(response, floors, key, reading));
            };
            drop(response);
            floors.forget(&key);
            let response = spare.oneshot(as_asked).await?;
            Ok(Learned::wrap(response, floors, key, reading))
        })
    }
}

fn with_floor(mut request: Request<KubeBody>, query: &str, floor: u64) -> Request<KubeBody> {
    let asked = format!("resourceVersion={floor}&resourceVersionMatch=NotOlderThan");
    let path = request.uri().path();
    let joined = if query.is_empty() {
        format!("{path}?{asked}")
    } else {
        format!("{path}?{query}&{asked}")
    };
    let mut parts = request.uri().clone().into_parts();
    if let Ok(path_and_query) = joined.parse() {
        parts.path_and_query = Some(path_and_query);
        if let Ok(uri) = Uri::from_parts(parts) {
            *request.uri_mut() = uri;
        }
    }
    request
}

/// The request as it was, for asking again without the floor.
fn again(request: &Request<KubeBody>) -> Option<Request<KubeBody>> {
    let mut copy = Request::new(request.body().try_clone()?);
    *copy.method_mut() = request.method().clone();
    *copy.uri_mut() = request.uri().clone();
    *copy.version_mut() = request.version();
    *copy.headers_mut() = request.headers().clone();
    *copy.extensions_mut() = request.extensions().clone();
    Some(copy)
}

const KEY: &[u8] = b"\"resourceVersion\"";
/// Past a list's or an object's kind, name and uid, its own version has been.
const OWN_WITHIN: usize = 4096;

enum Found {
    Version(u64),
    NotYet,
    Never,
}

/// The value after the first `"resourceVersion"` in `head`.
fn first_version(head: &[u8]) -> Found {
    let Some(at) = memchr::memmem::find(head, KEY) else {
        return Found::NotYet;
    };
    let rest = &head[at + KEY.len()..];
    let skip = |bytes: &[u8]| bytes.iter().take_while(|b| b.is_ascii_whitespace()).count();
    let cut = |rest: &[u8]| {
        if rest.is_empty() {
            Found::NotYet
        } else {
            Found::Never
        }
    };
    let rest = &rest[skip(rest)..];
    let Some(rest) = rest.strip_prefix(b":") else {
        return cut(rest);
    };
    let rest = &rest[skip(rest)..];
    let Some(rest) = rest.strip_prefix(b"\"") else {
        return cut(rest);
    };
    let digits = rest.iter().take_while(|b| b.is_ascii_digit()).count();
    match rest.get(digits) {
        None => Found::NotYet,
        Some(b'"') if digits > 0 => std::str::from_utf8(&rest[..digits])
            .ok()
            .and_then(|text| text.parse().ok())
            .map_or(Found::Never, Found::Version),
        Some(_) => Found::Never,
    }
}

/// A response body that tells the floors the versions it carries as its
/// frames pass, before whoever reads it hears of them.
pub(super) struct Learned<B> {
    inner: B,
    learning: Option<Learning>,
}

struct Learning {
    floors: Floors,
    key: String,
    reading: Reading,
    armed: bool,
    head: Vec<u8>,
}

impl<B> Learned<B> {
    fn ignoring(inner: B) -> Self {
        Self {
            inner,
            learning: None,
        }
    }

    fn wrap(
        response: Response<B>,
        floors: Floors,
        key: String,
        reading: Reading,
    ) -> Response<Self> {
        let learning = response.status().is_success().then(|| Learning {
            floors,
            key,
            reading,
            armed: true,
            head: Vec::new(),
        });
        response.map(|inner| Self { inner, learning })
    }
}

impl Learning {
    /// Reads `chunk`; whether anything after it is still worth reading.
    fn take(&mut self, mut chunk: &[u8]) -> bool {
        loop {
            let (line, next) = match self.reading {
                Reading::EveryLine => match memchr::memchr(b'\n', chunk) {
                    Some(end) => (&chunk[..end], Some(&chunk[end + 1..])),
                    None => (chunk, None),
                },
                Reading::First => (chunk, None),
            };
            if self.armed {
                let room = OWN_WITHIN.saturating_sub(self.head.len());
                self.head.extend_from_slice(&line[..line.len().min(room)]);
                match first_version(&self.head) {
                    Found::Version(version) => {
                        self.floors.learn(&self.key, version);
                        self.disarm();
                    }
                    Found::Never => self.disarm(),
                    Found::NotYet if self.head.len() >= OWN_WITHIN => self.disarm(),
                    Found::NotYet => {}
                }
            }
            let Some(after) = next else { break };
            self.armed = true;
            self.head.clear();
            chunk = after;
        }
        self.reading == Reading::EveryLine || self.armed
    }

    fn disarm(&mut self) {
        self.armed = false;
        self.head.clear();
    }
}

impl<B> Body for Learned<B>
where
    B: Body + Unpin,
    B::Data: AsRef<[u8]>,
{
    type Data = B::Data;
    type Error = B::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        let frame = Pin::new(&mut self.inner).poll_frame(cx);
        if let Poll::Ready(Some(Ok(frame))) = &frame {
            if let (Some(data), Some(learning)) = (frame.data_ref(), self.learning.as_mut()) {
                if !learning.take(data.as_ref()) {
                    self.learning = None;
                }
            }
        }
        frame
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

#[cfg(test)]
mod tests {
    use super::super::clock::tests::server;
    use super::*;
    use futures::{StreamExt, TryStreamExt};
    use k8s_openapi::api::core::v1::Pod;
    use kube::api::{Api, ListParams, WatchParams};

    fn pod_list(version: u64) -> Vec<String> {
        vec![format!(
            r#"{{"kind":"PodList","apiVersion":"v1","metadata":{{"resourceVersion":"{version}"}},"items":[]}}"#
        )]
    }

    fn floored(target: &str) -> Option<&str> {
        target
            .split_once("resourceVersion=")
            .and_then(|(_, rest)| rest.strip_suffix("&resourceVersionMatch=NotOlderThan"))
    }

    /// Without the floor every list after the first is a consistent read, the
    /// one that sat for most of a second on k3s while the cache had the answer.
    #[tokio::test]
    async fn a_list_after_one_that_answered_asks_the_cache_for_nothing_older_than_it() {
        let (client, asked) = server(|_| (200, pod_list(120))).await;
        let shop: Api<Pod> = Api::namespaced(client.clone(), "shop");
        let other: Api<Pod> = Api::namespaced(client.clone(), "other");
        let everywhere: Api<Pod> = Api::all(client);

        shop.list(&ListParams::default()).await.expect("first");
        shop.list(&ListParams::default().labels("app=web"))
            .await
            .expect("second");
        other
            .list(&ListParams::default())
            .await
            .expect("another namespace");
        everywhere
            .list(&ListParams::default())
            .await
            .expect("every namespace");

        let asked = asked.lock().unwrap().clone();
        assert_eq!(floored(&asked[0]), None, "{asked:?}");
        for later in &asked[1..] {
            assert_eq!(floored(later), Some("120"), "{asked:?}");
        }
        assert!(asked[1].contains("labelSelector=app%3Dweb"), "{asked:?}");
    }

    /// The read a watch event asks for must not answer from before the event:
    /// the event's own version is the floor, raised before the event is handed
    /// on, one version per line even where a frame cuts it in two, and never
    /// one quoted further into the object.
    #[tokio::test]
    async fn a_watch_event_raises_the_floor_before_it_is_handed_on() {
        let (client, asked) = server(|target| {
            if target.contains("watch=") {
                (
                    200,
                    vec![
                        r#"{"type":"ADDED","object":{"kind":"Pod","apiVersion":"v1","metadata":{"name":"a","namespace":"shop","resourceVersion":"30"#.into(),
                        "0\"}}}\n".into(),
                        r#"{"type":"MODIFIED","object":{"kind":"Pod","apiVersion":"v1","metadata":{"name":"a","namespace":"shop","resourceVersion":"350"},"spec":{"note":{"resourceVersion":"99999"}}}}"#.to_string() + "\n",
                    ],
                )
            } else {
                (200, pod_list(10))
            }
        })
        .await;
        let pods: Api<Pod> = Api::namespaced(client, "shop");

        let mut events = pods
            .watch(&WatchParams::default().timeout(5), "0")
            .await
            .expect("watch")
            .boxed();
        let first = events.try_next().await.expect("first event");
        assert!(first.is_some());
        pods.list(&ListParams::default())
            .await
            .expect("after one event");
        events.try_next().await.expect("second event");
        pods.list(&ListParams::default()).await.expect("after two");

        let asked = asked.lock().unwrap().clone();
        let lists: Vec<_> = asked.iter().filter(|t| !t.contains("watch=")).collect();
        assert_eq!(floored(lists[0]), Some("300"), "{asked:?}");
        assert_eq!(floored(lists[1]), Some("350"), "{asked:?}");
    }

    /// A page carries its own version in its continue token, and a version the
    /// caller chose is its to choose; a watch is not a list.
    #[tokio::test]
    async fn a_continued_page_a_chosen_version_and_a_watch_are_sent_as_asked() {
        let (client, asked) = server(|target| {
            if target.contains("watch=") {
                (200, vec![])
            } else {
                (200, pod_list(50))
            }
        })
        .await;
        let pods: Api<Pod> = Api::namespaced(client, "shop");
        pods.list(&ListParams::default()).await.expect("learn");

        pods.list(&ListParams::default().continue_token("abc"))
            .await
            .expect("page");
        pods.list(&ListParams::default().match_any())
            .await
            .expect("any");
        let _ = pods
            .watch(&WatchParams::default().timeout(1), "7")
            .await
            .expect("watch")
            .boxed()
            .next()
            .await;

        let asked = asked.lock().unwrap().clone();
        for target in &asked[1..] {
            assert!(!target.contains("resourceVersion=50"), "{asked:?}");
        }
    }

    /// A floor ahead of the server's cache (another server of an HA pair, or a
    /// cluster restored from a backup) times out; a list that failed on it,
    /// or one that kept it, would fail or wait on every read from then on.
    #[tokio::test]
    async fn a_floor_the_server_has_not_reached_is_dropped_and_the_list_asked_again() {
        let (client, asked) = server(|target| {
            if target.contains("NotOlderThan") && target.contains("resourceVersion=500") {
                (
                    504,
                    vec![r#"{"kind":"Status","apiVersion":"v1","code":504}"#.into()],
                )
            } else if target.contains("NotOlderThan") {
                (200, pod_list(8))
            } else if target.contains("labelSelector") {
                (200, pod_list(7))
            } else {
                (200, pod_list(500))
            }
        })
        .await;
        let pods: Api<Pod> = Api::namespaced(client, "shop");
        pods.list(&ListParams::default()).await.expect("learn 500");

        let again = pods.list(&ListParams::default().labels("x=y")).await;
        pods.list(&ListParams::default())
            .await
            .expect("after the reset");

        assert!(again.is_ok(), "{again:?}");
        let asked = asked.lock().unwrap().clone();
        assert_eq!(floored(&asked[1]), Some("500"), "{asked:?}");
        assert_eq!(floored(&asked[2]), None, "asked again as it was: {asked:?}");
        assert_eq!(floored(&asked[3]), Some("7"), "{asked:?}");
    }

    /// An object's answer raises the floor by its own version, which comes
    /// first; a version quoted deeper in the object is someone else's.
    #[tokio::test]
    async fn an_object_answer_raises_the_floor_by_its_own_version_only() {
        let (client, asked) = server(|target| {
            if target.ends_with("/pods/a") {
                (
                    200,
                    vec![r#"{"kind":"Pod","apiVersion":"v1","metadata":{"name":"a","resourceVersion":"40"},"spec":{"x":{"resourceVersion":"9000"}}}"#.into()],
                )
            } else {
                (200, pod_list(5))
            }
        })
        .await;
        let pods: Api<Pod> = Api::namespaced(client, "shop");
        pods.list(&ListParams::default()).await.expect("learn 5");

        let _ = pods.get("a").await;
        pods.list(&ListParams::default())
            .await
            .expect("after the object");

        let asked = asked.lock().unwrap().clone();
        assert_eq!(floored(&asked[1]), None, "an object read is not floored");
        assert_eq!(floored(&asked[2]), Some("40"), "{asked:?}");
    }

    /// Where the floor is kept and where it is never applied: a namespace's
    /// list and the cluster's share one, an object is read as asked, and
    /// neither an aggregated API nor anything below an object is touched.
    #[test]
    fn a_path_is_keyed_by_its_store_and_only_the_api_servers_own_are_floored() {
        let collection = |key: &str| Some(Addressed::Collection(key.to_string()));
        let object = |key: &str| Some(Addressed::Object(key.to_string()));
        for (path, want) in [
            ("/api/v1/namespaces/shop/pods", collection("/api/v1/pods")),
            ("/api/v1/pods", collection("/api/v1/pods")),
            ("/api/v1/namespaces", collection("/api/v1/namespaces")),
            ("/api/v1/namespaces/shop", object("/api/v1/namespaces")),
            ("/api/v1/namespaces/shop/pods/a", object("/api/v1/pods")),
            (
                "/apis/apps/v1/namespaces/shop/deployments",
                collection("/apis/apps/v1/deployments"),
            ),
            (
                "/apis/discovery.k8s.io/v1/endpointslices",
                collection("/apis/discovery.k8s.io/v1/endpointslices"),
            ),
            ("/api/v1/namespaces/shop/pods/a/log", None),
            ("/api/v1/namespaces/shop/status", None),
            ("/apis/apps/v1/namespaces/shop/deployments/web/scale", None),
            ("/apis/metrics.k8s.io/v1beta1/pods", None),
            ("/apis/cilium.io/v2/ciliumnetworkpolicies", None),
            ("/apis/apps/v1", None),
            ("/version", None),
        ] {
            assert_eq!(addressed(path), want, "{path}");
        }
    }
}
