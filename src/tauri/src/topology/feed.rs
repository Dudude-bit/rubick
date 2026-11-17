//! The map's lists from the shared watch layer: each update parsed, as it
//! arrives, into the stripped form the map keeps, and nothing else kept.

use std::collections::BTreeMap;
use std::sync::Arc;

use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, ReplicaSet, StatefulSet};
use k8s_openapi::api::autoscaling::v2::HorizontalPodAutoscaler;
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{Event, PersistentVolumeClaim, Pod, Service};
use k8s_openapi::api::discovery::v1::EndpointSlice;
use k8s_openapi::api::networking::v1::{Ingress, NetworkPolicy};
use k8s_openapi::api::policy::v1::PodDisruptionBudget;
use kube::api::DynamicObject;
use kube::discovery::ApiResource;
use serde::de::DeserializeOwned;
use tokio::sync::mpsc;

use super::{named, ClusterMap, Feed, Kind, Object, HELM_RELEASE};
use crate::feeds::{Ask, Binding, Update};
use crate::ownership::KindKey;
use crate::resources::{GatewayInfo, ListenerSetInfo, RouteInfo};

const GATEWAY_API: &str = "gateway.networking.k8s.io";

impl Kind {
    /// The kind as the watch layer is asked for it.
    #[must_use]
    pub fn key(self) -> KindKey {
        let (group, plural) = match self {
            Kind::Namespace => ("", "namespaces"),
            Kind::Pod => ("", "pods"),
            Kind::Deployment => ("apps", "deployments"),
            Kind::StatefulSet => ("apps", "statefulsets"),
            Kind::DaemonSet => ("apps", "daemonsets"),
            Kind::ReplicaSet => ("apps", "replicasets"),
            Kind::Job => ("batch", "jobs"),
            Kind::CronJob => ("batch", "cronjobs"),
            Kind::Service => ("", "services"),
            Kind::EndpointSlice => ("discovery.k8s.io", "endpointslices"),
            Kind::Ingress => ("networking.k8s.io", "ingresses"),
            Kind::Claim => ("", "persistentvolumeclaims"),
            Kind::Autoscaler => ("autoscaling", "horizontalpodautoscalers"),
            Kind::Budget => ("policy", "poddisruptionbudgets"),
            Kind::Policy => ("networking.k8s.io", "networkpolicies"),
            Kind::Event => ("", "events"),
            Kind::ConfigMap => ("", "configmaps"),
            Kind::Secret => ("", "secrets"),
            Kind::ServiceAccount => ("", "serviceaccounts"),
            Kind::HttpRoute => (GATEWAY_API, "httproutes"),
            Kind::GrpcRoute => (GATEWAY_API, "grpcroutes"),
            Kind::TlsRoute => (GATEWAY_API, "tlsroutes"),
            Kind::TcpRoute => (GATEWAY_API, "tcproutes"),
            Kind::UdpRoute => (GATEWAY_API, "udproutes"),
            Kind::Gateway => (GATEWAY_API, "gateways"),
            Kind::ListenerSet => (GATEWAY_API, "listenersets"),
        };
        KindKey {
            group: group.to_string(),
            plural: plural.to_string(),
        }
    }

    fn of(key: &KindKey) -> Option<Kind> {
        Kind::ALL.iter().copied().find(|kind| kind.key() == *key)
    }
}

/// Every kind the map reads, followed for as long as the page touches it.
#[must_use]
pub fn ask(scope: Option<Vec<String>>) -> Ask {
    Ask {
        kinds: Kind::ALL.iter().map(|kind| kind.key()).collect(),
        scope,
        binding: Binding::Page,
    }
}

/// The resources the Gateway API kinds are served as, for the types their
/// objects are read with. A kind the cluster does not serve is absent here,
/// and the layer says `Unserved` of it.
pub async fn types_of(here: &crate::state::Here<'_>) -> BTreeMap<Kind, ApiResource> {
    let mut types = BTreeMap::new();
    for &kind in Kind::ALL.iter().filter(|kind| kind.optional()) {
        let key = kind.key();
        if let Ok(Some(served)) = here.served(&key.group, &key.plural).await {
            types.insert(kind, served.resource);
        }
    }
    types
}

/// A built-in kind out of a dynamic object.
fn typed<K: DeserializeOwned>(object: &DynamicObject) -> Option<K> {
    serde_json::from_value(serde_json::to_value(object).ok()?).ok()
}

fn with_types(object: &DynamicObject, resource: Option<&ApiResource>) -> Option<DynamicObject> {
    Some(crate::commands::gateway::with_types(
        object.clone(),
        resource?,
    ))
}

/// What the map keeps of one object; `None` for what it keeps nothing of: an
/// event that is not a Warning, a Helm release's own Secret.
fn parse(
    kind: Kind,
    object: &DynamicObject,
    types: &BTreeMap<Kind, ApiResource>,
) -> Option<Object> {
    let resource = types.get(&kind);
    let built = |object: Object| Some(object.stripped());
    match kind {
        Kind::Namespace => Some(Object::Namespace(Box::new(named(&object.metadata)))),
        Kind::ConfigMap => Some(Object::ConfigMap(Box::new(named(&object.metadata)))),
        Kind::ServiceAccount => Some(Object::ServiceAccount(Box::new(named(&object.metadata)))),
        Kind::Secret => (object.data.get("type").and_then(serde_json::Value::as_str)
            != Some(HELM_RELEASE))
        .then(|| Object::Secret(Box::new(named(&object.metadata)))),
        Kind::Pod => typed::<Pod>(object).map(Object::pod),
        Kind::Event => typed::<Event>(object).and_then(Object::warning),
        Kind::Deployment => built(Object::Deployment(Box::new(typed::<Deployment>(object)?))),
        Kind::StatefulSet => built(Object::StatefulSet(Box::new(typed::<StatefulSet>(object)?))),
        Kind::DaemonSet => built(Object::DaemonSet(Box::new(typed::<DaemonSet>(object)?))),
        Kind::ReplicaSet => built(Object::ReplicaSet(Box::new(typed::<ReplicaSet>(object)?))),
        Kind::Job => built(Object::Job(Box::new(typed::<Job>(object)?))),
        Kind::CronJob => built(Object::CronJob(Box::new(typed::<CronJob>(object)?))),
        Kind::Service => built(Object::Service(Box::new(typed::<Service>(object)?))),
        Kind::EndpointSlice => built(Object::EndpointSlice(Box::new(typed::<EndpointSlice>(
            object,
        )?))),
        Kind::Ingress => built(Object::Ingress(Box::new(typed::<Ingress>(object)?))),
        Kind::Claim => built(Object::Claim(Box::new(typed::<PersistentVolumeClaim>(
            object,
        )?))),
        Kind::Autoscaler => built(Object::Autoscaler(Box::new(typed::<
            HorizontalPodAutoscaler,
        >(object)?))),
        Kind::Budget => built(Object::Budget(Box::new(typed::<PodDisruptionBudget>(
            object,
        )?))),
        Kind::Policy => built(Object::Policy(Box::new(typed::<NetworkPolicy>(object)?))),
        Kind::HttpRoute => Some(Object::HttpRoute(Box::new(RouteInfo::read(&with_types(
            object, resource,
        )?)))),
        Kind::GrpcRoute => Some(Object::GrpcRoute(Box::new(RouteInfo::read(&with_types(
            object, resource,
        )?)))),
        Kind::TlsRoute => Some(Object::TlsRoute(Box::new(RouteInfo::read(&with_types(
            object, resource,
        )?)))),
        Kind::TcpRoute => Some(Object::TcpRoute(Box::new(RouteInfo::read(&with_types(
            object, resource,
        )?)))),
        Kind::UdpRoute => Some(Object::UdpRoute(Box::new(RouteInfo::read(&with_types(
            object, resource,
        )?)))),
        Kind::Gateway => Some(Object::Gateway(Box::new(GatewayInfo::read(&with_types(
            object, resource,
        )?)))),
        Kind::ListenerSet => Some(Object::ListenerSet(Box::new(ListenerSetInfo::read(
            &with_types(object, resource)?,
        )))),
    }
}

/// One update from the layer as the map takes it.
pub(super) fn feeds_of(update: Update, types: &BTreeMap<Kind, ApiResource>) -> Vec<Feed> {
    match update {
        Update::Whole { slot, objects, .. } => {
            let Some(kind) = Kind::of(&slot.kind) else {
                return Vec::new();
            };
            vec![Feed::Relisted {
                kind,
                namespace: slot.namespace,
                objects: objects
                    .iter()
                    .filter_map(|object| parse(kind, object, types))
                    .collect(),
            }]
        }
        Update::Applied { slot, object } => Kind::of(&slot.kind)
            .and_then(|kind| parse(kind, &object, types))
            .map(Feed::Applied)
            .into_iter()
            .collect(),
        Update::Deleted { slot, object } => Kind::of(&slot.kind)
            .and_then(|kind| parse(kind, &object, types))
            .map(Feed::Deleted)
            .into_iter()
            .collect(),
        Update::State { slot, state } => Kind::of(&slot.kind)
            .map(|kind| Feed::Read {
                kind,
                namespace: slot.namespace,
                reading: state,
            })
            .into_iter()
            .collect(),
        Update::HandedOver => Vec::new(),
    }
}

/// Feeds `map` from the layer until it closes the channel, then ends the
/// map: the cluster was let go, and every stream on it says so. What arrived
/// together is parsed together, off the reactor.
pub async fn pump(
    mut updates: mpsc::Receiver<Update>,
    map: Arc<ClusterMap>,
    types: BTreeMap<Kind, ApiResource>,
) {
    let types = Arc::new(types);
    while let Some(first) = updates.recv().await {
        let mut batch = vec![first];
        while let Ok(more) = updates.try_recv() {
            batch.push(more);
        }
        let types = types.clone();
        let Ok(feeds) = tokio::task::spawn_blocking(move || {
            batch
                .into_iter()
                .flat_map(|update| feeds_of(update, &types))
                .collect::<Vec<_>>()
        })
        .await
        else {
            break;
        };
        map.feed(feeds);
    }
    map.end();
}
