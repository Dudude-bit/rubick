//! The namespace snapshot: one list per kind, taken once and read from both
//! ends.

use super::*;

/// One list per kind, taken once and read from both ends.
pub(super) struct Snapshot {
    /// All three carry their failure rather than aborting the call. A
    /// neighbourhood is a set of independent reads, and one the cluster
    /// refused is a gap in the answer, not the end of it: the subject is
    /// usually still readable, and a page that dies whole tells a person
    /// nothing at all about the object they opened.
    pub(super) pods: Read<Pod>,
    pub(super) services: Read<Service>,
    pub(super) ingresses: Read<Ingress>,
    /// `Err` carries the refusal, and it is not an empty list. A token
    /// without `persistentvolumeclaims` used to reach `named_object` with no
    /// claims at all, which resolved every claim a pod mounts to
    /// `Existence::Missing` and told a person, in red, that a volume that is
    /// mounted and healthy does not exist.
    pub(super) claims: Read<PersistentVolumeClaim>,
    /// `Err` carries why the read failed, and is not the same answer as an
    /// empty list: `autoscaling/v2` is not served by every cluster this app
    /// connects to, and "nothing scales this" is not what a 404 means.
    pub(super) autoscalers: Read<HorizontalPodAutoscaler>,
    pub(super) budgets: Read<PodDisruptionBudget>,
    /// What every Service in the namespace publishes, in one list keyed by
    /// the `kubernetes.io/service-name` label — the same shape the Services
    /// and the Ingresses are read under.
    pub(super) slices: Read<EndpointSlice>,
    /// Only read where the slice list did not answer. A cluster below 1.21
    /// serves no `discovery.k8s.io/v1` at all, and a confident empty there
    /// would be the app inventing an outage out of its own API version.
    pub(super) legacy: Read<Endpoints>,
    /// The namespace's Gateway API routes, all five kinds in one list —
    /// empty where the caller brought no detection, or the cluster serves
    /// none of them.
    pub(super) gateway_routes: Vec<crate::resources::RouteInfo>,
    /// Every Gateway in the cluster, unscoped: a route in this namespace
    /// ordinarily attaches to a Gateway in another one, and a
    /// namespace-scoped list would call every such parent missing.
    pub(super) gateways: Option<Vec<crate::resources::GatewayInfo>>,
}

/// Snapshots shared by the calls that arrive together.
///
/// "My services" with twelve pins asked for twelve neighbourhoods at once,
/// and each listed its namespace's seven kinds again: ~120 lists a round for
/// what was mostly three namespaces. Calls for the same (context, namespace,
/// Gateway kinds) share one read in flight, and reuse it for [`SHARED_FOR`].
/// A snapshot with any read that failed is not kept past its own flight — a
/// refusal is an answer for the callers who were waiting, not for the next.
pub struct Snapshots {
    entries: dashmap::DashMap<SnapshotKey, (std::time::Instant, SnapshotCell)>,
    kept_for: std::time::Duration,
}

impl Default for Snapshots {
    fn default() -> Self {
        Self {
            entries: dashmap::DashMap::new(),
            kept_for: SHARED_FOR,
        }
    }
}

type SnapshotKey = (String, String, String);
type SnapshotCell = Arc<tokio::sync::OnceCell<Arc<Snapshot>>>;

/// How long a finished snapshot is reused: enough for a round of cards that
/// arrived a little apart. Kept short because an edit is followed by a
/// re-read, and an answer from before the edit would show the old object
/// for a whole polling interval. A read still in flight is shared however
/// long it takes.
pub(super) const SHARED_FOR: std::time::Duration = std::time::Duration::from_millis(250);

impl Snapshots {
    pub(super) async fn get(
        &self,
        context: &str,
        ctx: &ResourceContext,
        gateway: Option<&crate::resources::GatewayApiDetection>,
    ) -> Result<Arc<Snapshot>> {
        let key = (
            context.to_string(),
            ctx.namespace.clone().unwrap_or_default(),
            gateway
                .filter(|d| d.installed)
                .map(|d| {
                    d.kinds
                        .iter()
                        .map(|k| format!("{}@{}", k.plural, k.read_version))
                        .collect::<Vec<_>>()
                        .join(",")
                })
                .unwrap_or_default(),
        );
        let now = std::time::Instant::now();
        self.entries
            .retain(|_, (at, cell)| !cell.initialized() || now.duration_since(*at) < self.kept_for);
        let cell = self
            .entries
            .entry(key.clone())
            .or_insert_with(|| (now, Arc::default()))
            .1
            .clone();
        let snapshot = cell
            .get_or_try_init(|| async { Snapshot::of(ctx, gateway).await.map(Arc::new) })
            .await?
            .clone();
        if snapshot.any_unread() {
            self.entries
                .remove_if(&key, |_, (_, held)| Arc::ptr_eq(held, &cell));
        }
        Ok(snapshot)
    }
}

/// Where a neighbourhood's snapshot comes from: read fresh, or shared through
/// [`Snapshots`] under a context's name.
#[derive(Clone, Copy, Default)]
pub struct Source<'a> {
    pub(super) shared: Option<(&'a Snapshots, &'a str)>,
}

impl<'a> Source<'a> {
    #[must_use]
    pub fn shared(snapshots: &'a Snapshots, context: &'a str) -> Self {
        Self {
            shared: Some((snapshots, context)),
        }
    }

    pub(super) async fn snapshot(
        self,
        ctx: &ResourceContext,
        gateway: Option<&crate::resources::GatewayApiDetection>,
    ) -> Result<Arc<Snapshot>> {
        match self.shared {
            Some((snapshots, context)) => snapshots.get(context, ctx, gateway).await,
            None => Snapshot::of(ctx, gateway).await.map(Arc::new),
        }
    }
}

/// A list whose failure is part of the answer rather than the end of it, and
/// so is carried alongside the items instead of aborting the whole call.
pub(super) type Read<K> = std::result::Result<Vec<K>, String>;

pub(super) fn read<K: Clone>(list: kube::Result<kube::core::ObjectList<K>>) -> Read<K> {
    // Through the app's own `Error`, not `kube::Error`'s Display. That is
    // the one place a 401 gets its `CREDENTIALS_EXPIRED:` prefix and a
    // timed-out read its `READ_DEADLINE:` one — the wire formats the
    // frontend matches on — and the only place an API failure is turned
    // into the cluster's own sentence rather than kube 4's `Status` struct
    // printed at the reader.
    list.map(|list| list.items)
        .map_err(|err| Error::from(err).to_string())
}

/// [`read`], except for a session the cluster no longer accepts. That is not
/// one kind unread but every read failing, and the frontend has to hear it as
/// `CREDENTIALS_EXPIRED` to ask for a sign-in.
pub(super) fn read_live<K: Clone>(
    list: kube::Result<kube::core::ObjectList<K>>,
) -> Result<Read<K>> {
    match list {
        Ok(list) => Ok(Ok(list.items)),
        Err(err) => match Error::from(err) {
            expired @ Error::CredentialsExpired(_) => Err(expired),
            other => Ok(Err(other.to_string())),
        },
    }
}

/// The subject, out of the list it would be in.
///
/// The two failures are different answers, and this is the only place that
/// keeps them apart. A list that answered and does not hold the name means
/// the object is gone. A list nobody could read means nobody knows, and
/// "not found" there tells a person their object was deleted while it is
/// running.
pub(super) fn found<'a, K>(
    list: &'a Read<K>,
    kind: &str,
    namespace: &str,
    name: &str,
    is_it: impl Fn(&K) -> bool,
) -> Result<&'a K> {
    let items = list.as_ref().map_err(|said| Error::ListUnread {
        kind: kind.to_string(),
        name: name.to_string(),
        said: said.clone(),
    })?;
    items
        .iter()
        .find(|item| is_it(item))
        .ok_or_else(|| Error::not_found(kind, name, namespace))
}

impl Snapshot {
    /// The namespace's pods, Services, Ingresses, claims, autoscalers and
    /// disruption budgets, in six concurrent lists.
    ///
    /// The pods are listed unscoped on purpose. A Service's readiness is a
    /// fact about every pod it selects, and a selector-scoped list would only
    /// ever show the subject's own — which is how a Service that looks empty
    /// from one workload turns out to be served by another.
    pub(super) async fn of(
        ctx: &ResourceContext,
        gateway: Option<&crate::resources::GatewayApiDetection>,
    ) -> Result<Self> {
        let params = ListParams::default();
        let pods_api = ctx.namespaced_api::<Pod>();
        let services_api = ctx.namespaced_api::<Service>();
        let ingresses_api = ctx.namespaced_api::<Ingress>();
        let claims_api = ctx.namespaced_api::<PersistentVolumeClaim>();
        let autoscalers_api = ctx.namespaced_api::<HorizontalPodAutoscaler>();
        let budgets_api = ctx.namespaced_api::<PodDisruptionBudget>();
        let slices_api = ctx.namespaced_api::<EndpointSlice>();
        let (pods, services, ingresses, claims, autoscalers, budgets, slices) = tokio::join!(
            pods_api.list(&params),
            services_api.list(&params),
            ingresses_api.list(&params),
            claims_api.list(&params),
            autoscalers_api.list(&params),
            budgets_api.list(&params),
            slices_api.list(&params),
        );
        let slices = read(slices);
        // The one read that is not in the join, and deliberately: it is the
        // fallback for a cluster that serves no slices, and paying a round
        // trip for it on every call to every other cluster would be the cost
        // this feature is supposed to bring down.
        let legacy = match slices {
            Ok(_) => Err("the slices answered".to_string()),
            Err(_) => read(ctx.namespaced_api::<Endpoints>().list(&params).await),
        };
        let (gateway_routes, gateways) = gateway_lists(ctx, gateway).await;
        Ok(Self {
            pods: read(pods),
            services: read(services),
            ingresses: read(ingresses),
            claims: read(claims),
            autoscalers: read(autoscalers),
            budgets: read(budgets),
            slices,
            legacy,
            gateway_routes,
            gateways,
        })
    }

    /// Whether any list failed, which makes the snapshot one caller's answer
    /// and not one to hand the next.
    pub(super) fn any_unread(&self) -> bool {
        self.pods.is_err()
            || self.services.is_err()
            || self.ingresses.is_err()
            || self.claims.is_err()
            || self.autoscalers.is_err()
            || self.budgets.is_err()
            || (self.slices.is_err() && self.legacy.is_err())
    }

    /// The items, or none where the read did not answer.
    ///
    /// A caller that turns an empty answer into a *statement* — "no Service
    /// fronts this", "this selects no pods" — must not lean on these alone:
    /// the refusal is named in `not_looked_at`, and the surface owes the
    /// reader that instead of the negative.
    pub(super) fn pods(&self) -> &[Pod] {
        self.pods.as_deref().unwrap_or_default()
    }

    pub(super) fn services(&self) -> &[Service] {
        self.services.as_deref().unwrap_or_default()
    }

    pub(super) fn ingresses(&self) -> &[Ingress] {
        self.ingresses.as_deref().unwrap_or_default()
    }

    /// What one Service publishes, from whichever object answered.
    ///
    /// The three sources produce one shape, so nothing downstream branches on
    /// which one spoke — it only says so.
    pub(super) fn published_of(
        &self,
        svc: &Service,
        svc_ref: ObjectRef,
        selected: &[&Pod],
    ) -> ServicePublished {
        match (&self.slices, &self.legacy) {
            (Ok(slices), _) => published::from_slices(
                svc,
                svc_ref,
                &published::slices_of(slices, &svc.name_any()),
                selected,
            ),
            (Err(_), Ok(legacy)) => published::from_legacy(
                svc,
                svc_ref,
                legacy.iter().find(|ep| ep.name_any() == svc.name_any()),
            ),
            (Err(_), Err(_)) => published::from_pod_readiness(svc, svc_ref, selected),
        }
    }
}

/// The Gateway API halves of a snapshot, where the caller brought the
/// cluster's detection along.
///
/// The detection is the frontend's cached one-scan-per-cluster answer —
/// passed in rather than re-derived here, so a workload page costs no CRD
/// list. A route kind whose list fails is read as absent for this call; the
/// page draws the chain it has rather than failing the whole neighbourhood.
///
/// The gateways come back as `None` when that list was never read — no
/// detection, the kind not served, or the list refused. "The API server does
/// not have this Gateway" is a claim only a list that answered can make, and
/// a namespace-scoped reader gets a 403 on this cluster-wide one.
pub(super) async fn gateway_lists(
    ctx: &ResourceContext,
    gateway: Option<&crate::resources::GatewayApiDetection>,
) -> (
    Vec<crate::resources::RouteInfo>,
    Option<Vec<crate::resources::GatewayInfo>>,
) {
    use crate::resources::{GatewayInfo, ListenerSetInfo, RouteInfo};

    let Some(detection) = gateway.filter(|d| d.installed) else {
        return (Vec::new(), None);
    };

    let params = ListParams::default();
    // Cluster-wide on purpose, twice over: a route in another namespace may
    // cross-namespace-target this Service through a ReferenceGrant, and its
    // gateway may live in a third namespace still. Scoping either list to
    // the subject's namespace silently hid both. Kinds list concurrently —
    // six serial round trips were pure latency.
    let fetches = detection.kinds.iter().map(|served| {
        let api_resource = served.api_resource();
        let kind = served.kind.clone();
        let api = ctx.dynamic_api_for_resource(&api_resource, true);
        let params = params.clone();
        async move { (kind, api_resource, api.list(&params).await) }
    });
    let mut routes = Vec::new();
    let mut gateways: Option<Vec<crate::resources::GatewayInfo>> = None;
    // `None` until the kind answers: not having read the sets and having
    // found none are different facts, and the graph reports a route's
    // Gateway missing on the strength of the second.
    let mut sets: Option<Vec<ListenerSetInfo>> = None;
    for (kind, api_resource, list) in futures::future::join_all(fetches).await {
        let Ok(list) = list else { continue };
        match kind.as_str() {
            "HTTPRoute" | "GRPCRoute" | "TLSRoute" | "TCPRoute" | "UDPRoute" => {
                routes.extend(list.items.into_iter().map(|obj| {
                    RouteInfo::read(&crate::commands::gateway::with_types(obj, &api_resource))
                }));
            }
            "Gateway" => {
                gateways
                    .get_or_insert_with(Vec::new)
                    .extend(list.items.into_iter().map(|obj| {
                        GatewayInfo::read(&crate::commands::gateway::with_types(obj, &api_resource))
                    }));
            }
            "ListenerSet" => {
                sets.get_or_insert_with(Vec::new)
                    .extend(list.items.into_iter().map(|obj| {
                        ListenerSetInfo::read(&crate::commands::gateway::with_types(
                            obj,
                            &api_resource,
                        ))
                    }));
            }
            _ => {}
        }
    }
    // Without this every Gateway here carries an empty set list that nothing
    // marked unread, and a route naming a ListenerSet resolves to no Gateway
    // at all — which the graph then reports as a Gateway that does not exist.
    if let Some(gateways) = gateways.as_mut() {
        for gateway in gateways.iter_mut() {
            gateway.merge_listener_sets(sets.as_deref());
        }
    }
    (routes, gateways)
}

#[cfg(test)]
mod refused_list_tests {
    use super::*;

    const REFUSED: &str = "ApiError: services is forbidden: User \
         \"system:serviceaccount:k8s-gui-test:narrow\" cannot list resource \
         \"services\" in API group \"\" in the namespace \"k8s-gui-test\": Forbidden";

    fn named(name: &str) -> Service {
        Service {
            metadata: kube::core::ObjectMeta {
                name: Some(name.to_string()),
                ..Default::default()
            },
            ..Default::default()
        }
    }

    /// The failure this half of the fix is about. A token refused `services`
    /// was told the Service it had open did not exist, which sends a person
    /// to rebuild something that is running.
    #[test]
    fn a_subject_whose_list_was_refused_is_unknown_rather_than_gone() {
        let refused: Read<Service> = Err(REFUSED.to_string());
        let err = found(&refused, "Service", "shop", "shop", |svc| {
            svc.name_any() == "shop"
        })
        .expect_err("a refused list cannot answer");

        match err {
            Error::ListUnread { kind, name, said } => {
                assert_eq!(kind, "Service");
                assert_eq!(name, "shop");
                assert!(said.contains("is forbidden"), "the cluster's own words");
            }
            other => panic!("a refusal is not {other:?}"),
        }
    }

    /// The panel prints this message, and "shop is not there" without the
    /// namespace is a different claim from "shop is not there **in shop**"
    /// on a cluster where the same name exists elsewhere. The test asserted
    /// only the variant, which is how the empty string survived.
    #[test]
    fn the_not_found_message_says_where_it_looked() {
        let answered: Read<Service> = Ok(Vec::new());
        let err = found(&answered, "Service", "shop", "web", |svc: &Service| {
            svc.name_any() == "web"
        })
        .expect_err("a list that answered and lacks the name");

        match err {
            Error::NotFound {
                kind,
                name,
                namespace,
            } => {
                assert_eq!((kind.as_str(), name.as_str()), ("Service", "web"));
                assert_eq!(
                    namespace, "shop",
                    "the panel says where it looked, or the claim is about the cluster"
                );
            }
            other => panic!("a list that answered gives NotFound, not {other:?}"),
        }
    }

    /// Every list this reads goes through `read`, and that is where an
    /// error keeps or loses its identity. `kube::Error`'s own Display is
    /// neither the cluster's sentence nor a marker the frontend can match:
    /// a 401 carried no `CREDENTIALS_EXPIRED:` so the session-expiry screen
    /// never came up, a timed-out read carried no `READ_DEADLINE:`, and an
    /// API failure printed kube 4's `Status` struct at the reader.
    #[test]
    fn a_refused_list_keeps_the_words_the_rest_of_the_app_matches_on() {
        let status = |code: u16, message: &str| {
            kube::Error::Api(Box::new(kube::core::Status {
                code,
                message: message.to_string(),
                reason: message.to_string(),
                status: None,
                details: None,
                metadata: Option::default(),
            }))
        };

        let expired: Read<Pod> = read(Err(status(401, "Unauthorized")));
        assert!(
            expired
                .as_ref()
                .expect_err("401 is a failure")
                .starts_with("CREDENTIALS_EXPIRED:"),
            "the wire marker is how the app notices a session is over: {expired:?}"
        );

        let refused: Read<Pod> = read(Err(status(403, "pods is forbidden")));
        let said = refused.expect_err("403 is a failure");
        assert!(
            said.contains("pods is forbidden"),
            "the cluster's own words, not a struct dump: {said}"
        );
        assert!(
            !said.contains("Status {"),
            "kube's Debug output is not a sentence: {said}"
        );
    }

    /// The accessors' documented rule, which nothing checked: they hand a
    /// refusal back as an empty slice, so a caller that turns emptiness
    /// into a statement says it about a list nobody read. This holds the
    /// shape — a refusal is indistinguishable through the accessor — so
    /// that the guards at the verdict sites are the only thing standing
    /// between a 403 and "there is simply nothing behind it".
    #[test]
    fn the_accessors_cannot_tell_a_refusal_from_an_empty_list() {
        let refused = all_refused();
        let answered = Snapshot {
            pods: Ok(Vec::new()),
            services: Ok(Vec::new()),
            ingresses: Ok(Vec::new()),
            ..all_refused()
        };

        assert!(refused.pods().is_empty());
        assert!(answered.pods().is_empty());
        assert_eq!(refused.pods().len(), answered.pods().len());

        // Which is why the difference has to be read off the `Result`, and
        // every verdict site does exactly that.
        assert!(refused.pods.is_err());
        assert!(answered.pods.is_ok());
        assert!(refused.services.is_err());
        assert!(refused.ingresses.is_err());
    }

    /// The whole neighbourhood, with every list refused, for the verdict
    /// tests below. Only the subject's own read has to succeed.
    fn all_refused() -> Snapshot {
        Snapshot {
            pods: Err(REFUSED.to_string()),
            services: Err(REFUSED.to_string()),
            ingresses: Err(REFUSED.to_string()),
            claims: Err(REFUSED.to_string()),
            autoscalers: Err(REFUSED.to_string()),
            budgets: Err(REFUSED.to_string()),
            slices: Err(REFUSED.to_string()),
            legacy: Err(REFUSED.to_string()),
            gateways: None,
            gateway_routes: Vec::new(),
        }
    }

    fn selecting(name: &str, selector: &[(&str, &str)]) -> Service {
        let mut svc = Service::default();
        svc.metadata.name = Some(name.to_string());
        svc.metadata.namespace = Some("shop".to_string());
        svc.spec = Some(k8s_openapi::api::core::v1::ServiceSpec {
            selector: Some(
                selector
                    .iter()
                    .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
                    .collect(),
            ),
            ..Default::default()
        });
        svc
    }

    /// The defect this PR exists to remove, found on the page it did not
    /// cover: `snapshot.pods()` is `unwrap_or_default()`, so a refused pod
    /// list is an empty slice and the Service page said "No pod carries
    /// app=shop" — in red, beside "there is simply nothing behind it" —
    /// about a Service whose pods nobody was allowed to look at.
    ///
    /// Deleting the `pods.is_err()` guard in `note_reach` puts that back.
    #[test]
    fn a_service_whose_pods_were_refused_does_not_claim_it_selects_nothing() {
        let svc = selecting("shop", &[("app", "shop")]);
        let svc_ref = service_ref(&svc, "shop");
        let mut out = Neighbourhood::new();

        note_reach(&svc, &svc_ref, &all_refused(), &mut out, true);

        assert!(
            !out.stops
                .iter()
                .any(|stop| matches!(stop, ChainStop::SelectsNothing { .. })),
            "a list nobody read is not a selector that matched nothing: {:?}",
            out.stops
        );
    }

    /// And the other half: a pod list that really answered and really holds
    /// nothing matching is a Service selecting nothing, which is worth
    /// saying plainly and in red.
    #[test]
    fn a_service_whose_pods_answered_and_matched_nothing_still_says_so() {
        let svc = selecting("shop", &[("app", "shop")]);
        let svc_ref = service_ref(&svc, "shop");
        let mut out = Neighbourhood::new();
        let answered = Snapshot {
            pods: Ok(Vec::new()),
            ..all_refused()
        };

        note_reach(&svc, &svc_ref, &answered, &mut out, true);

        assert!(
            out.stops
                .iter()
                .any(|stop| matches!(stop, ChainStop::SelectsNothing { .. })),
            "an answered, empty list is a real finding: {:?}",
            out.stops
        );
    }

    /// The other half, and why the first is not "always say unknown": a list
    /// that really answered and really lacks the name is the object being
    /// gone, which is worth saying plainly.
    #[test]
    fn a_subject_absent_from_a_list_that_answered_is_still_not_found() {
        let answered: Read<Service> = Ok(vec![named("carts")]);
        let err = found(&answered, "Service", "shop", "shop", |svc| {
            svc.name_any() == "shop"
        })
        .expect_err("the list answered and does not hold it");

        assert!(
            matches!(err, Error::NotFound { .. }),
            "a list that answered still reports a missing object as missing"
        );
    }

    #[test]
    fn a_subject_a_list_holds_is_returned() {
        let answered: Read<Service> = Ok(vec![named("shop")]);
        let svc = found(&answered, "Service", "shop", "shop", |svc| {
            svc.name_any() == "shop"
        })
        .expect("it is right there");
        assert_eq!(svc.name_any(), "shop");
    }

    /// Every refused list reaches the one place the page collects them, so a
    /// group that goes quiet has a reason beside it rather than reading as
    /// "there are none".
    #[test]
    fn each_refused_list_is_named_among_the_kinds_nobody_looked_at() {
        let snapshot = Snapshot {
            pods: Err("pods is forbidden".to_string()),
            services: Err(REFUSED.to_string()),
            ingresses: Err("ingresses.networking.k8s.io is forbidden".to_string()),
            claims: Err("persistentvolumeclaims is forbidden".to_string()),
            autoscalers: Ok(Vec::new()),
            budgets: Ok(Vec::new()),
            slices: Ok(Vec::new()),
            legacy: Err("the slices answered".to_string()),
            gateway_routes: Vec::new(),
            gateways: None,
        };

        let unread = unanswered(&snapshot);
        for kind in ["Pod", "Service", "Ingress", "PersistentVolumeClaim"] {
            assert!(
                unread.iter().any(|entry| entry.kind == kind),
                "{kind} was refused and is not named"
            );
        }
    }

    /// The fix this file exists for, on the page it was added to last.
    ///
    /// An Ingress whose backend Service is not in a list the cluster
    /// refused must not be called missing: `Missing` renders as "routes to a
    /// backend that was never created" and brings a stop that paints the hop
    /// red. Both conditions sat in a loop that runs only against a cluster,
    /// so either could be inverted with the whole suite green.
    #[test]
    fn a_backend_in_a_refused_list_is_not_a_backend_that_was_never_created() {
        let (refused, stops) = absent_backend("checkout", "shop", false);
        assert_eq!(refused.existence, Existence::NotChecked);
        assert!(!stops, "a list nobody read does not stop the path");

        let (answered, stops) = absent_backend("checkout", "shop", true);
        assert_eq!(answered.existence, Existence::Missing);
        assert!(stops, "a list that answered and lacks it does");
    }
}

#[cfg(test)]
mod read_live_tests {
    use super::*;
    use k8s_openapi::api::core::v1::ConfigMap;

    fn refused(code: u16, reason: &str) -> kube::Result<kube::core::ObjectList<ConfigMap>> {
        Err(kube::Error::Api(Box::new(kube::core::Status {
            status: Some(kube::core::response::StatusSummary::Failure),
            message: format!("{reason} for this list"),
            reason: reason.to_string(),
            code,
            metadata: None,
            details: None,
        })))
    }

    /// A 401 inside a panel that reads only lists came back as a graph with
    /// six kinds unread, and the sign-in the session needed was never asked.
    #[test]
    fn an_expired_session_ends_the_call() {
        assert!(matches!(
            read_live(refused(401, "Unauthorized")),
            Err(Error::CredentialsExpired(_))
        ));
    }

    /// A refusal of one kind is still one kind unread.
    #[test]
    fn a_refused_kind_is_part_of_the_answer() {
        let answer = read_live(refused(403, "Forbidden")).expect("an answer");
        assert!(answer.expect_err("unread").contains("Forbidden"));
    }
}

#[cfg(test)]
mod shared_tests {
    use super::*;
    use crate::client::served::test_server::server;

    const NS: &str = "shop";

    fn empty() -> String {
        serde_json::json!({ "apiVersion": "v1", "kind": "List", "metadata": {}, "items": [] })
            .to_string()
    }

    /// Every list a snapshot takes, answering empty; `pods` as given.
    fn routes(pods: (u16, String)) -> Vec<(&'static str, u16, String)> {
        vec![
            ("/api/v1/namespaces/shop/pods", pods.0, pods.1),
            ("/api/v1/namespaces/shop/services", 200, empty()),
            (
                "/api/v1/namespaces/shop/persistentvolumeclaims",
                200,
                empty(),
            ),
            (
                "/apis/networking.k8s.io/v1/namespaces/shop/ingresses",
                200,
                empty(),
            ),
            (
                "/apis/autoscaling/v2/namespaces/shop/horizontalpodautoscalers",
                200,
                empty(),
            ),
            (
                "/apis/policy/v1/namespaces/shop/poddisruptionbudgets",
                200,
                empty(),
            ),
            (
                "/apis/discovery.k8s.io/v1/namespaces/shop/endpointslices",
                200,
                empty(),
            ),
        ]
    }

    fn pod_lists(hits: &crate::client::served::test_server::Hits) -> usize {
        hits.lock()
            .unwrap()
            .get("/api/v1/namespaces/shop/pods")
            .copied()
            .unwrap_or(0)
    }

    /// Twelve cards asking at once are one set of lists, and asking again
    /// inside the second is none; after it, the lists are read again.
    #[tokio::test]
    async fn calls_together_share_one_read_for_as_long_as_it_is_kept() {
        let (client, hits) = server(routes((200, empty()))).await;
        let ctx = ResourceContext::from_client(client, NS.to_string());
        let snapshots = Snapshots {
            kept_for: std::time::Duration::from_millis(300),
            ..Snapshots::default()
        };

        let asks = (0..12).map(|_| snapshots.get("kind", &ctx, None));
        for answer in futures::future::join_all(asks).await {
            assert!(answer.expect("a snapshot").pods.is_ok());
        }
        snapshots.get("kind", &ctx, None).await.expect("again");
        assert_eq!(pod_lists(&hits), 1);

        tokio::time::sleep(std::time::Duration::from_millis(350)).await;
        snapshots.get("kind", &ctx, None).await.expect("later");
        assert_eq!(pod_lists(&hits), 2);
    }

    /// A read in flight is shared however long it takes; only a finished
    /// one ages out. Expiring the flight too gave each of twelve cards a
    /// read of its own the moment the window was shorter than the lists.
    #[tokio::test]
    async fn a_read_in_flight_is_shared_even_past_the_window() {
        let (client, hits) = server(routes((200, empty()))).await;
        let ctx = ResourceContext::from_client(client, NS.to_string());
        let snapshots = Snapshots {
            kept_for: std::time::Duration::ZERO,
            ..Snapshots::default()
        };
        let asks = (0..12).map(|_| snapshots.get("kind", &ctx, None));
        futures::future::join_all(asks).await;
        assert_eq!(pod_lists(&hits), 1);
    }

    /// A refusal reaches the callers who were waiting for that read, and no
    /// one after: the next call asks the cluster again.
    #[tokio::test]
    async fn a_snapshot_with_a_refused_list_is_not_handed_to_the_next_caller() {
        let (client, hits) = server(routes((403, "{}".to_string()))).await;
        let ctx = ResourceContext::from_client(client, NS.to_string());
        let snapshots = Snapshots::default();

        let first = snapshots.get("kind", &ctx, None).await.expect("a snapshot");
        assert!(
            first.pods.is_err(),
            "the refusal is carried, not an empty list"
        );
        snapshots.get("kind", &ctx, None).await.expect("again");
        assert_eq!(pod_lists(&hits), 2);
    }
}
