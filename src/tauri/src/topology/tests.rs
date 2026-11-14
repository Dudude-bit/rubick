use super::*;
use crate::resources::topology::{MapKindReading, TopologyEnd, TopologyPiece};
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

/// A cluster that serves no Gateway API is not a cluster whose routes were
/// refused: nothing is named unread for it.
#[test]
fn a_gateway_kind_nobody_watches_is_not_served_rather_than_unread() {
    let stores = Stores::default();
    let held = stores.held("shop", OtherPolicies::none(), now());
    assert!(held.gateway_unread.is_empty());
    assert!(held.gateways.is_none());
    let routes = stores
        .kinds()
        .into_iter()
        .find(|k| k.kind == "HTTPRoute")
        .expect("listed");
    assert_eq!(routes.reading, MapKindReading::NotServed);
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
    map.feed([
        read(Kind::Deployment, None, Reading::Synced),
        Feed::Applied(deployment("shop", "cart")),
    ]);
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
    assert!(held.gateway_unread.is_empty());
    assert!(held.slices.is_err());
}

/// The layer closing the channel is the cluster let go: the map ends, and
/// every stream on it ends with it rather than drawing a cluster nobody
/// reads any more.
#[tokio::test]
async fn a_map_ends_when_the_layer_closes_its_channel() {
    let (tx, rx) = tokio::sync::mpsc::channel(8);
    let map = Arc::new(ClusterMap::default());
    let pumping = tokio::spawn(pump(rx, map.clone(), std::collections::BTreeMap::new()));
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
