//! Gateway API resource types.
//!
//! Everything here is read through [`kube::api::DynamicObject`] rather than
//! generated bindings, on purpose: the kinds span three served versions in
//! the wild (`v1`, `v1beta1`, and `v1alpha2` on bundles older than Gateway
//! API 1.5/1.6), and the shapes are identical for every field this app
//! reads — graduation was a version bump. One tolerant reader that ignores
//! unknown fields covers all of them; a version-specific reader appears
//! only when upstream actually breaks a shape.
//!
//! Five route kinds share one `RouteInfo`. HTTPRoute has path matches,
//! GRPCRoute has service/method matches, TLSRoute has SNI hostnames and
//! TCP/UDPRoute have neither — but the chain they anchor is the same
//! `parentRefs` up and `backendRefs` down, and five near-identical structs
//! would be five places for the next field to be forgotten in.

use std::collections::BTreeMap;

use kube::api::DynamicObject;
use serde::{Deserialize, Serialize};

use super::{ConditionInfo, OptionTimeExt};

/// A route's `parentRefs[]` entry, with the API's defaults spelled out.
///
/// `kind` defaults to `Gateway` and `group` to the Gateway API group per
/// spec — and the default matters, because a `kind: Service` parentRef is a
/// GAMMA/mesh route that must never be misread as "names a Gateway that
/// does not exist".
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParentRefInfo {
    pub group: String,
    pub kind: String,
    pub name: String,
    /// `None` means "same namespace as the route".
    pub namespace: Option<String>,
    pub section_name: Option<String>,
    pub port: Option<i32>,
}

/// A rule's `backendRefs[]` entry. `kind` defaults to `Service`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendRefInfo {
    pub group: String,
    pub kind: String,
    pub name: String,
    /// `None` means "same namespace as the route". A `Some` pointing
    /// elsewhere needs a ReferenceGrant, and the controller says whether it
    /// got one in `ResolvedRefs`.
    pub namespace: Option<String>,
    pub port: Option<i32>,
    /// `Some(0)` is "receives no traffic", which is configuration and not
    /// an outage.
    pub weight: Option<i32>,
}

/// An `ExtensionRef` filter, named and nothing more.
///
/// What a vendor CRD means is that vendor's business; naming the group and
/// kind honestly is ours.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionRefInfo {
    pub group: String,
    pub kind: String,
    pub name: String,
}

/// One match within a rule, across the kinds that have matches at all.
///
/// HTTP fills `path`/`path_type`/`method`; GRPC fills `grpc_service` /
/// `grpc_method`; both may carry header matches. TLS/TCP/UDP rules match
/// nothing and carry an empty list.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteMatchInfo {
    pub path: Option<String>,
    pub path_type: Option<String>,
    pub method: Option<String>,
    pub grpc_service: Option<String>,
    pub grpc_method: Option<String>,
    /// `name=value` per header match, order preserved.
    pub headers: Vec<String>,
}

/// One `rules[]` entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteRuleInfo {
    pub matches: Vec<RouteMatchInfo>,
    pub backend_refs: Vec<BackendRefInfo>,
    /// A `RequestRedirect` filter means "no backends" is the configuration
    /// working, not a path that stops.
    pub has_redirect: bool,
    pub extension_refs: Vec<ExtensionRefInfo>,
}

/// One `status.parents[]` entry: what one controller said about one parent.
///
/// The pair is the key. A route attached to two Gateways under two
/// controllers has four possible verdicts, and collapsing them into one
/// would be this app inventing an answer the cluster never gave.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteParentStatusInfo {
    pub parent: ParentRefInfo,
    pub controller_name: String,
    pub conditions: Vec<ConditionInfo>,
}

/// Any of the five route kinds, read as routing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteInfo {
    /// `HTTPRoute` / `GRPCRoute` / `TLSRoute` / `TCPRoute` / `UDPRoute`.
    pub kind: String,
    /// The apiVersion this object was actually read at — the page says so
    /// when it is not the tested one.
    pub api_version: String,
    pub name: String,
    pub namespace: String,
    pub hostnames: Vec<String>,
    pub parent_refs: Vec<ParentRefInfo>,
    pub rules: Vec<RouteRuleInfo>,
    /// `status.parents`, verbatim per (parent, controller). Empty means no
    /// controller ever wrote status — the structurally-silent case the
    /// surfaces must not paint green.
    pub parents: Vec<RouteParentStatusInfo>,
    pub labels: BTreeMap<String, String>,
    pub annotations: BTreeMap<String, String>,
    pub created_at: Option<String>,
}

/// The group every kind here belongs to, and the `parentRefs[].group`
/// default the spec declares.
pub const GATEWAY_API_GROUP: &str = "gateway.networking.k8s.io";

/// A listener's `tls.certificateRefs[]` entry. `kind` defaults to `Secret`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CertificateRefInfo {
    pub group: String,
    pub kind: String,
    pub name: String,
    /// `None` means the Gateway's own namespace. Elsewhere needs a
    /// ReferenceGrant, and the listener's `ResolvedRefs` says whether it
    /// got one.
    pub namespace: Option<String>,
}

/// One listener a Gateway serves — its own, or one contributed by a
/// ListenerSet, told apart by [`ListenerInfo::from_listener_set`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenerInfo {
    pub name: String,
    pub port: i32,
    pub protocol: String,
    /// `None` is the catch-all: this listener answers for every host.
    pub hostname: Option<String>,
    /// `Terminate` / `Passthrough`, where TLS is configured at all.
    pub tls_mode: Option<String>,
    pub certificate_refs: Vec<CertificateRefInfo>,
    /// `allowedRoutes.namespaces.from` — `Same` (the default), `All`, or
    /// `Selector`. The selector itself is not re-implemented: whether a
    /// route got in is the route's `Accepted` condition's answer.
    pub allowed_namespaces: Option<String>,
    /// `status.listeners[].attachedRoutes` for this listener, where a
    /// controller wrote it.
    pub attached_routes: Option<i64>,
    pub conditions: Vec<ConditionInfo>,
    /// The ListenerSet this listener came from — `None` for the Gateway's
    /// own.
    pub from_listener_set: Option<String>,
}

/// A Gateway, read as routing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayInfo {
    pub name: String,
    pub namespace: String,
    pub api_version: String,
    /// `spec.gatewayClassName` — the claim that decides whose Gateway this
    /// is, resolved the same way IngressClass claiming is.
    pub class_name: String,
    pub listeners: Vec<ListenerInfo>,
    /// `status.addresses`, values only.
    pub addresses: Vec<String>,
    pub conditions: Vec<ConditionInfo>,
    pub labels: BTreeMap<String, String>,
    pub annotations: BTreeMap<String, String>,
    pub created_at: Option<String>,
}

/// A ListenerSet: listeners defined apart from the Gateway they attach to.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenerSetInfo {
    pub name: String,
    pub namespace: String,
    /// The Gateway `spec.parentRef` names, namespace resolved: an absent
    /// parentRef namespace means the set's own.
    pub gateway_name: String,
    pub gateway_namespace: String,
    pub listeners: Vec<ListenerInfo>,
    pub conditions: Vec<ConditionInfo>,
    pub created_at: Option<String>,
}

/// A GatewayClass and the honest answer to "did anything claim it".
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayClassInfo {
    pub name: String,
    /// `spec.controllerName` — the implementation, in its own words.
    pub controller_name: String,
    pub description: Option<String>,
    /// `Accepted` read as a verdict: `Some(true)` / `Some(false)` where a
    /// controller answered, `None` where status was never written — or
    /// still says `Unknown`, which is the CRD's own default and means the
    /// same thing: nothing has claimed this class.
    pub accepted: Option<bool>,
    pub conditions: Vec<ConditionInfo>,
    pub labels: BTreeMap<String, String>,
    pub annotations: BTreeMap<String, String>,
    pub created_at: Option<String>,
}

/// One Gateway API kind the cluster serves, and the version this app will
/// read it at.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServedGatewayKind {
    pub kind: String,
    pub plural: String,
    /// Every served version, as the CRD lists them.
    pub versions: Vec<String>,
    /// The one this app reads: `v1` where served, else `v1beta1`, else
    /// `v1alpha2`, else whatever the CRD serves first — the baseline reader
    /// takes it either way, and the bundle fields below say how tested that
    /// is.
    pub read_version: String,
}

/// What one CRD scan says about Gateway API in this cluster.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayApiDetection {
    pub installed: bool,
    /// The `gateway.networking.k8s.io/bundle-version` annotation, where
    /// every Gateway API CRD agrees on one. `None` with `mixed_bundle`
    /// false means the annotation is absent — an old or repackaged
    /// install, "unknown", not an error.
    pub bundle_version: Option<String>,
    /// The `.../channel` annotation — `standard` or `experimental` — under
    /// the same agreement rule.
    pub channel: Option<String>,
    /// A partial upgrade left CRDs from different bundles behind.
    pub mixed_bundle: bool,
    pub kinds: Vec<ServedGatewayKind>,
}

/// One listener with its status joined on, both halves read as written.
fn listener_info(
    listener: schema::Listener,
    statuses: &[schema::ListenerStatus],
    from_listener_set: Option<&str>,
) -> ListenerInfo {
    let status = statuses.iter().find(|s| s.name == listener.name);
    ListenerInfo {
        tls_mode: listener.tls.as_ref().and_then(|t| t.mode.clone()),
        certificate_refs: listener
            .tls
            .map(|t| t.certificate_refs)
            .unwrap_or_default()
            .into_iter()
            .map(|r| CertificateRefInfo {
                group: r.group.unwrap_or_default(),
                kind: r.kind.unwrap_or_else(|| "Secret".to_string()),
                name: r.name,
                namespace: r.namespace,
            })
            .collect(),
        allowed_namespaces: listener
            .allowed_routes
            .and_then(|a| a.namespaces)
            .and_then(|n| n.from),
        attached_routes: status.and_then(|s| s.attached_routes),
        conditions: status.map(|s| s.conditions.clone()).unwrap_or_default(),
        from_listener_set: from_listener_set.map(String::from),
        name: listener.name,
        port: listener.port,
        protocol: listener.protocol,
        hostname: listener.hostname,
    }
}

impl GatewayInfo {
    /// See [`RouteInfo::read`] for the tolerance contract.
    pub fn read(obj: &DynamicObject) -> Self {
        use kube::ResourceExt;

        let types = obj.types.clone().unwrap_or_default();
        let spec: schema::GatewaySpec = section(obj, "spec");
        let status: schema::GatewayStatus = section(obj, "status");

        Self {
            name: obj.name_any(),
            namespace: obj.namespace().unwrap_or_default(),
            api_version: types.api_version,
            class_name: spec.gateway_class_name,
            listeners: spec
                .listeners
                .into_iter()
                .map(|l| listener_info(l, &status.listeners, None))
                .collect(),
            addresses: status.addresses.into_iter().map(|a| a.value).collect(),
            conditions: status.conditions,
            labels: obj.metadata.labels.clone().unwrap_or_default(),
            annotations: obj.metadata.annotations.clone().unwrap_or_default(),
            created_at: obj.metadata.creation_timestamp.as_ref().to_rfc3339_opt(),
        }
    }

    /// Fold ListenerSet listeners into this Gateway's, marked by origin.
    ///
    /// Only sets whose resolved parentRef names this Gateway are taken;
    /// the rest are some other Gateway's business.
    pub fn merge_listener_sets(&mut self, sets: &[ListenerSetInfo]) {
        for set in sets {
            if set.gateway_name == self.name && set.gateway_namespace == self.namespace {
                self.listeners.extend(set.listeners.iter().cloned());
            }
        }
    }
}

impl ListenerSetInfo {
    pub fn read(obj: &DynamicObject) -> Self {
        use kube::ResourceExt;

        let spec: schema::ListenerSetSpec = section(obj, "spec");
        let status: schema::ListenerSetStatus = section(obj, "status");
        let name = obj.name_any();
        let namespace = obj.namespace().unwrap_or_default();

        Self {
            gateway_name: spec.parent_ref.name,
            // An absent parentRef namespace means the set's own.
            gateway_namespace: spec
                .parent_ref
                .namespace
                .unwrap_or_else(|| namespace.clone()),
            listeners: spec
                .listeners
                .into_iter()
                .map(|l| listener_info(l, &status.listeners, Some(&name)))
                .collect(),
            conditions: status.conditions,
            created_at: obj.metadata.creation_timestamp.as_ref().to_rfc3339_opt(),
            name,
            namespace,
        }
    }
}

impl GatewayClassInfo {
    pub fn read(obj: &DynamicObject) -> Self {
        use kube::ResourceExt;

        let spec: schema::GatewayClassSpec = section(obj, "spec");
        let status: schema::GatewayClassStatus = section(obj, "status");

        // A verdict only where one was given: "Unknown" is the CRD's own
        // default — Waiting — and means the same as no status at all.
        let accepted = status
            .conditions
            .iter()
            .find(|c| c.type_ == "Accepted")
            .and_then(|c| match c.status.as_str() {
                "True" => Some(true),
                "False" => Some(false),
                _ => None,
            });

        Self {
            name: obj.name_any(),
            controller_name: spec.controller_name,
            description: spec.description,
            accepted,
            conditions: status.conditions,
            labels: obj.metadata.labels.clone().unwrap_or_default(),
            annotations: obj.metadata.annotations.clone().unwrap_or_default(),
            created_at: obj.metadata.creation_timestamp.as_ref().to_rfc3339_opt(),
        }
    }
}

/// The versions this app has fixtures for, best first.
const READ_PREFERENCE: [&str; 3] = ["v1", "v1beta1", "v1alpha2"];

const BUNDLE_VERSION_ANNOTATION: &str = "gateway.networking.k8s.io/bundle-version";
const CHANNEL_ANNOTATION: &str = "gateway.networking.k8s.io/channel";

/// The one value every Gateway API CRD agrees on, or nothing.
///
/// Absent annotations are skipped rather than counted as disagreement — a
/// hand-installed CRD without the stamp beside nine stamped ones is still
/// one bundle's story. Two different stamps are not.
fn agreed<'a>(values: impl Iterator<Item = Option<&'a str>>) -> (Option<String>, bool) {
    let mut distinct: Vec<&str> = values.flatten().collect();
    distinct.sort_unstable();
    distinct.dedup();
    match distinct.as_slice() {
        [] => (None, false),
        [one] => (Some((*one).to_string()), false),
        _ => (None, true),
    }
}

impl GatewayApiDetection {
    /// Read the answer off a CRD list the app already fetches — no extra
    /// request, one scan per cluster.
    pub fn from_crds(
        crds: &[k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition],
    ) -> Self {
        use kube::ResourceExt;

        let ours: Vec<_> = crds
            .iter()
            .filter(|crd| crd.spec.group == GATEWAY_API_GROUP)
            .collect();

        let kinds: Vec<ServedGatewayKind> = ours
            .iter()
            .filter_map(|crd| {
                let versions: Vec<String> = crd
                    .spec
                    .versions
                    .iter()
                    .filter(|v| v.served)
                    .map(|v| v.name.clone())
                    .collect();
                let read_version = READ_PREFERENCE
                    .iter()
                    .find(|p| versions.iter().any(|v| v == *p))
                    .map(|p| (*p).to_string())
                    .or_else(|| versions.first().cloned())?;
                Some(ServedGatewayKind {
                    kind: crd.spec.names.kind.clone(),
                    plural: crd.spec.names.plural.clone(),
                    versions,
                    read_version,
                })
            })
            .collect();

        let (bundle_version, mixed_bundle) = agreed(ours.iter().map(|crd| {
            crd.annotations()
                .get(BUNDLE_VERSION_ANNOTATION)
                .map(String::as_str)
        }));
        let (channel, _) = agreed(ours.iter().map(|crd| {
            crd.annotations()
                .get(CHANNEL_ANNOTATION)
                .map(String::as_str)
        }));

        Self {
            installed: !kinds.is_empty(),
            bundle_version,
            channel,
            mixed_bundle,
            kinds,
        }
    }
}

/// Wire shapes, private and tolerant.
///
/// Every field defaults and unknown fields are ignored, which is the whole
/// versioning strategy: the fields this app reads are identical across
/// `v1`, `v1beta1` and `v1alpha2`, and an experimental bundle's extra
/// fields simply fall through. A field with a `Some`/absent distinction the
/// spec gives meaning to — `parentRefs[].group: ""` is the core group, not
/// the default — stays an `Option` so that distinction survives.
mod schema {
    use serde::Deserialize;

    use crate::resources::ConditionInfo;

    #[derive(Debug, Default, Deserialize)]
    #[serde(rename_all = "camelCase", default)]
    pub struct RouteSpec {
        pub hostnames: Vec<String>,
        pub parent_refs: Vec<ParentRef>,
        pub rules: Vec<RouteRule>,
    }

    #[derive(Debug, Default, Deserialize)]
    #[serde(rename_all = "camelCase", default)]
    pub struct ParentRef {
        pub group: Option<String>,
        pub kind: Option<String>,
        pub name: String,
        pub namespace: Option<String>,
        pub section_name: Option<String>,
        pub port: Option<i32>,
    }

    #[derive(Debug, Default, Deserialize)]
    #[serde(rename_all = "camelCase", default)]
    pub struct RouteRule {
        pub matches: Vec<RouteMatch>,
        pub filters: Vec<RouteFilter>,
        pub backend_refs: Vec<BackendRef>,
    }

    #[derive(Debug, Default, Deserialize)]
    #[serde(rename_all = "camelCase", default)]
    pub struct RouteMatch {
        pub path: Option<PathMatch>,
        /// A string on HTTPRoute (`GET`), an object on GRPCRoute
        /// (`{service, method}`) — same field name, two shapes, so it is
        /// read as a value and told apart at conversion.
        pub method: Option<serde_json::Value>,
        pub headers: Vec<HeaderMatch>,
    }

    #[derive(Debug, Default, Deserialize)]
    #[serde(rename_all = "camelCase", default)]
    pub struct PathMatch {
        pub type_: Option<String>,
        pub value: Option<String>,
    }

    #[derive(Debug, Default, Deserialize)]
    #[serde(rename_all = "camelCase", default)]
    pub struct HeaderMatch {
        pub name: String,
        pub value: Option<String>,
    }

    #[derive(Debug, Default, Deserialize)]
    #[serde(rename_all = "camelCase", default)]
    pub struct RouteFilter {
        pub type_: String,
        pub extension_ref: Option<LocalRef>,
    }

    #[derive(Debug, Default, Deserialize)]
    #[serde(rename_all = "camelCase", default)]
    pub struct LocalRef {
        pub group: Option<String>,
        pub kind: Option<String>,
        pub name: String,
    }

    #[derive(Debug, Default, Deserialize)]
    #[serde(rename_all = "camelCase", default)]
    pub struct BackendRef {
        pub group: Option<String>,
        pub kind: Option<String>,
        pub name: String,
        pub namespace: Option<String>,
        pub port: Option<i32>,
        pub weight: Option<i32>,
    }

    #[derive(Debug, Default, Deserialize)]
    #[serde(rename_all = "camelCase", default)]
    pub struct RouteStatus {
        pub parents: Vec<RouteParentStatus>,
    }

    #[derive(Debug, Default, Deserialize)]
    #[serde(rename_all = "camelCase", default)]
    pub struct GatewaySpec {
        pub gateway_class_name: String,
        pub listeners: Vec<Listener>,
    }

    #[derive(Debug, Default, Deserialize)]
    #[serde(rename_all = "camelCase", default)]
    pub struct Listener {
        pub name: String,
        pub port: i32,
        pub protocol: String,
        pub hostname: Option<String>,
        pub tls: Option<ListenerTls>,
        pub allowed_routes: Option<AllowedRoutes>,
    }

    #[derive(Debug, Default, Deserialize)]
    #[serde(rename_all = "camelCase", default)]
    pub struct ListenerTls {
        pub mode: Option<String>,
        pub certificate_refs: Vec<CertRef>,
    }

    #[derive(Debug, Default, Deserialize)]
    #[serde(rename_all = "camelCase", default)]
    pub struct CertRef {
        pub group: Option<String>,
        pub kind: Option<String>,
        pub name: String,
        pub namespace: Option<String>,
    }

    #[derive(Debug, Default, Deserialize)]
    #[serde(rename_all = "camelCase", default)]
    pub struct AllowedRoutes {
        pub namespaces: Option<FromNamespaces>,
    }

    #[derive(Debug, Default, Deserialize)]
    #[serde(rename_all = "camelCase", default)]
    pub struct FromNamespaces {
        pub from: Option<String>,
    }

    #[derive(Debug, Default, Deserialize)]
    #[serde(rename_all = "camelCase", default)]
    pub struct GatewayStatus {
        pub addresses: Vec<StatusAddress>,
        pub conditions: Vec<ConditionInfo>,
        pub listeners: Vec<ListenerStatus>,
    }

    #[derive(Debug, Default, Deserialize)]
    #[serde(rename_all = "camelCase", default)]
    pub struct StatusAddress {
        pub value: String,
    }

    #[derive(Debug, Default, Deserialize)]
    #[serde(rename_all = "camelCase", default)]
    pub struct ListenerStatus {
        pub name: String,
        pub attached_routes: Option<i64>,
        pub conditions: Vec<ConditionInfo>,
    }

    #[derive(Debug, Default, Deserialize)]
    #[serde(rename_all = "camelCase", default)]
    pub struct ListenerSetSpec {
        pub parent_ref: ParentRef,
        pub listeners: Vec<Listener>,
    }

    #[derive(Debug, Default, Deserialize)]
    #[serde(rename_all = "camelCase", default)]
    pub struct ListenerSetStatus {
        pub conditions: Vec<ConditionInfo>,
        pub listeners: Vec<ListenerStatus>,
    }

    #[derive(Debug, Default, Deserialize)]
    #[serde(rename_all = "camelCase", default)]
    pub struct GatewayClassSpec {
        pub controller_name: String,
        pub description: Option<String>,
    }

    #[derive(Debug, Default, Deserialize)]
    #[serde(rename_all = "camelCase", default)]
    pub struct GatewayClassStatus {
        pub conditions: Vec<ConditionInfo>,
    }

    #[derive(Debug, Default, Deserialize)]
    #[serde(rename_all = "camelCase", default)]
    pub struct RouteParentStatus {
        pub parent_ref: ParentRef,
        pub controller_name: String,
        pub conditions: Vec<ConditionInfo>,
    }
}

/// One named section of a dynamic object, or the default where it is
/// absent or unreadable. Unreadable is deliberate: a malformed status is
/// the cluster's problem to report, not this app's reason to error a page.
fn section<T: serde::de::DeserializeOwned + Default>(obj: &DynamicObject, key: &str) -> T {
    obj.data
        .get(key)
        .and_then(|value| serde_json::from_value(value.clone()).ok())
        .unwrap_or_default()
}

fn parent_ref_info(parent: schema::ParentRef) -> ParentRefInfo {
    ParentRefInfo {
        group: parent
            .group
            .unwrap_or_else(|| GATEWAY_API_GROUP.to_string()),
        kind: parent.kind.unwrap_or_else(|| "Gateway".to_string()),
        name: parent.name,
        namespace: parent.namespace,
        section_name: parent.section_name,
        port: parent.port,
    }
}

fn match_info(m: schema::RouteMatch) -> RouteMatchInfo {
    // The one field two kinds spell differently: HTTPRoute writes a verb,
    // GRPCRoute writes `{service, method}`.
    let (method, grpc_service, grpc_method) = match m.method {
        Some(serde_json::Value::String(verb)) => (Some(verb), None, None),
        Some(serde_json::Value::Object(fields)) => (
            None,
            fields
                .get("service")
                .and_then(|v| v.as_str())
                .map(String::from),
            fields
                .get("method")
                .and_then(|v| v.as_str())
                .map(String::from),
        ),
        _ => (None, None, None),
    };
    RouteMatchInfo {
        path: m.path.as_ref().and_then(|p| p.value.clone()),
        path_type: m.path.as_ref().and_then(|p| p.type_.clone()),
        method,
        grpc_service,
        grpc_method,
        headers: m
            .headers
            .into_iter()
            .map(|h| match h.value {
                Some(value) => format!("{}={value}", h.name),
                None => h.name,
            })
            .collect(),
    }
}

fn rule_info(rule: schema::RouteRule) -> RouteRuleInfo {
    RouteRuleInfo {
        has_redirect: rule.filters.iter().any(|f| f.type_ == "RequestRedirect"),
        extension_refs: rule
            .filters
            .iter()
            .filter_map(|f| f.extension_ref.as_ref())
            .map(|r| ExtensionRefInfo {
                group: r.group.clone().unwrap_or_default(),
                kind: r.kind.clone().unwrap_or_default(),
                name: r.name.clone(),
            })
            .collect(),
        matches: rule.matches.into_iter().map(match_info).collect(),
        backend_refs: rule
            .backend_refs
            .into_iter()
            .map(|b| BackendRefInfo {
                group: b.group.unwrap_or_default(),
                kind: b.kind.unwrap_or_else(|| "Service".to_string()),
                name: b.name,
                namespace: b.namespace,
                port: b.port,
                weight: b.weight,
            })
            .collect(),
    }
}

impl RouteInfo {
    /// Read any route kind out of a dynamic object, tolerantly: absent
    /// fields become empties, unknown fields are ignored, and nothing here
    /// fails — an unreadable spec is an empty route, not an error page.
    pub fn read(obj: &DynamicObject) -> Self {
        use kube::ResourceExt;

        let types = obj.types.clone().unwrap_or_default();
        let spec: schema::RouteSpec = section(obj, "spec");
        let status: schema::RouteStatus = section(obj, "status");

        Self {
            kind: types.kind,
            api_version: types.api_version,
            name: obj.name_any(),
            namespace: obj.namespace().unwrap_or_default(),
            hostnames: spec.hostnames,
            parent_refs: spec.parent_refs.into_iter().map(parent_ref_info).collect(),
            rules: spec.rules.into_iter().map(rule_info).collect(),
            parents: status
                .parents
                .into_iter()
                .map(|p| RouteParentStatusInfo {
                    parent: parent_ref_info(p.parent_ref),
                    controller_name: p.controller_name,
                    conditions: p.conditions,
                })
                .collect(),
            labels: obj.metadata.labels.clone().unwrap_or_default(),
            annotations: obj.metadata.annotations.clone().unwrap_or_default(),
            created_at: obj.metadata.creation_timestamp.as_ref().to_rfc3339_opt(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(yaml: &str) -> DynamicObject {
        serde_yaml::from_str(yaml).expect("fixture parses")
    }

    const HTTP_ROUTE_V1: &str = r#"
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: promo
  namespace: shop
  labels:
    app: promo
spec:
  parentRefs:
  - name: edge
    namespace: infra
    sectionName: https
  hostnames:
  - promo.example.com
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /promo
      method: GET
      headers:
      - name: x-canary
        value: "on"
    backendRefs:
    - name: promo
      port: 8080
      weight: 0
    - name: audit
      namespace: audit
      port: 9000
status:
  parents:
  - parentRef:
      name: edge
      namespace: infra
      sectionName: https
    controllerName: gateway.envoyproxy.io/gatewayclass-controller
    conditions:
    - type: Accepted
      status: "False"
      reason: NoMatchingListenerHostname
      message: no listener hostname matches promo.example.com
      lastTransitionTime: "2026-08-19T00:00:00Z"
      observedGeneration: 1
"#;

    #[test]
    fn http_route_spec_is_read() {
        let route = RouteInfo::read(&parse(HTTP_ROUTE_V1));

        assert_eq!(route.kind, "HTTPRoute");
        assert_eq!(route.api_version, "gateway.networking.k8s.io/v1");
        assert_eq!(route.name, "promo");
        assert_eq!(route.namespace, "shop");
        assert_eq!(route.hostnames, vec!["promo.example.com"]);
        assert_eq!(route.labels.get("app"), Some(&"promo".to_string()));

        let parent = &route.parent_refs[0];
        assert_eq!(parent.name, "edge");
        assert_eq!(parent.namespace.as_deref(), Some("infra"));
        assert_eq!(parent.section_name.as_deref(), Some("https"));
        // The API's defaults, filled in so no consumer re-implements them.
        assert_eq!(parent.kind, "Gateway");
        assert_eq!(parent.group, "gateway.networking.k8s.io");

        let m = &route.rules[0].matches[0];
        assert_eq!(m.path.as_deref(), Some("/promo"));
        assert_eq!(m.path_type.as_deref(), Some("PathPrefix"));
        assert_eq!(m.method.as_deref(), Some("GET"));
        assert_eq!(m.headers, vec!["x-canary=on"]);
    }

    #[test]
    fn http_route_backends_are_read() {
        let route = RouteInfo::read(&parse(HTTP_ROUTE_V1));
        let backends = &route.rules[0].backend_refs;

        assert_eq!(backends[0].name, "promo");
        assert_eq!(backends[0].kind, "Service");
        assert_eq!(backends[0].port, Some(8080));
        assert_eq!(backends[0].weight, Some(0));
        assert_eq!(backends[0].namespace, None);

        assert_eq!(backends[1].namespace.as_deref(), Some("audit"));
    }

    #[test]
    fn redirect_rule_reads_as_configuration_not_breakage() {
        let route = RouteInfo::read(&parse(
            r#"
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata: { name: to-https, namespace: shop }
spec:
  rules:
  - filters:
    - type: RequestRedirect
      requestRedirect: { scheme: https, statusCode: 301 }
"#,
        ));
        let rule = &route.rules[0];
        assert!(rule.has_redirect);
        assert!(rule.backend_refs.is_empty());
    }

    #[test]
    fn extension_ref_filter_is_named_not_hidden() {
        let route = RouteInfo::read(&parse(
            r#"
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata: { name: with-middleware, namespace: shop }
spec:
  rules:
  - filters:
    - type: ExtensionRef
      extensionRef: { group: traefik.io, kind: Middleware, name: strip-prefix }
    backendRefs:
    - { name: promo, port: 8080 }
"#,
        ));
        let ext = &route.rules[0].extension_refs[0];
        assert_eq!(ext.group, "traefik.io");
        assert_eq!(ext.kind, "Middleware");
        assert_eq!(ext.name, "strip-prefix");
        assert!(!route.rules[0].has_redirect);
    }

    #[test]
    fn grpc_route_method_match_is_read() {
        let route = RouteInfo::read(&parse(
            r#"
apiVersion: gateway.networking.k8s.io/v1
kind: GRPCRoute
metadata: { name: billing, namespace: shop }
spec:
  hostnames: [grpc.example.com]
  rules:
  - matches:
    - method: { service: billing.v1.Invoices, method: Create }
    backendRefs:
    - { name: billing, port: 9000 }
"#,
        ));
        assert_eq!(route.kind, "GRPCRoute");
        let m = &route.rules[0].matches[0];
        assert_eq!(m.grpc_service.as_deref(), Some("billing.v1.Invoices"));
        assert_eq!(m.grpc_method.as_deref(), Some("Create"));
        assert_eq!(m.method, None);
    }

    #[test]
    fn mesh_parent_ref_keeps_its_kind_and_core_group() {
        let route = RouteInfo::read(&parse(
            r#"
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata: { name: split, namespace: shop }
spec:
  parentRefs:
  - { group: "", kind: Service, name: promo }
"#,
        ));
        let parent = &route.parent_refs[0];
        // GAMMA: the explicit empty group is the core group, not a value
        // to "fix" back to the Gateway API default.
        assert_eq!(parent.group, "");
        assert_eq!(parent.kind, "Service");
    }

    #[test]
    fn v1alpha2_tls_route_reads_through_the_same_baseline() {
        let route = RouteInfo::read(&parse(
            r#"
apiVersion: gateway.networking.k8s.io/v1alpha2
kind: TLSRoute
metadata: { name: passthrough, namespace: shop }
spec:
  hostnames: [secure.example.com]
  parentRefs:
  - { name: edge, sectionName: tls }
  rules:
  - backendRefs:
    - { name: vault, port: 8200 }
"#,
        ));
        assert_eq!(route.api_version, "gateway.networking.k8s.io/v1alpha2");
        assert_eq!(route.hostnames, vec!["secure.example.com"]);
        assert_eq!(route.rules[0].backend_refs[0].name, "vault");
        assert!(route.rules[0].matches.is_empty());
    }

    const GATEWAY_V1: &str = r#"
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata: { name: edge, namespace: infra }
spec:
  gatewayClassName: envoy
  listeners:
  - name: https
    port: 443
    protocol: HTTPS
    hostname: "*.example.com"
    tls:
      mode: Terminate
      certificateRefs:
      - { name: wildcard-cert }
      - { name: shared-cert, namespace: certs, kind: Secret }
    allowedRoutes:
      namespaces: { from: All }
  - name: tls-passthrough
    port: 8443
    protocol: TLS
    tls: { mode: Passthrough }
status:
  addresses:
  - { type: IPAddress, value: 203.0.113.9 }
  conditions:
  - { type: Programmed, status: "True", reason: Programmed, message: ready }
  listeners:
  - name: https
    attachedRoutes: 4
    conditions:
    - { type: ResolvedRefs, status: "True", reason: ResolvedRefs, message: ok }
"#;

    #[test]
    fn gateway_listeners_and_status_are_read() {
        let gw = GatewayInfo::read(&parse(GATEWAY_V1));

        assert_eq!(gw.name, "edge");
        assert_eq!(gw.namespace, "infra");
        assert_eq!(gw.class_name, "envoy");
        assert_eq!(gw.addresses, vec!["203.0.113.9"]);
        assert_eq!(gw.conditions[0].type_, "Programmed");

        let https = &gw.listeners[0];
        assert_eq!(https.name, "https");
        assert_eq!(https.port, 443);
        assert_eq!(https.protocol, "HTTPS");
        assert_eq!(https.hostname.as_deref(), Some("*.example.com"));
        assert_eq!(https.tls_mode.as_deref(), Some("Terminate"));
        assert_eq!(https.allowed_namespaces.as_deref(), Some("All"));
        // Status is joined onto the listener it describes.
        assert_eq!(https.attached_routes, Some(4));
        assert_eq!(https.conditions[0].type_, "ResolvedRefs");
        assert_eq!(https.from_listener_set, None);

        let certs = &https.certificate_refs;
        assert_eq!(certs[0].name, "wildcard-cert");
        assert_eq!(certs[0].kind, "Secret");
        assert_eq!(certs[0].namespace, None);
        assert_eq!(certs[1].namespace.as_deref(), Some("certs"));

        let passthrough = &gw.listeners[1];
        assert_eq!(passthrough.hostname, None);
        assert_eq!(passthrough.tls_mode.as_deref(), Some("Passthrough"));
        // No allowedRoutes written means the spec default, Same — but that
        // is the API's default, not something a controller said; kept as
        // written.
        assert_eq!(passthrough.allowed_namespaces, None);
        assert_eq!(passthrough.attached_routes, None);
    }

    #[test]
    fn listener_set_merges_into_its_gateway_only() {
        let set = ListenerSetInfo::read(&parse(
            r#"
apiVersion: gateway.networking.k8s.io/v1
kind: ListenerSet
metadata: { name: tenant-a, namespace: infra }
spec:
  parentRef: { name: edge }
  listeners:
  - { name: tenant-a-https, port: 443, protocol: HTTPS, hostname: a.example.com }
status:
  conditions:
  - { type: Accepted, status: "True", reason: Accepted, message: ok }
"#,
        ));
        assert_eq!(set.gateway_name, "edge");
        // parentRef namespace defaults to the set's own.
        assert_eq!(set.gateway_namespace, "infra");

        let foreign = ListenerSetInfo {
            gateway_name: "other".to_string(),
            ..set.clone()
        };

        let mut gw = GatewayInfo::read(&parse(GATEWAY_V1));
        let own = gw.listeners.len();
        gw.merge_listener_sets(&[set, foreign]);

        assert_eq!(gw.listeners.len(), own + 1);
        let merged = gw.listeners.last().expect("merged listener");
        assert_eq!(merged.name, "tenant-a-https");
        assert_eq!(merged.from_listener_set.as_deref(), Some("tenant-a"));
    }

    #[test]
    fn gateway_class_unwritten_status_reads_as_unclaimed() {
        let class = GatewayClassInfo::read(&parse(
            r#"
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata: { name: envoy }
spec:
  controllerName: gateway.envoyproxy.io/gatewayclass-controller
"#,
        ));
        assert_eq!(
            class.controller_name,
            "gateway.envoyproxy.io/gatewayclass-controller"
        );
        assert_eq!(class.accepted, None);

        // The CRD's own default status — Accepted: Unknown, Waiting — is
        // the same honest answer: nothing claimed it.
        let waiting = GatewayClassInfo::read(&parse(
            r#"
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata: { name: idle }
spec: { controllerName: example.net/none }
status:
  conditions:
  - { type: Accepted, status: Unknown, reason: Waiting, message: waiting for controller }
"#,
        ));
        assert_eq!(waiting.accepted, None);

        let claimed = GatewayClassInfo::read(&parse(
            r#"
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata: { name: live }
spec: { controllerName: example.net/gw }
status:
  conditions:
  - { type: Accepted, status: "True", reason: Accepted, message: ok }
"#,
        ));
        assert_eq!(claimed.accepted, Some(true));
    }

    fn crd(
        name: &str,
        kind: &str,
        plural: &str,
        versions: &[(&str, bool)],
        annotations: &[(&str, &str)],
    ) -> k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition
    {
        use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::{
            CustomResourceDefinition, CustomResourceDefinitionNames, CustomResourceDefinitionSpec,
            CustomResourceDefinitionVersion,
        };
        CustomResourceDefinition {
            metadata: kube::core::ObjectMeta {
                name: Some(name.to_string()),
                annotations: Some(
                    annotations
                        .iter()
                        .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
                        .collect(),
                ),
                ..Default::default()
            },
            spec: CustomResourceDefinitionSpec {
                group: GATEWAY_API_GROUP.to_string(),
                names: CustomResourceDefinitionNames {
                    kind: kind.to_string(),
                    plural: plural.to_string(),
                    ..Default::default()
                },
                versions: versions
                    .iter()
                    .map(|(version, served)| CustomResourceDefinitionVersion {
                        name: (*version).to_string(),
                        served: *served,
                        storage: *version == "v1",
                        ..Default::default()
                    })
                    .collect(),
                ..Default::default()
            },
            status: None,
        }
    }

    const BUNDLE: (&str, &str) = ("gateway.networking.k8s.io/bundle-version", "v1.6.1");
    const CHANNEL: (&str, &str) = ("gateway.networking.k8s.io/channel", "standard");

    #[test]
    fn detection_reads_served_kinds_and_bundle() {
        let detection = GatewayApiDetection::from_crds(&[
            crd(
                "gateways.gateway.networking.k8s.io",
                "Gateway",
                "gateways",
                &[("v1", true), ("v1beta1", true)],
                &[BUNDLE, CHANNEL],
            ),
            crd(
                "httproutes.gateway.networking.k8s.io",
                "HTTPRoute",
                "httproutes",
                &[("v1", true), ("v1beta1", true)],
                &[BUNDLE, CHANNEL],
            ),
        ]);

        assert!(detection.installed);
        assert_eq!(detection.bundle_version.as_deref(), Some("v1.6.1"));
        assert_eq!(detection.channel.as_deref(), Some("standard"));
        assert!(!detection.mixed_bundle);

        let gateway = detection
            .kinds
            .iter()
            .find(|k| k.kind == "Gateway")
            .expect("Gateway is served");
        assert_eq!(gateway.read_version, "v1");
        assert_eq!(gateway.plural, "gateways");
        assert_eq!(gateway.versions, vec!["v1", "v1beta1"]);
    }

    #[test]
    fn detection_prefers_newest_served_version_and_reports_mixed_bundles() {
        let detection = GatewayApiDetection::from_crds(&[
            // An old bundle: v1beta1 only, annotated with its own release.
            crd(
                "gateways.gateway.networking.k8s.io",
                "Gateway",
                "gateways",
                &[("v1beta1", true)],
                &[("gateway.networking.k8s.io/bundle-version", "v0.8.0")],
            ),
            // The trio pre-graduation: v1alpha2 served, v1 present but off.
            crd(
                "tcproutes.gateway.networking.k8s.io",
                "TCPRoute",
                "tcproutes",
                &[("v1", false), ("v1alpha2", true)],
                &[BUNDLE],
            ),
        ]);

        let gateway = detection
            .kinds
            .iter()
            .find(|k| k.kind == "Gateway")
            .unwrap();
        assert_eq!(gateway.read_version, "v1beta1");

        let tcp = detection
            .kinds
            .iter()
            .find(|k| k.kind == "TCPRoute")
            .unwrap();
        assert_eq!(tcp.read_version, "v1alpha2");
        assert_eq!(tcp.versions, vec!["v1alpha2"]);

        assert!(detection.mixed_bundle);
        assert_eq!(detection.bundle_version, None);
    }

    #[test]
    fn detection_on_a_cluster_without_gateway_api() {
        let detection = GatewayApiDetection::from_crds(&[]);
        assert!(!detection.installed);
        assert!(detection.kinds.is_empty());
        assert_eq!(detection.bundle_version, None);
        assert!(!detection.mixed_bundle);
    }

    #[test]
    fn http_route_parent_status_is_read() {
        let route = RouteInfo::read(&parse(HTTP_ROUTE_V1));
        let parent = &route.parents[0];

        assert_eq!(
            parent.controller_name,
            "gateway.envoyproxy.io/gatewayclass-controller"
        );
        assert_eq!(parent.parent.name, "edge");
        let accepted = &parent.conditions[0];
        assert_eq!(accepted.type_, "Accepted");
        assert_eq!(accepted.status, "False");
        assert_eq!(
            accepted.reason.as_deref(),
            Some("NoMatchingListenerHostname")
        );
        assert!(accepted
            .message
            .as_deref()
            .is_some_and(|m| m.contains("promo.example.com")));
    }
}
