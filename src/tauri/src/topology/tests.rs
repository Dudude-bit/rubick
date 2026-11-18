use super::*;
use crate::resources::topology::{MapKindReading, TopologyEnd, TopologyPiece};
use crate::resources::Existence;
use serde_json::json;

const SAID: &str =
    "deployments.apps is forbidden: User \"narrow\" cannot list resource \"deployments\"";

fn deployment(ns: &str, name: &str) -> Object {
    Object::Deployment(Box::new(
        serde_json::from_value(json!({
            "metadata": { "name": name, "namespace": ns, "uid": format!("{ns}-{name}") },
            "spec": { "selector": { "matchLabels": { "app": name } },
                      "template": { "metadata": { "labels": { "app": name } } } },
        }))
        .expect("a Deployment"),
    ))
}

fn read(kind: Kind, namespace: Option<&str>, reading: Reading) -> Feed {
    Feed::Read {
        kind,
        namespace: namespace.map(str::to_string),
        reading,
    }
}

fn now() -> chrono::DateTime<chrono::Utc> {
    chrono::Utc::now()
}

/// A token refused Deployments across the cluster and allowed them in
/// `shop` reads them there and nowhere else: the other namespace's answer is
/// the refusal in the cluster's words, never an empty list.
#[test]
fn a_kind_refused_across_the_cluster_is_read_in_the_namespaces_that_answered() {
    let mut stores = Stores::default();
    stores.apply(read(
        Kind::Deployment,
        None,
        Reading::Refused {
            message: SAID.into(),
        },
    ));
    stores.apply(read(Kind::Deployment, Some("shop"), Reading::Synced));
    stores.apply(Feed::Applied(deployment("shop", "cart")));

    let shop = stores.held("shop", OtherPolicies::none(), now());
    assert_eq!(shop.deployments.map(|list| list.len()), Ok(1));
    let other = stores.held("billing", OtherPolicies::none(), now());
    assert_eq!(
        other.deployments.map(|list| list.len()),
        Err(SAID.to_string())
    );

    let kinds = stores.kinds();
    let deployments = kinds
        .iter()
        .find(|k| k.kind == "Deployment")
        .expect("listed");
    assert_eq!(
        deployments.reading,
        MapKindReading::NamespacesOnly {
            namespaces: vec!["shop".into()],
            said: SAID.into()
        }
    );
}

/// A kind still listing is not an empty one: its namespaces hold no list
/// for it, and the rail says it is syncing.
#[test]
fn a_kind_still_listing_is_unread_rather_than_empty() {
    let mut stores = Stores::default();
    stores.apply(read(Kind::Pod, None, Reading::Syncing));
    assert!(stores
        .held("shop", OtherPolicies::none(), now())
        .pods
        .is_err());
    assert!(stores.syncing());
    let pods = stores
        .kinds()
        .into_iter()
        .find(|k| k.kind == "Pod")
        .expect("listed");
    assert_eq!(pods.reading, MapKindReading::Syncing);
}

/// A Gateway API kind the layer has said nothing of yet is waiting for its
/// watch: the layer says `Unserved` of every kind a cluster does not serve,
/// so silence was never "not installed". Fails if a kind waiting its turn
/// reads as not installed, is drawn as having no routes, or does not hold
/// the first drawing back.
#[test]
fn a_gateway_kind_the_layer_has_not_answered_is_waiting_not_missing() {
    let stores = Stores::default();
    let held = stores.held("shop", OtherPolicies::none(), now());
    assert!(held
        .gateway_unread
        .iter()
        .any(|unread| unread.kind == "HTTPRoute"));
    assert!(held.gateways.is_none());
    let routes = stores
        .kinds()
        .into_iter()
        .find(|k| k.kind == "HTTPRoute")
        .expect("listed");
    assert_eq!(routes.reading, MapKindReading::Queued);
    assert!(stores.syncing());
}

fn gateway_api(
    kind: &str,
    ns: &str,
    name: &str,
    spec: &serde_json::Value,
) -> kube::api::DynamicObject {
    serde_json::from_value(json!({
        "apiVersion": "gateway.networking.k8s.io/v1", "kind": kind,
        "metadata": { "name": name, "namespace": ns, "uid": format!("{ns}-{name}") },
        "spec": spec,
    }))
    .expect("a Gateway API object")
}

/// `shop/api` attaches to `infra/public`, the usual way Gateway API is set
/// up, and `shop/local` is a Gateway the route does not name.
fn routed(stores: &mut Stores) {
    for kind in [Kind::Gateway, Kind::HttpRoute] {
        stores.apply(read(kind, None, Reading::Synced));
    }
    stores.apply(Feed::Applied(Object::HttpRoute(Box::new(RouteInfo::read(
        &gateway_api(
            "HTTPRoute",
            "shop",
            "api",
            &json!({ "parentRefs": [{ "name": "public", "namespace": "infra" }] }),
        ),
    )))));
    stores.apply(Feed::Applied(Object::Gateway(Box::new(GatewayInfo::read(
        &gateway_api(
            "Gateway",
            "shop",
            "local",
            &json!({ "gatewayClassName": "x", "listeners": [] }),
        ),
    )))));
}

const PUBLIC: &str = "gateway.networking.k8s.io/Gateway/infra/public";

/// A person picks `shop` and opens the map: the watch layer hands over only
/// `shop`'s Gateways, and `infra/public` was drawn as missing, in red, on a
/// healthy cluster. Fails if a Gateway outside what was read is called
/// missing, or if the namespace's own Gateway stops being drawn.
#[test]
fn a_gateway_outside_the_scope_is_not_checked_rather_than_missing() {
    let mut scoped = Stores {
        scoped: true,
        ..Stores::default()
    };
    routed(&mut scoped);
    let slice = crate::commands::connections::map::slice_of(
        scoped.held("shop", OtherPolicies::none(), now()),
        now(),
    );
    assert_eq!(slice.nodes[PUBLIC].object.existence, Existence::NotChecked);
    assert!(matches!(
        &slice.nodes["gateway.networking.k8s.io/HTTPRoute/shop/api"].verdict,
        crate::resources::topology::NodeVerdict::Route { stops, .. } if stops.is_empty()
    ));
    assert!(matches!(
        slice.nodes["gateway.networking.k8s.io/Gateway/shop/local"].verdict,
        crate::resources::topology::NodeVerdict::Gateway { .. }
    ));

    // The whole cluster read is the one list that may call it missing.
    let mut whole = Stores::default();
    routed(&mut whole);
    let slice = crate::commands::connections::map::slice_of(
        whole.held("shop", OtherPolicies::none(), now()),
        now(),
    );
    assert_eq!(slice.nodes[PUBLIC].object.existence, Existence::Missing);
}

/// The cluster refused Gateways everywhere and another page's scope had the
/// layer read `shop` alone: what `shop` holds is not every Gateway.
#[test]
fn gateways_read_in_one_namespace_never_call_another_s_missing() {
    let mut stores = Stores::default();
    routed(&mut stores);
    stores.apply(read(
        Kind::Gateway,
        None,
        Reading::Refused {
            message: "gateways is forbidden".into(),
        },
    ));
    stores.apply(read(Kind::Gateway, Some("shop"), Reading::Synced));
    let slice = crate::commands::connections::map::slice_of(
        stores.held("shop", OtherPolicies::none(), now()),
        now(),
    );
    assert_eq!(slice.nodes[PUBLIC].object.existence, Existence::NotChecked);
}

/// A token that cannot list `HTTPRoutes` in `shop` counted "0" of them beside
/// the lock, so a namespace where nothing could be read never read as
/// refused. Fails if a route kind not read here counts anything.
#[test]
fn a_route_kind_not_read_counts_nothing() {
    let mut stores = Stores::default();
    routed(&mut stores);
    stores.apply(read(
        Kind::GrpcRoute,
        None,
        Reading::Refused {
            message: "grpcroutes is forbidden".into(),
        },
    ));
    let slice = crate::commands::connections::map::slice_of(
        stores.held("shop", OtherPolicies::none(), now()),
        now(),
    );
    let count = |kind: &str| {
        slice
            .read
            .counts
            .iter()
            .find(|count| count.kind == kind)
            .and_then(|count| count.count)
    };
    assert_eq!(count("HTTPRoute"), Some(1));
    assert_eq!(count("GRPCRoute"), None);
    assert_eq!(count("UDPRoute"), None);
}

/// A Gateway going unprogrammed, a route changing, or a Namespace coming or
/// going changes what other namespaces draw, and only the Gateway's own
/// namespace was drawn again: the route in `shop` kept its old verdict, and a
/// new Namespace never appeared. Fails if any of them touches less than
/// every namespace, or a Deployment touches more than its own.
#[test]
fn a_kind_one_namespace_names_from_another_touches_every_namespace() {
    let mut stores = Stores::default();
    routed(&mut stores);
    let gateway = Object::Gateway(Box::new(GatewayInfo::read(&gateway_api(
        "Gateway",
        "infra",
        "public",
        &json!({ "gatewayClassName": "x", "listeners": [] }),
    ))));
    assert!(stores.apply(Feed::Applied(gateway.clone())).all);
    assert!(stores.apply(Feed::Deleted(gateway)).all);
    let namespace = Object::Namespace(Box::new(Named {
        namespace: String::new(),
        name: "fresh".into(),
        labels: BTreeMap::new(),
    }));
    assert!(stores.apply(Feed::Applied(namespace)).all);
    let touched = stores.apply(Feed::Applied(deployment("shop", "cart")));
    assert!(!touched.all);
    assert_eq!(touched.namespaces, BTreeSet::from(["shop".to_string()]));
}

/// A marked relist replaces what one slot held, and names the namespace an
/// object left as touched: without it a deleted Deployment stays drawn.
#[test]
fn a_relist_replaces_its_slot_and_touches_the_namespaces_it_emptied() {
    let mut stores = Stores::default();
    stores.apply(read(Kind::Deployment, None, Reading::Synced));
    stores.apply(Feed::Applied(deployment("shop", "cart")));
    stores.apply(Feed::Applied(deployment("billing", "ledger")));
    let touched = stores.apply(Feed::Relisted {
        kind: Kind::Deployment,
        namespace: None,
        objects: vec![deployment("billing", "ledger")],
    });
    assert!(touched.namespaces.contains("shop"));
    assert_eq!(
        stores
            .held("shop", OtherPolicies::none(), now())
            .deployments
            .map(|l| l.len()),
        Ok(0)
    );
}

/// Helm keeps every release as a Secret; the map never names one, and only
/// Warnings are kept of the events.
#[test]
fn helm_release_secrets_and_ordinary_events_are_not_kept() {
    let secret: k8s_openapi::api::core::v1::Secret = serde_json::from_value(json!({
        "metadata": { "name": "sh.helm.release.v1.web.v1", "namespace": "shop" },
        "type": "helm.sh/release.v1",
    }))
    .expect("a Secret");
    assert!(Object::secret(&secret).is_none());
    let event: k8s_openapi::api::core::v1::Event = serde_json::from_value(json!({
        "metadata": { "name": "e", "namespace": "shop" },
        "involvedObject": {}, "type": "Normal",
    }))
    .expect("an Event");
    assert!(Object::warning(event).is_none());
}

fn opening(
    map: Arc<ClusterMap>,
    events: &broadcast::Sender<crate::state::AppEvent>,
) -> (stream::Opening, CancellationToken) {
    let cancel = CancellationToken::new();
    (
        stream::Opening {
            stream_id: "map-1".into(),
            scope: Some(vec!["shop".into()]),
            others: OtherPolicies::none(),
            reread: None,
            session: None,
            map,
            events: events.clone(),
            cancel: cancel.clone(),
            lease: None,
        },
        cancel,
    )
}

fn pieces_of(event: &crate::state::AppEvent) -> Vec<String> {
    match event {
        crate::state::AppEvent::TopologyBatch { pieces, .. } => pieces
            .iter()
            .filter(|piece| !matches!(piece, TopologyPiece::Namespace { .. }))
            .map(|piece| match piece {
                TopologyPiece::Node { node } => node.id.clone(),
                TopologyPiece::Kinds { .. } => "kinds".into(),
                other => format!("{other:?}"),
            })
            .collect(),
        crate::state::AppEvent::TopologyReady { .. } => vec!["ready".into()],
        other => vec![format!("{other:?}")],
    }
}

async fn next(rx: &mut broadcast::Receiver<crate::state::AppEvent>) -> Vec<String> {
    let event = tokio::time::timeout(std::time::Duration::from_mins(1), rx.recv())
        .await
        .expect("an event in time")
        .expect("open");
    pieces_of(&event)
}

/// A stream draws its scope once, says so, then sends one Deployment's
/// change as that node alone; a stop and a replaced client each end it in
/// their own words.
#[tokio::test]
async fn a_stream_draws_its_scope_then_only_what_a_feed_changed() {
    let map = Arc::new(ClusterMap::default());
    map.feed(every_kind_read());
    map.feed([Feed::Applied(deployment("shop", "cart"))]);
    let (events, mut rx) = broadcast::channel(64);
    let (open, cancel) = opening(map.clone(), &events);
    let task = tokio::spawn(stream::run(open));

    assert_eq!(next(&mut rx).await, vec!["kinds"]);
    let first = next(&mut rx).await;
    assert!(
        first.contains(&"apps/Deployment/shop/cart".to_string()),
        "{first:?}"
    );
    assert_eq!(next(&mut rx).await, vec!["ready"]);

    map.feed([Feed::Applied(deployment("shop", "ledger"))]);
    assert_eq!(next(&mut rx).await, vec!["apps/Deployment/shop/ledger"]);

    cancel.cancel();
    assert_eq!(task.await.expect("ends"), TopologyEnd::Closed);

    let (open, _) = opening(map.clone(), &events);
    let task = tokio::spawn(stream::run(open));
    while next(&mut rx).await != vec!["ready"] {}
    map.end();
    assert_eq!(task.await.expect("ends"), TopologyEnd::Replaced);
}

/// Every kind answered, so a stream draws at once rather than waiting for
/// the kinds the layer has said nothing of.
fn every_kind_read() -> Vec<Feed> {
    Kind::ALL
        .iter()
        .map(|&kind| read(kind, None, Reading::Synced))
        .collect()
}

/// A Cilium policy applied to `shop` while the map was open left every
/// workload there saying no policy selects it, for as long as the page
/// stayed open. Fails if the stream does not read the other engines again
/// and draw what that changes.
#[tokio::test]
async fn a_policy_of_another_engine_applied_while_the_map_is_open_is_drawn() {
    let map = Arc::new(ClusterMap::default());
    map.feed(every_kind_read());
    map.feed([Feed::Applied(deployment("shop", "cart"))]);
    let (events, mut rx) = broadcast::channel(64);
    let (mut open, cancel) = opening(map.clone(), &events);
    open.reread = Some(Arc::new(|| {
        Box::pin(async {
            let mut others = OtherPolicies::none();
            others.within("shop", "CiliumNetworkPolicy");
            Some(others)
        })
    }));
    let task = tokio::spawn(stream::run(open));
    while next(&mut rx).await != vec!["ready"] {}
    let again = next(&mut rx).await;
    assert!(
        again.contains(&"apps/Deployment/shop/cart".to_string()),
        "{again:?}"
    );
    cancel.cancel();
    assert_eq!(task.await.expect("ends"), TopologyEnd::Closed);
}

/// The token expired and could not be renewed: every watch failed with
/// words and no `CREDENTIALS_EXPIRED:` prefix, and the map sat stale with no
/// sign-in prompt. Fails if a failing read does not ask whether the session
/// is over, or the answer does not end the map with the words the frontend
/// asks for a sign-in on.
#[tokio::test]
async fn a_map_whose_session_expired_ends_saying_so() {
    let said = "CREDENTIALS_EXPIRED: the cluster rejected this session's credentials: Unauthorized";
    let map = Arc::new(ClusterMap::default());
    map.feed(every_kind_read());
    map.feed([read(
        Kind::Pod,
        None,
        Reading::Failed {
            message: "watch stream failed: Unauthorized".into(),
        },
    )]);
    let (events, mut rx) = broadcast::channel(64);
    let (mut open, _cancel) = opening(map.clone(), &events);
    open.session = Some(Arc::new(move || {
        Box::pin(async move { Some(said.to_string()) })
    }));
    let task = tokio::spawn(stream::run(open));
    while next(&mut rx).await != vec!["ready"] {}
    assert_eq!(
        tokio::time::timeout(std::time::Duration::from_secs(30), task)
            .await
            .expect("ends in time")
            .expect("ends"),
        TopologyEnd::Failed { said: said.into() }
    );
}

fn dynamic(value: serde_json::Value) -> Arc<kube::api::DynamicObject> {
    Arc::new(serde_json::from_value(value).expect("a dynamic object"))
}

fn slot(kind: Kind, namespace: Option<&str>) -> crate::ownership::SlotKey {
    crate::ownership::SlotKey {
        kind: kind.key(),
        namespace: namespace.map(str::to_string),
    }
}

/// The layer hands list items over without `apiVersion` or `kind`, as the
/// API server lists them; the map must still read them as their kind, and
/// keep of a `ConfigMap` its name and labels and never its data.
#[test]
fn a_layer_update_is_kept_as_the_map_keeps_its_kind() {
    let types = std::collections::BTreeMap::new();
    let deployment = dynamic(json!({
        "metadata": { "name": "cart", "namespace": "shop", "uid": "cart",
                      "annotations": { "kubectl.kubernetes.io/last-applied-configuration": "{}" } },
        "spec": { "selector": { "matchLabels": { "app": "cart" } }, "template": { "metadata": {} } },
    }));
    let config = dynamic(json!({
        "metadata": { "name": "cart-config", "namespace": "shop", "labels": { "app": "cart" } },
        "data": { "password": "kept by nobody" },
    }));
    let feeds = feed::feeds_of(
        crate::feeds::Update::Whole {
            slot: slot(Kind::Deployment, None),
            why: crate::feeds::Whole::Fresh,
            objects: vec![deployment],
        },
        &types,
    );
    let Some(Feed::Relisted { objects, .. }) = feeds.first() else {
        panic!("a relist, not {feeds:?}");
    };
    let Some(Object::Deployment(read)) = objects.first() else {
        panic!("a Deployment, not {objects:?}");
    };
    assert!(read
        .metadata
        .annotations
        .clone()
        .unwrap_or_default()
        .is_empty());
    let feeds = feed::feeds_of(
        crate::feeds::Update::Applied {
            slot: slot(Kind::ConfigMap, None),
            object: config,
        },
        &types,
    );
    let Some(Feed::Applied(Object::ConfigMap(named))) = feeds.first() else {
        panic!("a ConfigMap, not {feeds:?}");
    };
    assert_eq!(named.name, "cart-config");
    assert_eq!(named.labels.get("app").map(String::as_str), Some("cart"));
}

/// "Not installed" is the layer's own `Unserved`, and it is a finding only
/// for the Gateway API kinds: an `EndpointSlice` the cluster does not serve
/// is a list not read, never one with nothing in it.
#[test]
fn unserved_is_not_installed_for_gateway_kinds_and_unread_for_the_others() {
    let types = std::collections::BTreeMap::new();
    let mut stores = Stores::default();
    for kind in [Kind::HttpRoute, Kind::EndpointSlice] {
        for feed in feed::feeds_of(
            crate::feeds::Update::State {
                slot: slot(kind, None),
                state: Reading::Unserved,
            },
            &types,
        ) {
            stores.apply(feed);
        }
    }
    let kinds = stores.kinds();
    let reading = |kind: &str| {
        kinds
            .iter()
            .find(|state| state.kind == kind)
            .map(|state| state.reading.clone())
    };
    assert_eq!(reading("HTTPRoute"), Some(MapKindReading::NotServed));
    assert_eq!(reading("EndpointSlice"), Some(MapKindReading::Unserved));
    let held = stores.held("shop", OtherPolicies::none(), now());
    assert!(!held
        .gateway_unread
        .iter()
        .any(|unread| unread.kind == "HTTPRoute"));
    assert!(held.slices.is_err());
}

/// The layer closing the channel is the cluster let go: the map ends, and
/// every stream on it ends with it rather than drawing a cluster nobody
/// reads any more.
#[tokio::test]
async fn a_map_ends_when_the_layer_closes_its_channel() {
    let (tx, rx) = tokio::sync::mpsc::channel(8);
    let map = Arc::new(ClusterMap::default());
    let pumping = tokio::spawn(pump(
        rx,
        map.clone(),
        std::collections::BTreeMap::new(),
        BTreeSet::new(),
        None,
    ));
    tx.send(crate::feeds::Update::State {
        slot: slot(Kind::Deployment, None),
        state: Reading::Synced,
    })
    .await
    .expect("sent");
    drop(tx);
    pumping.await.expect("the pump ends");
    assert!(map.ended().is_cancelled());
    assert_eq!(
        map.stores()
            .held("shop", OtherPolicies::none(), now())
            .deployments
            .map(|list| list.len()),
        Ok(0)
    );
}

/// A pod no workload owns states what it uses only in its own spec. Read
/// from a pod as the watch layer delivers it, a Secret it takes its whole
/// environment from must still be drawn: without the reference the edge is
/// silently absent, which reads as "uses nothing".
#[test]
fn a_pod_level_use_through_env_from_survives_the_layer_s_cut() {
    let mut pod: kube::api::DynamicObject = serde_json::from_value(json!({
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {
            "name": "db-1", "namespace": "shop", "uid": "db-1",
            "ownerReferences": [{ "apiVersion": "postgresql.cnpg.io/v1", "kind": "Cluster",
                                  "name": "db", "uid": "db", "controller": true }],
        },
        "spec": {
            "volumes": [{ "name": "conf", "configMap": { "name": "db-conf" } }],
            "containers": [{
                "name": "postgres",
                "envFrom": [{ "secretRef": { "name": "db-env" } }],
                "volumeMounts": [{ "name": "conf", "mountPath": "/etc/db" }],
            }],
        },
        "status": { "phase": "Running" },
    }))
    .expect("a pod");
    crate::feeds::trim_pod(&mut pod);
    let mut stores = Stores::default();
    for kind in [Kind::Pod, Kind::Secret] {
        stores.apply(read(kind, None, Reading::Synced));
    }
    for feed in feed::feeds_of(
        crate::feeds::Update::Applied {
            slot: slot(Kind::Pod, None),
            object: Arc::new(pod),
        },
        &std::collections::BTreeMap::new(),
    ) {
        stores.apply(feed);
    }
    let slice = crate::commands::connections::map::slice_of(
        stores.held("shop", OtherPolicies::none(), now()),
        now(),
    );
    assert!(
        slice
            .edges
            .contains_key("postgresql.cnpg.io/Cluster/shop/db>uses>/Secret/shop/db-env"),
        "{:?}",
        slice.edges.keys()
    );
    // The mount survives too: without it the volume reads "not mounted".
    let conf = &slice.edges["postgresql.cnpg.io/Cluster/shop/db>uses>/ConfigMap/shop/db-conf"];
    assert!(conf.relations.iter().any(|relation| matches!(
        relation,
        crate::resources::Relation::Uses { usages }
            if usages.iter().any(|use_| matches!(use_, crate::resources::Usage::Mount { path, .. } if path == "/etc/db"))
    )));
}

/// With Namespaces refused, the map drew only namespaces holding a pod, a
/// Deployment or a Service: a `StatefulSet` scaled to zero, alone in its
/// namespace, was left off. Fails if any kind read in a namespace does not
/// put it on the map.
#[test]
fn a_namespace_known_only_by_a_stateful_set_is_drawn_when_namespaces_were_refused() {
    let mut stores = Stores::default();
    stores.apply(read(
        Kind::Namespace,
        None,
        Reading::Refused {
            message: SAID.into(),
        },
    ));
    stores.apply(Feed::Applied(Object::StatefulSet(Box::new(
        serde_json::from_value(json!({
            "metadata": { "name": "db", "namespace": "data" },
            "spec": { "replicas": 0, "serviceName": "db",
                      "selector": { "matchLabels": { "app": "db" } },
                      "template": { "metadata": { "labels": { "app": "db" } } } },
        }))
        .expect("a StatefulSet"),
    ))));
    stores.apply(Feed::Applied(deployment("shop", "cart")));
    assert_eq!(
        stores.namespaces(None),
        BTreeSet::from(["data".to_string(), "shop".to_string()])
    );
}

/// A kind refused while the stream lagged behind kept its last reading on
/// the rail: the lag redrew the map and sent no kinds. Fails if a lag does
/// not send the kinds again with the map.
#[tokio::test]
async fn a_stream_that_lagged_sends_the_kinds_again() {
    let map = Arc::new(ClusterMap::default());
    map.feed(every_kind_read());
    let (events, mut rx) = broadcast::channel(4096);
    let (open, cancel) = opening(map.clone(), &events);
    let task = tokio::spawn(stream::run(open));
    while next(&mut rx).await != vec!["ready"] {}

    map.feed([read(
        Kind::Service,
        None,
        Reading::Refused {
            message: SAID.into(),
        },
    )]);
    for at in 0..300 {
        map.feed([Feed::Applied(deployment("shop", &format!("d{at}")))]);
    }
    let mut seen = Vec::new();
    while !seen.contains(&"apps/Deployment/shop/d299".to_string()) {
        seen.extend(next(&mut rx).await);
    }
    assert!(seen.contains(&"kinds".to_string()), "{seen:?}");
    cancel.cancel();
    task.await.expect("ends");
}

/// Discovery failing for a Gateway API kind as the map opened kept its
/// objects off the map for as long as it stayed open: each was parsed with
/// no type and dropped. Fails if a kind discovery could not answer for is
/// not asked about again when its objects arrive.
#[tokio::test]
async fn a_kind_discovery_failed_for_is_asked_again_when_its_objects_arrive() {
    let (tx, rx) = tokio::sync::mpsc::channel(8);
    let map = Arc::new(ClusterMap::default());
    let resolve: Resolve = Arc::new(|kind| {
        Box::pin(async move {
            (kind == Kind::Gateway).then(|| {
                kube::discovery::ApiResource::from_gvk_with_plural(
                    &kube::core::GroupVersionKind::gvk(
                        "gateway.networking.k8s.io",
                        "v1",
                        "Gateway",
                    ),
                    "gateways",
                )
            })
        })
    });
    let pumping = tokio::spawn(pump(
        rx,
        map.clone(),
        std::collections::BTreeMap::new(),
        BTreeSet::from([Kind::Gateway]),
        Some(resolve),
    ));
    tx.send(crate::feeds::Update::State {
        slot: slot(Kind::Gateway, None),
        state: Reading::Synced,
    })
    .await
    .expect("sent");
    tx.send(crate::feeds::Update::Applied {
        slot: slot(Kind::Gateway, None),
        object: dynamic(json!({
            "metadata": { "name": "edge", "namespace": "infra" },
            "spec": { "gatewayClassName": "envoy", "listeners": [] },
        })),
    })
    .await
    .expect("sent");
    drop(tx);
    pumping.await.expect("the pump ends");
    let held = map.stores().held("infra", OtherPolicies::none(), now());
    assert_eq!(held.gateways_here.map(|list| list.len()), Some(1));
}

/// The map drew a route's `ListenerSet` as missing, in red, when the set
/// was there and the Gateway it names was the one gone. Fails if the map
/// does not hand its sets to the route's parents, or calls the Gateway
/// missing while the sets are unread.
#[test]
fn the_map_names_the_gateway_a_route_s_listener_set_leads_to() {
    let mut stores = Stores::default();
    for kind in [Kind::Gateway, Kind::HttpRoute] {
        stores.apply(read(kind, None, Reading::Synced));
    }
    stores.apply(Feed::Applied(Object::HttpRoute(Box::new(RouteInfo::read(
        &gateway_api(
            "HTTPRoute",
            "shop",
            "api",
            &json!({ "parentRefs": [{ "kind": "ListenerSet", "name": "team" }] }),
        ),
    )))));
    stores.apply(Feed::Applied(Object::ListenerSet(Box::new(
        ListenerSetInfo::read(&gateway_api(
            "ListenerSet",
            "shop",
            "team",
            &json!({ "parentRef": { "name": "public", "namespace": "infra" }, "listeners": [] }),
        )),
    ))));
    let public = |stores: &Stores| {
        crate::commands::connections::map::slice_of(
            stores.held("shop", OtherPolicies::none(), now()),
            now(),
        )
        .nodes
        .get(PUBLIC)
        .map(|node| node.object.existence)
    };
    assert_eq!(public(&stores), None);
    let team = |stores: &Stores| {
        crate::commands::connections::map::slice_of(
            stores.held("shop", OtherPolicies::none(), now()),
            now(),
        )
        .nodes
        .values()
        .find(|node| node.object.kind == "ListenerSet" && node.object.name == "team")
        .map(|node| node.object.existence)
    };
    assert_eq!(team(&stores), Some(Existence::NotChecked));
    // A cluster that serves no ListenerSet has none: the set is the one
    // missing.
    stores.apply(read(Kind::ListenerSet, None, Reading::Unserved));
    assert_eq!(team(&stores), Some(Existence::Missing));
    stores.apply(read(Kind::ListenerSet, None, Reading::Synced));
    assert_eq!(public(&stores), Some(Existence::Missing));
}
