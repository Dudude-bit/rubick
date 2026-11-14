use super::*;
use crate::resources::topology::{MapKindReading, TopologyEnd, TopologyPiece};
use serde_json::json;

const SAID: &str =
    "deployments.apps is forbidden: User \"narrow\" cannot list resource \"deployments\"";

fn deployment(ns: &str, name: &str) -> Object {
    Object::Deployment(
        serde_json::from_value(json!({
            "metadata": { "name": name, "namespace": ns, "uid": format!("{ns}-{name}") },
            "spec": { "selector": { "matchLabels": { "app": name } },
                      "template": { "metadata": { "labels": { "app": name } } } },
        }))
        .expect("a Deployment"),
    )
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
        Reading::Refused { said: SAID.into() },
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
    stores.apply(read(Kind::Pod, None, Reading::Syncing { since: now() }));
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
    assert!(matches!(pods.reading, MapKindReading::Syncing { .. }));
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

    let cache = TopologyCache::default();
    cache.clusters.insert("kind".into(), map.clone());
    let (open, _) = opening(map, &events);
    let task = tokio::spawn(stream::run(open));
    while next(&mut rx).await != vec!["ready"] {}
    cache.forget("kind");
    assert_eq!(task.await.expect("ends"), TopologyEnd::Replaced);
}
