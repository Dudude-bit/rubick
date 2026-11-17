//! What is deployed in a way that will hurt later: workload templates and
//! configuration read against the Pod Security Standards and common
//! practice, never changed from here.
//!
//! A rule answers only for what it read. Where a kind it needs went unread
//! it says so for that object instead of passing it.

mod admitted;
mod answer;
mod context;
mod deprecated;
mod detail;
mod index;
mod names;
mod objects;
pub mod rules;
mod template;
mod upgrade;
mod usage;

use std::time::Duration;

use k8s_openapi::api::core::v1::Namespace;
use kube::api::{Api, ListParams};
use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::state::AppState;

pub use answer::{
    AuditPage, AuditQuery, AuditRow, AuditSummary, Enforced, Grouping, KindChecked, NotChecked,
    ObjectAudit, RuleCount, UpgradeRead,
};
pub use deprecated::DEPRECATED_API;
pub use detail::object_audit;
pub use index::{feed_ask, AuditIndexes};
pub use rules::{AuditSeverity, Category, RuleId, Standard};
pub use upgrade::{Removal, HELM_RELEASE};
pub use usage::{OverBy, UnreadPods, UsageRead, UsageState, UseVerdict, WorkloadUse};

/// Which list of a pod spec a container is in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ContainerList {
    Containers,
    InitContainers,
    EphemeralContainers,
}

/// One container of a pod spec, by the list it is in and its name.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct At {
    pub list: ContainerList,
    pub container: String,
}

/// What sends traffic to a workload's pods, for how much a missing
/// readiness probe costs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "says", rename_all = "camelCase")]
pub enum TrafficBy {
    Service { name: String },
    NoService,
    NotRead { why: Why },
}

/// What mounts the `default` `ServiceAccount`'s token into the pods.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TokenBy {
    /// The pod spec sets `automountServiceAccountToken: true`.
    Pod,
    /// The `ServiceAccount` sets it to true.
    Account,
    /// Neither sets it, and Kubernetes mounts it.
    Default,
}

/// One value a finding is about, in the object's own words. Never a
/// secret's value: the variants that name one carry its name alone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "says", rename_all = "camelCase")]
pub enum What {
    /// `field` holds `value`, on container `at` or on the pod where none.
    Set {
        at: Option<At>,
        field: String,
        value: String,
    },
    /// `field` is not set where the rule wants it.
    Unset {
        at: Option<At>,
        field: String,
    },
    /// A volume of a source the rule names; `path` for a hostPath.
    Volume {
        volume: String,
        source: String,
        path: Option<String>,
    },
    /// A hostPath that reaches a container runtime's socket.
    Socket {
        volume: String,
        path: String,
        socket: String,
    },
    /// An env variable set to a literal under a name that suggests a secret.
    EnvLiteral {
        at: At,
        variable: String,
    },
    /// A `ConfigMap` key holding a private key, and the net that caught it.
    Key {
        key: String,
        net: crate::resources::Withheld,
    },
    Image {
        at: At,
        image: String,
    },
    /// The replicas a workload keeps at least: its own, or its autoscaler's floor.
    Replicas {
        replicas: i32,
        autoscaler: Option<String>,
    },
    Budget {
        required: i32,
        selected: i32,
    },
    Token {
        by: TokenBy,
    },
    /// A subject a binding grants `role` to.
    Subject {
        kind: String,
        name: String,
        namespace: Option<String>,
        role: String,
    },
    /// A rule of a role granting every verb on every resource of these groups.
    Wildcard {
        groups: Vec<String>,
    },
    Range {
        min: i32,
        max: i32,
    },
    Target {
        kind: String,
        name: String,
    },
    Pods {
        pods: usize,
    },
    Traffic {
        by: TrafficBy,
    },
    /// The revision of a Helm release an upgrade builds from, and its
    /// status as Helm wrote it.
    Revision {
        revision: i32,
        status: String,
    },
    /// An object a release's stored manifest names at `api`, whether this
    /// cluster serves that, and when Kubernetes removes it where the guide says.
    Stored {
        kind: String,
        name: String,
        api: String,
        served: bool,
        removal: Option<Removal>,
    },
    /// A field manager last wrote the object through `api`, which a later
    /// Kubernetes removes.
    Written {
        manager: String,
        operation: String,
        time: Option<String>,
        api: String,
        removal: Removal,
    },
    /// A served version its CRD marks deprecated, with the CRD's own
    /// warning, and whether objects may be stored at it.
    Deprecated {
        version: String,
        warning: Option<String>,
        stored: bool,
        storage: bool,
    },
    /// Where a CRD's objects are stored: the storage version, every version
    /// they may still be stored at, and the served versions not deprecated.
    StoredAs {
        group: String,
        kind: String,
        storage: Option<String>,
        stored: Vec<String>,
        current: Vec<String>,
    },
    /// The API server counted a request to this deprecated API since it
    /// started, and names the release that removes it where it does.
    Requested {
        kind: Option<String>,
        removed: Option<String>,
        replacement: Option<String>,
    },
    /// Its requests in the last day, as the API server counted them.
    RequestedToday {
        requests: u64,
    },
    /// What a workload requests of `resource`, `cpu` in millicores or
    /// `memory` in bytes, and the most it used in the usage window.
    OverRequested {
        resource: String,
        requested: u64,
        peak: u64,
    },
}

/// One rule an object breaks, and where.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditFinding {
    pub rule: RuleId,
    /// The rule's usual severity, or the one a value it found raises it to.
    pub severity: AuditSeverity,
    pub what: Vec<What>,
}

impl AuditFinding {
    #[must_use]
    pub fn of(rule: RuleId, what: Vec<What>) -> Self {
        Self {
            rule,
            severity: rule.rule().severity,
            what,
        }
    }
}

/// Why a kind a rule needs was not read where the rule would have looked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "says", rename_all = "camelCase")]
pub enum Why {
    /// Still listing.
    Reading,
    /// Waiting for a watch the app holds as many of as it allows itself.
    Queued,
    Refused {
        message: String,
    },
    Failed {
        message: String,
    },
    /// A kind Audit does not read: an autoscaler's target of another kind.
    NotAudited,
    /// A kind this cluster does not serve.
    Unserved,
    /// No Prometheus is connected to this cluster, where a rule reads one.
    NoPrometheus,
    /// The connected Prometheus holds none of the API server's metrics.
    NotScraped,
    /// Nothing keeps usage history for this cluster: no Prometheus connected.
    NoUsage,
    /// The usage supplier holds no sample of its pods in the window.
    NoSamples,
    /// Its youngest pod, started at `since` where known, has not been seen
    /// to run the usage window.
    Young {
        since: Option<String>,
    },
    /// Past the row cap of the requests list, its usage was read only as a sum.
    Folded,
    /// Pods here pass these mutating webhooks, which may add containers
    /// the template does not show.
    Admitted {
        webhooks: Vec<String>,
    },
}

/// Why a read did not answer: refused, or failed in the server's words.
fn why_of(error: &crate::error::Error) -> Why {
    if error.is_refusal() {
        Why::Refused {
            message: error.said(),
        }
    } else {
        Why::Failed {
            message: error.said(),
        }
    }
}

/// A rule that could not answer for one object.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Unchecked {
    pub rule: RuleId,
    pub kind: String,
    pub namespace: Option<String>,
    pub why: Why,
}

/// An object Audit judges.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Subject {
    pub kind: String,
    pub namespace: Option<String>,
    pub name: String,
}

/// Namespaces Kubernetes reserves for itself, and the roles and bindings it
/// makes. Shown folded, never hidden.
///
/// `kube-` is reserved for system namespaces (concepts/overview/
/// working-with-objects/namespaces), `system:` for the system's users,
/// groups and roles, and the default roles carry
/// `kubernetes.io/bootstrapping=rbac-defaults` (reference/access-authn-authz/rbac).
#[must_use]
pub fn is_system(
    subject: &Subject,
    labels: Option<&std::collections::BTreeMap<String, String>>,
) -> bool {
    match &subject.namespace {
        Some(namespace) => is_system_namespace(namespace),
        None => {
            subject.name.starts_with("system:")
                || labels.is_some_and(|labels| {
                    labels
                        .get("kubernetes.io/bootstrapping")
                        .map(String::as_str)
                        == Some("rbac-defaults")
                })
                || (subject.kind == "Namespace" && is_system_namespace(&subject.name))
        }
    }
}

#[must_use]
pub fn is_system_namespace(namespace: &str) -> bool {
    namespace.starts_with("kube-")
}

/// The cluster's Kubernetes minor version, as its session read it: `31`
/// of `1.31`, and of GKE's `1.31+`.
#[must_use]
pub fn minor_of(state: &AppState, context: &str) -> Option<u32> {
    let session = state.sessions.get(context)?;
    let minor = session.info.server_version.split('.').nth(1)?;
    let digits: String = minor.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

/// How long the namespaces' Pod Security labels, read for a caption, are kept.
const ENFORCED_FOR: Duration = Duration::from_mins(1);
const ENFORCE_LABEL: &str = "pod-security.kubernetes.io/enforce";

fn enforced_of(
    meta: k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta,
) -> Option<Enforced> {
    let level = meta.labels?.remove(ENFORCE_LABEL)?;
    Some(Enforced {
        namespace: meta.name?,
        level,
    })
}

/// The scope's namespaces' Pod Security labels: every namespace listed, or,
/// where the list is refused to a reader bound to namespaces, each one of
/// the scope read on its own. `None` beside the list where it went whole.
async fn read_enforced(
    client: &kube::Client,
    scope: Option<&[String]>,
) -> std::result::Result<(Vec<Enforced>, bool), Why> {
    let api: Api<Namespace> = Api::all(client.clone());
    match api.list_metadata(&ListParams::default()).await {
        Ok(list) => Ok((
            list.items
                .into_iter()
                .filter_map(|ns| enforced_of(ns.metadata))
                .collect(),
            true,
        )),
        Err(error) => {
            let Some(names) = scope else {
                return Err(why_of(&error.into()));
            };
            let mut found = Vec::new();
            for name in names {
                let meta = api
                    .get_metadata(name)
                    .await
                    .map_err(|error| why_of(&error.into()))?;
                found.extend(enforced_of(meta.metadata));
            }
            Ok((found, false))
        }
    }
}

/// Which namespaces enforce a Pod Security level, from their labels
/// (concepts/security/pod-security-admission). A caption only, changing no
/// verdict; a read that fails says why rather than reading as none.
async fn enforced(
    state: &AppState,
    here: &crate::state::Here<'_>,
    scope: Option<&[String]>,
) -> std::result::Result<Vec<Enforced>, Why> {
    let kept = state
        .audit
        .enforced
        .get(&here.context)
        .filter(|kept| kept.0.elapsed() < ENFORCED_FOR)
        .map(|kept| kept.1.clone());
    let all = if let Some(all) = kept {
        all
    } else {
        let era = state.audit.era(&here.context);
        let (read, whole) = read_enforced(&here.client, scope).await?;
        if whole {
            state.audit.keep_enforced(era, &here.context, read.clone());
        }
        read
    };
    Ok(all
        .into_iter()
        .filter(|each| scope.is_none_or(|names| names.contains(&each.namespace)))
        .collect())
}

/// One page of the Audit page's answer. The page being on screen is what
/// starts the index, and the ownership index its pods are read from.
pub async fn audit_page(
    state: &AppState,
    scope: Option<Vec<String>>,
    query: &AuditQuery,
    usage: Option<&UsageRead>,
) -> Result<AuditPage> {
    let scope = crate::commands::helpers::scope_of(scope)?;
    let here = state.here()?;
    let minor = minor_of(state, &here.context);
    let owners = state
        .ownership
        .ensure_on(&here, scope.clone())
        .await
        .map_err(|error| Why::Failed {
            message: error.said(),
        });
    let index = state
        .audit
        .ensure(state, &here, scope.clone(), minor)
        .await?;
    let mut seen = answer::world(&index, owners.as_ref().map(AsRef::as_ref), scope.as_deref());
    usage::merge(&mut seen, usage);
    let enforced = enforced(state, &here, scope.as_deref()).await;
    let mut page = answer::page(
        &seen,
        query,
        index.revision.load(std::sync::atomic::Ordering::Relaxed),
        enforced.clone().unwrap_or_default(),
    );
    page.summary.enforced_unread = enforced.err();
    page.summary.upgrade.server = state
        .sessions
        .get(&here.context)
        .map(|session| session.info.server_version.clone());
    Ok(page)
}

/// One object's findings with what the webview read of its usage judged in,
/// for its tab, its peek and the row the Audit page opens.
pub async fn object_audit_with(
    state: &AppState,
    kind: &str,
    namespace: Option<&str>,
    name: &str,
    usage: Option<&UsageRead>,
) -> Result<ObjectAudit> {
    let mut audit = object_audit(state, kind, namespace, name).await?;
    usage::apply(&mut audit, usage);
    Ok(audit)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::client::served::test_server::{answering, failure};

    /// A refused list of namespaces is not "none enforces": a reader bound
    /// to namespaces has its own read one at a time, and with no scope to
    /// read the refusal is said. Fails if a refusal reads as an empty list.
    #[tokio::test]
    async fn a_refused_namespace_list_is_read_per_namespace_or_said_unread() {
        let (client, _) = answering(|path, _| match path {
            "/api/v1/namespaces/shop" => (
                200,
                json!({ "apiVersion": "meta.k8s.io/v1", "kind": "PartialObjectMetadata",
                    "metadata": { "name": "shop",
                        "labels": { "pod-security.kubernetes.io/enforce": "baseline" } } })
                .to_string(),
            ),
            _ => failure(403, "Forbidden"),
        })
        .await;
        let shop = ["shop".to_string()];
        let (found, whole) = read_enforced(&client, Some(&shop)).await.expect("read");
        assert!(!whole);
        assert_eq!(
            found,
            vec![Enforced {
                namespace: "shop".to_string(),
                level: "baseline".to_string(),
            }]
        );
        assert!(matches!(
            read_enforced(&client, None).await,
            Err(Why::Refused { .. })
        ));
    }
}
