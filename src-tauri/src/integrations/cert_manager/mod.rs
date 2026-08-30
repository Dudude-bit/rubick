//! cert-manager, as an in-cluster extension.
//!
//! What it adds is not the expiry date — `tls.crt` states that on its own,
//! and the app reads it whether cert-manager is installed or not. What it
//! adds is *why*: a certificate four objects deep whose renewal has been
//! failing for six days, with the sentence that says what failed sitting on
//! the last of them.
//!
//! `Certificate` → `CertificateRequest` → `Order` → `Challenge` is four
//! unrelated custom resources on a list page today, and the reader walks
//! them by hand. This walks them once and hands back one story.
//!
//! Nothing here is offered to the app by name. The frontend asks for the
//! `certificate.issuance` capability and gets this or nothing.

use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
use kube::api::{Api, DynamicObject, ListParams};
use kube::core::GroupVersionKind;
use kube::discovery::ApiResource;
use kube::ResourceExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::commands::helpers::ResourceContext;
use crate::error::Result;
use crate::state::AppState;

use super::{version_from, DetectedExtension};

pub const ID: &str = "cert-manager";

/// The CRD whose presence *is* cert-manager. Not a heuristic: this object
/// exists in the API server or it does not.
const MARKER_CRD: &str = "certificates.cert-manager.io";

/// Is cert-manager installed, and which version.
#[must_use]
pub fn detect(crds: &[CustomResourceDefinition]) -> DetectedExtension {
    let installed = crds.iter().any(|crd| crd.name_any() == MARKER_CRD);
    DetectedExtension {
        id: ID.to_string(),
        installed: Some(installed),
        version: installed.then(|| version_from(crds, MARKER_CRD)).flatten(),
    }
}

// --- the story --------------------------------------------------------

/// What makes a step this step: the domain being proved, the revision
/// being requested.
///
/// Named rather than written — the words belong to the reader's language,
/// and the parts that are the cluster's (a challenge type, a domain) ride
/// through as values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "says", rename_all = "camelCase")]
pub enum StepNote {
    /// The controller's own message, quoted.
    Said { text: String },
    /// Which attempt at the certificate this request is.
    Attempt { revision: i64 },
    /// The challenge type and the domain it proves.
    ChallengeOn { kind: String, domain: String },
}

/// Which object in the chain has not finished, in one short clause.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "says", rename_all = "camelCase")]
pub enum Stalled {
    /// Nothing has asked for the certificate yet.
    NotRequested,
    /// A request exists and no Order came of it.
    RequestNotIssued,
    /// A challenge is outstanding.
    ChallengePending { kind: String, domain: String },
    /// The Order itself has not finished.
    OrderNotCompleted,
}

/// One object on the way from "I want a certificate" to a certificate.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssuanceStep {
    pub kind: String,
    pub name: String,
    /// The word the object uses for itself: `pending`, `valid`, `ready`,
    /// `errored`. Passed through rather than translated — a paraphrase of a
    /// controller's own state is a guess the reader cannot check.
    pub state: String,
    /// What makes this step this step, named — see [`StepNote`].
    pub note: Option<StepNote>,
    /// Whether the walk stops here.
    pub failed: bool,
}

/// How a certificate came to be what it is, ending on what went wrong.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssuanceStory {
    pub certificate: String,
    pub namespace: String,
    /// `letsencrypt-prod`, and whether it is an `Issuer` or a `ClusterIssuer`.
    pub issuer: String,
    pub issuer_kind: String,
    pub dns_names: Vec<String>,
    /// When cert-manager will next try to renew, where it has said so.
    pub renewal_time: Option<String>,
    /// True while cert-manager is trying to issue or renew right now. A
    /// certificate that is simply serving has nothing in flight and the
    /// surface says one line about it.
    pub in_flight: bool,
    /// The sentence that says what failed, from the deepest object with one.
    /// Verbatim — a paraphrase of a controller's own words is a guess the
    /// reader cannot check.
    pub failure: Option<String>,
    /// Which object has not finished, in one short clause — see
    /// [`Stalled`]. The verbatim reason above runs to three wrapped lines
    /// of ACME URLs, which is right on a page and wrong on a chain hop.
    pub stalled: Option<Stalled>,
    /// When the attempt now in flight started.
    pub since: Option<String>,
    /// `status.failedIssuanceAttempts` — how many times this has gone round.
    pub attempts: Option<i64>,
    /// The walk, outermost first. Empty where nothing is in flight.
    pub steps: Vec<IssuanceStep>,
}

fn resource(kind: &str, plural: &str, group: &str) -> ApiResource {
    ApiResource::from_gvk_with_plural(&GroupVersionKind::gvk(group, "v1", kind), plural)
}

const CERT_GROUP: &str = "cert-manager.io";
const ACME_GROUP: &str = "acme.cert-manager.io";

/// The issuance story behind one TLS Secret, or `None` where no Certificate
/// claims it.
///
/// Keyed on the Secret rather than on the Certificate because that is what
/// the reader arrived with: an Ingress names a Secret, and whether anything
/// manages that Secret is exactly the question.
#[tauri::command]
pub async fn get_certificate_issuance(
    namespace: String,
    secret_name: String,
    state: State<'_, AppState>,
) -> Result<Option<IssuanceStory>> {
    crate::validation::validate_dns_subdomain(&secret_name)?;
    let ctx = ResourceContext::for_command(&state, Some(namespace.clone()))?;

    let certificates: Api<DynamicObject> =
        ctx.dynamic_api_for_resource(&resource("Certificate", "certificates", CERT_GROUP), false);
    let all = certificates.list(&ListParams::default()).await?;
    let Some(cert) = all.items.into_iter().find(|item| {
        string_at(&item.data, &["spec", "secretName"]).as_deref() == Some(&secret_name)
    }) else {
        return Ok(None);
    };

    let cert_name = cert.name_any();
    let cert_uid = cert.metadata.uid.clone().unwrap_or_default();
    let ready = condition(&cert.data, "Ready");
    let issuing = condition(&cert.data, "Issuing");
    let in_flight = issuing.as_ref().is_some_and(|c| c.status == "True")
        || ready.as_ref().is_some_and(|c| c.status != "True");

    let mut story = IssuanceStory {
        certificate: cert_name.clone(),
        namespace: namespace.clone(),
        issuer: string_at(&cert.data, &["spec", "issuerRef", "name"]).unwrap_or_default(),
        issuer_kind: string_at(&cert.data, &["spec", "issuerRef", "kind"])
            .unwrap_or_else(|| "Issuer".to_string()),
        dns_names: strings_at(&cert.data, &["spec", "dnsNames"]),
        renewal_time: string_at(&cert.data, &["status", "renewalTime"]),
        in_flight,
        failure: None,
        stalled: None,
        since: issuing
            .as_ref()
            .or(ready.as_ref())
            .and_then(|c| c.since.clone()),
        attempts: cert
            .data
            .pointer("/status/failedIssuanceAttempts")
            .and_then(Value::as_i64),
        steps: Vec::new(),
    };

    // A certificate that is simply serving has no walk to draw. Most
    // certificates renew fine forever; the walk exists for the one that did
    // not, and drawing it on the ones that did is how it stops being read.
    if !in_flight {
        return Ok(Some(story));
    }

    story.steps.push(IssuanceStep {
        kind: "Certificate".to_string(),
        name: cert_name,
        state: issuing
            .as_ref()
            .map_or_else(|| "pending".to_string(), |c| c.reason.clone()),
        note: issuing
            .as_ref()
            .and_then(|c| c.message.clone())
            .map(|text| StepNote::Said { text }),
        failed: false,
    });
    let mut deepest = ready.as_ref().and_then(|c| c.message.clone());

    let requests: Api<DynamicObject> = ctx.dynamic_api_for_resource(
        &resource("CertificateRequest", "certificaterequests", CERT_GROUP),
        false,
    );
    let request = requests
        .list(&ListParams::default())
        .await?
        .items
        .into_iter()
        .filter(|item| owned_by(item, &cert_uid))
        .max_by_key(revision_of);

    let Some(request) = request else {
        story.failure = deepest;
        story.stalled = Some(Stalled::NotRequested);
        return Ok(Some(story));
    };
    let request_ready = condition(&request.data, "Ready");
    let request_failed = request_ready
        .as_ref()
        .is_some_and(|c| c.reason == "Failed" || c.reason == "Denied");
    if let Some(message) = request_ready.as_ref().and_then(|c| c.message.clone()) {
        deepest = Some(message);
    }
    story.steps.push(IssuanceStep {
        kind: "CertificateRequest".to_string(),
        name: request.name_any(),
        state: request_ready
            .as_ref()
            .map_or_else(|| "pending".to_string(), |c| c.reason.to_lowercase()),
        note: revision_of(&request).map(|revision| StepNote::Attempt { revision }),
        failed: request_failed,
    });

    // Only an ACME issuer has an Order under it. A CA or self-signed one
    // stops here, and the story is complete rather than truncated.
    let orders: Api<DynamicObject> =
        ctx.dynamic_api_for_resource(&resource("Order", "orders", ACME_GROUP), false);
    let request_uid = request.metadata.uid.clone().unwrap_or_default();
    let order = orders
        .list(&ListParams::default())
        .await
        .ok()
        .and_then(|list| {
            list.items
                .into_iter()
                .find(|item| owned_by(item, &request_uid))
        });

    let Some(order) = order else {
        story.failure = deepest;
        story.stalled = Some(Stalled::RequestNotIssued);
        return Ok(Some(story));
    };
    let order_state = string_at(&order.data, &["status", "state"]).unwrap_or_default();
    if let Some(reason) = string_at(&order.data, &["status", "reason"]) {
        deepest = Some(reason);
    }
    story.steps.push(IssuanceStep {
        kind: "Order".to_string(),
        name: order.name_any(),
        state: order_state.clone(),
        note: None,
        failed: matches!(order_state.as_str(), "invalid" | "errored" | "expired"),
    });

    let challenges: Api<DynamicObject> =
        ctx.dynamic_api_for_resource(&resource("Challenge", "challenges", ACME_GROUP), false);
    let order_uid = order.metadata.uid.clone().unwrap_or_default();
    let found = challenges
        .list(&ListParams::default())
        .await
        .map(|list| list.items)
        .unwrap_or_default();
    for challenge in found.into_iter().filter(|item| owned_by(item, &order_uid)) {
        let state = string_at(&challenge.data, &["status", "state"]).unwrap_or_default();
        if let Some(reason) = string_at(&challenge.data, &["status", "reason"]) {
            deepest = Some(reason);
        }
        let kind = string_at(&challenge.data, &["spec", "type"]).unwrap_or_default();
        let domain = string_at(&challenge.data, &["spec", "dnsName"]).unwrap_or_default();
        story.stalled = Some(Stalled::ChallengePending {
            kind: kind.clone(),
            domain: domain.clone(),
        });
        story.steps.push(IssuanceStep {
            kind: "Challenge".to_string(),
            name: challenge.name_any(),
            state: state.clone(),
            note: Some(StepNote::ChallengeOn { kind, domain }),
            failed: matches!(state.as_str(), "invalid" | "errored" | "expired"),
        });
    }

    story.stalled = story.stalled.or(Some(Stalled::OrderNotCompleted));
    story.failure = deepest;
    Ok(Some(story))
}

// --- reading a custom resource without a type for it --------------------

struct Condition {
    status: String,
    reason: String,
    message: Option<String>,
    since: Option<String>,
}

fn condition(data: &Value, kind: &str) -> Option<Condition> {
    data.pointer("/status/conditions")?
        .as_array()?
        .iter()
        .find(|entry| entry.get("type").and_then(Value::as_str) == Some(kind))
        .map(|entry| Condition {
            status: text(entry.get("status")),
            reason: text(entry.get("reason")),
            message: entry
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_string),
            since: entry
                .get("lastTransitionTime")
                .and_then(Value::as_str)
                .map(str::to_string),
        })
}

fn text(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn string_at(data: &Value, path: &[&str]) -> Option<String> {
    let mut node = data;
    for step in path {
        node = node.get(step)?;
    }
    node.as_str().map(str::to_string)
}

fn strings_at(data: &Value, path: &[&str]) -> Vec<String> {
    let mut node = data;
    for step in path {
        let Some(next) = node.get(step) else {
            return Vec::new();
        };
        node = next;
    }
    node.as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Ownership is what ties the four objects together — cert-manager sets it,
/// so the walk follows a fact rather than a name that happens to match.
fn owned_by(object: &DynamicObject, uid: &str) -> bool {
    !uid.is_empty()
        && object
            .metadata
            .owner_references
            .iter()
            .flatten()
            .any(|owner| owner.uid == uid)
}

const REVISION_ANNOTATION: &str = "cert-manager.io/certificate-revision";

fn revision_of(request: &DynamicObject) -> Option<i64> {
    request.annotations().get(REVISION_ANNOTATION)?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinitionSpec;
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
    use std::collections::BTreeMap;

    fn crd(name: &str, version: Option<&str>) -> CustomResourceDefinition {
        let mut labels = BTreeMap::new();
        if let Some(version) = version {
            labels.insert("app.kubernetes.io/version".to_string(), version.to_string());
        }
        CustomResourceDefinition {
            metadata: ObjectMeta {
                name: Some(name.to_string()),
                labels: Some(labels),
                ..Default::default()
            },
            spec: CustomResourceDefinitionSpec::default(),
            status: None,
        }
    }

    /// Would break if detection turned into a heuristic. The marker CRD is
    /// there or it is not; nothing here sniffs a name or a port, which is
    /// the only reason detecting rather than asking is allowed at all.
    #[test]
    fn detection_is_the_crd_and_nothing_else() {
        let with = vec![crd("certificates.cert-manager.io", Some("v1.16.3"))];
        assert_eq!(detect(&with).installed, Some(true));
        assert_eq!(detect(&with).version.as_deref(), Some("v1.16.3"));

        // A cluster with other operators on it, and no cert-manager.
        let without = vec![crd("ingressroutes.traefik.io", Some("v3.1.2"))];
        assert_eq!(detect(&without).installed, Some(false));
        assert_eq!(detect(&without).version, None);
    }

    /// Would break if a cert-manager that does not label its CRDs stopped
    /// being detected — the version is a nicety, presence is the fact.
    #[test]
    fn an_unlabelled_install_is_still_an_install() {
        let crds = vec![crd("certificates.cert-manager.io", None)];
        assert_eq!(detect(&crds).installed, Some(true));
        assert_eq!(detect(&crds).version, None);
    }
}
