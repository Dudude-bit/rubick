//! Two more readings of what goes away: a custom resource version its own
//! CRD marks deprecated, and the API server's own count of the deprecated
//! APIs it was asked for, `apiserver_requested_deprecated_apis`, read from
//! the Prometheus this cluster is connected to. That gauge is set to 1 for
//! each deprecated group, version, resource and subresource requested since
//! the server started, with the release that removes it in
//! `removed_release` (reference/instrumentation/metrics; the 2020
//! "Warning: Helpful Warnings Ahead" post).

use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

use futures::StreamExt;
use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::CustomResourceDefinition;
use kube::api::{Api, ListParams};
use kube::Client;

use super::answer::{Audited, NotChecked};
use super::upgrade::{removal, Group, Groups, Read};
use super::{AuditFinding, AuditSeverity, RuleId, Subject, What, Why};
use crate::config::PrometheusEntry;
use crate::integrations::prometheus::{instant, PromSeries};
use crate::resources::shown_text;

/// A deprecated API the server was asked for, as a subject: no kind holds a dot.
pub const DEPRECATED_API: &str = "DeprecatedAPI.k8s.io";

const CRD: &str = "CustomResourceDefinition";

/// The metric, named where it could not be read.
const METRIC: &str = "apiserver_requested_deprecated_apis";

/// Each deprecated API requested since a server started, over the last day
/// so a restart does not hide one, across every API server scraped.
const REQUESTED: &str = "max by (group, version, resource, subresource, removed_release) (max_over_time(apiserver_requested_deprecated_apis[1d]))";

/// Whether the API server's metrics are there at all: with none, an empty
/// answer above is not "nothing deprecated was asked for".
const SCRAPED: &str = "count(apiserver_request_total)";

/// How many requests each deprecated API had in the last day.
const TODAY: &str = "sum by (group, version, resource, subresource) (increase(apiserver_request_total[1d])) and on (group, version, resource, subresource) max by (group, version, resource, subresource) (max_over_time(apiserver_requested_deprecated_apis[1d]))";

/// What a CRD says of its versions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CrdFacts {
    pub name: String,
    pub group: String,
    pub kind: String,
    /// Served versions marked deprecated, each with its own warning.
    pub deprecated: Vec<(String, Option<String>)>,
    /// Served versions not marked deprecated.
    pub current: Vec<String>,
    pub storage: Option<String>,
    /// Every version objects may be stored at (`status.storedVersions`).
    pub stored: Vec<String>,
}

#[must_use]
pub fn crd_facts(crd: &CustomResourceDefinition) -> CrdFacts {
    let served = crd.spec.versions.iter().filter(|v| v.served);
    let (deprecated, current): (Vec<_>, Vec<_>) =
        served.partition(|v| v.deprecated.unwrap_or(false));
    CrdFacts {
        name: crd.metadata.name.clone().unwrap_or_default(),
        group: crd.spec.group.clone(),
        kind: crd.spec.names.kind.clone(),
        deprecated: deprecated
            .into_iter()
            .map(|v| (v.name.clone(), v.deprecation_warning.clone()))
            .collect(),
        current: current.into_iter().map(|v| v.name.clone()).collect(),
        storage: crd
            .spec
            .versions
            .iter()
            .find(|v| v.storage)
            .map(|v| v.name.clone()),
        stored: crd
            .status
            .as_ref()
            .and_then(|s| s.stored_versions.clone())
            .unwrap_or_default(),
    }
}

/// A CRD serving a version it marks deprecated: Low, or Medium where objects
/// may still be stored at it, since a CRD that drops a version still in
/// `status.storedVersions` is refused until they are migrated
/// (tasks/extend-kubernetes/custom-resources/custom-resource-definition-versioning).
#[must_use]
pub fn judge_crd(facts: &CrdFacts) -> Option<AuditFinding> {
    if facts.deprecated.is_empty() {
        return None;
    }
    let mut what: Vec<What> = facts
        .deprecated
        .iter()
        .map(|(version, warning)| What::Deprecated {
            version: version.clone(),
            warning: warning.as_deref().map(shown_text),
            stored: facts.stored.contains(version),
            storage: facts.storage.as_ref() == Some(version),
        })
        .collect();
    let held = what
        .iter()
        .any(|w| matches!(w, What::Deprecated { stored: true, .. }));
    what.push(What::StoredAs {
        group: facts.group.clone(),
        kind: facts.kind.clone(),
        storage: facts.storage.clone(),
        stored: facts.stored.clone(),
        current: facts.current.clone(),
    });
    let mut finding = AuditFinding::of(RuleId::CrdVersionDeprecated, what);
    if held {
        finding.severity = AuditSeverity::Medium;
    }
    Some(finding)
}

/// CRDs judged, by name, kept while their `resourceVersion` holds.
pub type KeptCrds = HashMap<String, (String, Arc<CrdFacts>)>;

/// Every CRD's versions, each fetched whole only where it changed since the
/// last pass: a CRD carries its schema, megabytes for some, and the list
/// that names them carries none.
pub async fn read_crds(client: &Client, kept: &mut KeptCrds, fetched: &mut u64, read: &mut Read) {
    let api: Api<CustomResourceDefinition> = Api::all(client.clone());
    let listed = match api.list_metadata(&ListParams::default()).await {
        Ok(listed) => listed.items,
        Err(error) => {
            read.not_checked.push(NotChecked {
                kind: CRD.to_string(),
                namespace: None,
                why: super::why_of(&crate::error::Error::from(error)),
                rules: vec![RuleId::CrdVersionDeprecated],
            });
            return;
        }
    };
    let live: Vec<(String, String)> = listed
        .into_iter()
        .filter_map(|meta| {
            Some((
                meta.metadata.name?,
                meta.metadata.resource_version.unwrap_or_default(),
            ))
        })
        .collect();
    let stale: Vec<String> = live
        .iter()
        .filter(|(name, version)| kept.get(name).is_none_or(|(held, _)| held != version))
        .map(|(name, _)| name.clone())
        .collect();
    let got = futures::stream::iter(stale)
        .map(|name| {
            let api = api.clone();
            async move { (api.get_opt(&name).await, name) }
        })
        .buffer_unordered(6)
        .collect::<Vec<_>>()
        .await;
    let mut failed = Vec::new();
    for (answer, name) in got {
        *fetched += 1;
        match answer {
            Ok(Some(crd)) => {
                let version = crd.metadata.resource_version.clone().unwrap_or_default();
                kept.insert(name, (version, Arc::new(crd_facts(&crd))));
            }
            Ok(None) => {}
            Err(error) => {
                kept.remove(&name);
                failed.push((name, super::why_of(&crate::error::Error::from(error))));
            }
        }
    }
    let names: BTreeSet<&String> = live.iter().map(|(name, _)| name).collect();
    kept.retain(|name, _| names.contains(name));
    *read.checked.entry(CRD.to_string()).or_default() += kept.len() as u32;
    for (name, why) in failed {
        read.objects.push(Audited {
            subject: crd_subject(&name),
            system: false,
            findings: Vec::new(),
            unchecked: vec![super::Unchecked {
                rule: RuleId::CrdVersionDeprecated,
                kind: CRD.to_string(),
                namespace: None,
                why,
            }],
        });
    }
    for facts in kept.values().map(|(_, facts)| facts) {
        if let Some(finding) = judge_crd(facts) {
            read.objects.push(Audited {
                subject: crd_subject(&facts.name),
                system: false,
                findings: vec![finding],
                unchecked: Vec::new(),
            });
        }
    }
}

fn crd_subject(name: &str) -> Subject {
    Subject {
        kind: CRD.to_string(),
        namespace: None,
        name: name.to_string(),
    }
}

/// Where the API server's own count is read from.
#[derive(Debug, Clone)]
pub enum Prometheus {
    NotConnected,
    /// Configured, and not to be asked: its address is another cluster's tunnel.
    Unusable(Why),
    Connected(PrometheusEntry),
}

/// One deprecated API the server counted, by its labels.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Requested {
    pub group: String,
    pub version: String,
    pub resource: String,
    pub subresource: String,
    /// `None` where the server names no release.
    pub removed: Option<String>,
}

/// The count as Prometheus answered it: the APIs, and each one's requests
/// in the last day where that was answered too.
#[derive(Debug, Clone, PartialEq)]
pub struct Counted {
    pub requested: Vec<Requested>,
    pub today: Option<HashMap<(String, String, String, String), u64>>,
}

fn label<'a>(series: &'a PromSeries, name: &str) -> &'a str {
    series.labels.get(name).map_or("", String::as_str)
}

fn key_of(series: &PromSeries) -> (String, String, String, String) {
    (
        label(series, "group").to_string(),
        label(series, "version").to_string(),
        label(series, "resource").to_string(),
        label(series, "subresource").to_string(),
    )
}

/// Asks Prometheus, telling "nothing deprecated was asked for" from "the API
/// server is not scraped there".
///
/// # Errors
///
/// Why the count is not known.
pub async fn count(entry: &PrometheusEntry) -> Result<Counted, Why> {
    let failed = |error: crate::error::Error| Why::Failed {
        message: error.said(),
    };
    let (requested, scraped, today) = tokio::join!(
        instant(entry, REQUESTED),
        instant(entry, SCRAPED),
        instant(entry, TODAY)
    );
    let requested = requested.map_err(failed)?;
    if requested.is_empty() {
        let scraped = scraped.map_err(failed)?;
        let any = scraped
            .iter()
            .any(|series| series.points.iter().any(|p| p.v.is_some_and(|v| v > 0.0)));
        if !any {
            return Err(Why::NotScraped);
        }
    }
    let mut out: Vec<Requested> = requested
        .iter()
        .map(|series| {
            let (group, version, resource, subresource) = key_of(series);
            let removed = label(series, "removed_release");
            Requested {
                group,
                version,
                resource,
                subresource,
                removed: (!removed.is_empty()).then(|| removed.to_string()),
            }
        })
        .collect();
    out.sort();
    out.dedup();
    let today = today.ok().map(|series| {
        series
            .iter()
            .map(|s| {
                let n = s.points.last().and_then(|p| p.v).unwrap_or(0.0);
                #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                let n = n.max(0.0).round() as u64;
                (key_of(s), n)
            })
            .collect()
    });
    Ok(Counted {
        requested: out,
        today,
    })
}

/// The groups discovery is asked about to name each requested API's kind.
pub fn groups_of(counted: &Counted) -> impl Iterator<Item = String> + '_ {
    counted.requested.iter().map(|r| r.group.clone())
}

/// Each deprecated API the server counted, as a subject of its own, with the
/// kind and replacement where discovery and the guide name them.
#[must_use]
pub fn judge_requested(counted: &Counted, groups: &Groups) -> Vec<Audited> {
    counted
        .requested
        .iter()
        .map(|r| {
            let api = if r.group.is_empty() {
                r.version.clone()
            } else {
                format!("{}/{}", r.group, r.version)
            };
            let kind = match groups.get(&r.group) {
                Some(Group::Serves(kinds)) => kinds
                    .iter()
                    .find(|k| k.plural == r.resource)
                    .map(|k| k.kind.clone()),
                _ => None,
            };
            let replacement = kind
                .as_deref()
                .and_then(|kind| removal(&api, kind))
                .and_then(|gone| gone.replacement.clone());
            let mut what = vec![What::Requested {
                kind,
                removed: r.removed.clone(),
                replacement,
            }];
            let key = (
                r.group.clone(),
                r.version.clone(),
                r.resource.clone(),
                r.subresource.clone(),
            );
            // `increase` answers a series only once it has two samples in
            // the window: a key absent from the answer is a count nobody
            // knows, not none.
            if let Some(&requests) = counted.today.as_ref().and_then(|today| today.get(&key)) {
                what.push(What::RequestedToday { requests });
            }
            let resource = if r.subresource.is_empty() {
                r.resource.clone()
            } else {
                format!("{}/{}", r.resource, r.subresource)
            };
            Audited {
                subject: Subject {
                    kind: DEPRECATED_API.to_string(),
                    namespace: None,
                    name: format!("{api} {resource}"),
                },
                system: false,
                findings: vec![AuditFinding::of(RuleId::DeprecatedApiRequested, what)],
                unchecked: Vec::new(),
            }
        })
        .collect()
}

/// The count's blind line, where it could not be read.
#[must_use]
pub fn count_unread(why: Why) -> NotChecked {
    NotChecked {
        kind: METRIC.to_string(),
        namespace: None,
        why,
        rules: vec![RuleId::DeprecatedApiRequested],
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::client::served::test_server::{answering, answering_query, failure};
    use crate::client::served::ServedKind;

    fn crd(versions: &serde_json::Value, stored: &[&str], rv: &str) -> serde_json::Value {
        json!({
            "apiVersion": "apiextensions.k8s.io/v1", "kind": "CustomResourceDefinition",
            "metadata": { "name": "crontabs.example.com", "resourceVersion": rv },
            "spec": {
                "group": "example.com", "scope": "Namespaced",
                "names": { "plural": "crontabs", "singular": "crontab", "kind": "CronTab" },
                "versions": versions,
            },
            "status": { "storedVersions": stored },
        })
    }

    fn version(
        name: &str,
        served: bool,
        storage: bool,
        deprecated: Option<&str>,
    ) -> serde_json::Value {
        let mut v = json!({ "name": name, "served": served, "storage": storage });
        if let Some(warning) = deprecated {
            v["deprecated"] = json!(true);
            if !warning.is_empty() {
                v["deprecationWarning"] = json!(warning);
            }
        }
        v
    }

    fn facts(value: serde_json::Value) -> CrdFacts {
        crd_facts(&serde_json::from_value(value).expect("a CRD"))
    }

    /// A CRD's warning is its author's text and reaches the screen, so it
    /// passes the one door every string does. Fails if a key someone pasted
    /// into a `deprecationWarning` leaves this process.
    #[test]
    fn a_crd_warning_holding_a_private_key_is_withheld() {
        let label = ["PRIVATE", "KEY"].join(" ");
        let key = format!(
            "-----BEGIN {label}-----\nMIIBVgIBADANBgkqhkiG9w0BAQEFAASCAUAwggE8AgEAAkEA\n-----END {label}-----\n"
        );
        let pasted = facts(crd(
            &json!([
                version("v1alpha1", true, false, Some(&key)),
                version("v1", true, true, None)
            ]),
            &["v1"],
            "7",
        ));
        let finding = judge_crd(&pasted).expect("a finding");
        let said = serde_json::to_string(&finding.what).expect("json");
        assert!(!said.contains("MIIBVgIBADAN"), "{said}");
        assert!(matches!(
            &finding.what[0],
            What::Deprecated {
                warning: Some(_),
                ..
            }
        ));
    }

    /// A served version its CRD marks deprecated is named with the CRD's
    /// own warning; it is Medium where objects may still be stored at it,
    /// since the CRD cannot drop it until they are migrated, and Low where
    /// none can be. A deprecated version no longer served, and a CRD with
    /// none deprecated, are nothing. Would break if the warning were
    /// reworded or `status.storedVersions` were ignored.
    #[test]
    fn a_deprecated_crd_version_is_named_in_its_own_words_and_weighed_by_where_objects_are_stored()
    {
        let warning = "example.com/v1alpha1 CronTab is deprecated; use example.com/v1 CronTab";
        let held = facts(crd(
            &json!([
                version("v1alpha1", true, false, Some(warning)),
                version("v1beta1", true, false, Some("")),
                version("v0", false, false, Some("")),
                version("v1", true, true, None),
            ]),
            &["v1alpha1", "v1"],
            "7",
        ));
        let finding = judge_crd(&held).expect("a finding");
        assert_eq!(finding.rule, RuleId::CrdVersionDeprecated);
        assert_eq!(finding.severity, AuditSeverity::Medium);
        assert_eq!(
            finding.what,
            vec![
                What::Deprecated {
                    version: "v1alpha1".into(),
                    warning: Some(warning.into()),
                    stored: true,
                    storage: false,
                },
                What::Deprecated {
                    version: "v1beta1".into(),
                    warning: None,
                    stored: false,
                    storage: false,
                },
                What::StoredAs {
                    group: "example.com".into(),
                    kind: "CronTab".into(),
                    storage: Some("v1".into()),
                    stored: vec!["v1alpha1".into(), "v1".into()],
                    current: vec!["v1".into()],
                },
            ]
        );

        let migrated = facts(crd(
            &json!([
                version("v1beta1", true, false, Some("")),
                version("v1", true, true, None)
            ]),
            &["v1"],
            "8",
        ));
        assert_eq!(
            judge_crd(&migrated).expect("a finding").severity,
            AuditSeverity::Low
        );

        let current = facts(crd(&json!([version("v1", true, true, None)]), &["v1"], "9"));
        assert!(judge_crd(&current).is_none());
    }

    fn metadata_list(items: &[(&str, &str)]) -> String {
        let items: Vec<_> = items
            .iter()
            .map(|(name, rv)| json!({ "metadata": { "name": name, "resourceVersion": rv } }))
            .collect();
        json!({ "kind": "PartialObjectMetadataList", "apiVersion": "meta.k8s.io/v1",
                "metadata": {}, "items": items })
        .to_string()
    }

    const LIST: &str = "/apis/apiextensions.k8s.io/v1/customresourcedefinitions";
    const ONE: &str =
        "/apis/apiextensions.k8s.io/v1/customresourcedefinitions/crontabs.example.com";

    /// CRDs are fetched whole only where their `resourceVersion` moved since
    /// the last pass, since each carries its schema; a refused list is named
    /// as not checked rather than read as no CRDs. Would break if every pass
    /// fetched every CRD, or a 403 read as a clean cluster.
    #[tokio::test]
    async fn crds_are_fetched_only_where_they_changed_and_a_refused_list_is_named() {
        let deprecated = json!([
            version("v1beta1", true, false, Some("")),
            version("v1", true, true, None)
        ]);
        let (client, hits) = answering(move |path, nth| match path {
            LIST => (
                200,
                metadata_list(&[("crontabs.example.com", if nth < 3 { "7" } else { "8" })]),
            ),
            ONE => (
                200,
                crd(&deprecated, &["v1"], if nth < 2 { "7" } else { "8" }).to_string(),
            ),
            _ => failure(404, "NotFound"),
        })
        .await;
        let mut kept = KeptCrds::new();
        let mut fetched = 0;

        let mut first = Read::default();
        read_crds(&client, &mut kept, &mut fetched, &mut first).await;
        assert_eq!(first.objects.len(), 1);
        assert_eq!(first.objects[0].subject.name, "crontabs.example.com");
        assert_eq!(first.checked[CRD], 1);
        read_crds(&client, &mut kept, &mut fetched, &mut Read::default()).await;
        assert_eq!(fetched, 1, "an unchanged CRD is not fetched again");
        read_crds(&client, &mut kept, &mut fetched, &mut Read::default()).await;
        assert_eq!(fetched, 2);
        assert_eq!(hits.lock().unwrap()[ONE], 2);

        let (refusing, _) = answering(|_, _| failure(403, "Forbidden")).await;
        let mut refused = Read::default();
        read_crds(&refusing, &mut KeptCrds::new(), &mut 0, &mut refused).await;
        assert!(refused.objects.is_empty());
        assert_eq!(refused.not_checked.len(), 1);
        assert_eq!(refused.not_checked[0].kind, CRD);
        assert!(matches!(refused.not_checked[0].why, Why::Refused { .. }));
    }

    fn vector(series: &[(serde_json::Value, f64)]) -> String {
        let result: Vec<_> = series
            .iter()
            .map(|(metric, v)| json!({ "metric": metric, "value": [1_763_000_000.0, v.to_string()] }))
            .collect();
        json!({ "status": "success", "data": { "resultType": "vector", "result": result } })
            .to_string()
    }

    fn query_of(raw: &str) -> String {
        url::form_urlencoded::parse(raw.as_bytes())
            .find(|(key, _)| key == "query")
            .map(|(_, value)| value.into_owned())
            .unwrap_or_default()
    }

    fn entry(url: String) -> PrometheusEntry {
        PrometheusEntry {
            url,
            auth_type: "none".into(),
            token: None,
            insecure_tls: false,
        }
    }

    /// A Prometheus that answers each of the three queries as given.
    async fn prometheus(
        requested: (u16, String),
        scraped: (u16, String),
        today: (u16, String),
    ) -> PrometheusEntry {
        let (url, _) = answering_query(move |_, raw| {
            let query = query_of(raw);
            if query == REQUESTED {
                requested.clone()
            } else if query == SCRAPED {
                scraped.clone()
            } else if query == TODAY {
                today.clone()
            } else {
                (
                    400,
                    json!({ "status": "error", "error": "unexpected query" }).to_string(),
                )
            }
        })
        .await;
        entry(url)
    }

    fn ingress_series() -> serde_json::Value {
        json!({ "group": "extensions", "version": "v1beta1", "resource": "ingresses",
                "subresource": "", "removed_release": "1.22" })
    }

    /// The server's own count is read as it labels it; "nothing deprecated
    /// was asked for" needs the API server's metrics to be there at all, and
    /// a refused query keeps Prometheus's words. Would break if a Prometheus
    /// that does not scrape the API server read as a clean cluster.
    #[tokio::test]
    async fn the_servers_count_tells_none_requested_from_not_scraped_and_from_failed() {
        let today_series = json!({ "group": "extensions", "version": "v1beta1",
                                    "resource": "ingresses", "subresource": "" });
        let found = count(
            &prometheus(
                (200, vector(&[(ingress_series(), 1.0)])),
                (200, vector(&[(json!({}), 5120.0)])),
                (200, vector(&[(today_series, 14.0)])),
            )
            .await,
        )
        .await
        .expect("counted");
        assert_eq!(
            found.requested,
            vec![Requested {
                group: "extensions".into(),
                version: "v1beta1".into(),
                resource: "ingresses".into(),
                subresource: String::new(),
                removed: Some("1.22".into()),
            }]
        );
        let key = (
            "extensions".into(),
            "v1beta1".into(),
            "ingresses".into(),
            String::new(),
        );
        assert_eq!(found.today.as_ref().and_then(|t| t.get(&key)), Some(&14));

        let none = count(
            &prometheus(
                (200, vector(&[])),
                (200, vector(&[(json!({}), 5120.0)])),
                (200, vector(&[])),
            )
            .await,
        )
        .await
        .expect("counted");
        assert!(none.requested.is_empty());

        let unscraped =
            count(&prometheus((200, vector(&[])), (200, vector(&[])), (200, vector(&[]))).await)
                .await;
        assert_eq!(unscraped, Err(Why::NotScraped));

        let refused = (
            400,
            json!({ "status": "error", "errorType": "bad_data", "error": "parse error at char 7" })
                .to_string(),
        );
        let failed = count(&prometheus(refused.clone(), refused.clone(), refused).await).await;
        assert!(
            matches!(failed, Err(Why::Failed { ref message }) if message.contains("parse error"))
        );
    }

    /// Each API the server counted is a subject of its own, named with its
    /// kind and replacement where discovery and the guide say them, with its
    /// requests in the last day where those were counted, and none where
    /// they were not. Would break if a count that did not answer read as
    /// zero requests.
    #[test]
    fn each_requested_api_is_named_with_its_kind_its_replacement_and_its_count() {
        let groups: Groups = [(
            "extensions".to_string(),
            Group::Serves(vec![ServedKind {
                kind: "Ingress".into(),
                plural: "ingresses".into(),
                versions: vec!["v1beta1".into()],
                namespaced: true,
            }]),
        )]
        .into_iter()
        .collect();
        let status = Requested {
            group: "example.com".into(),
            version: "v1beta1".into(),
            resource: "widgets".into(),
            subresource: "status".into(),
            removed: None,
        };
        let ingress = Requested {
            group: "extensions".into(),
            version: "v1beta1".into(),
            resource: "ingresses".into(),
            subresource: String::new(),
            removed: Some("1.22".into()),
        };
        let counted = Counted {
            requested: vec![ingress.clone(), status],
            today: Some(HashMap::from([(
                (
                    "extensions".into(),
                    "v1beta1".into(),
                    "ingresses".into(),
                    String::new(),
                ),
                14,
            )])),
        };

        let judged = judge_requested(&counted, &groups);

        assert_eq!(judged[0].subject.name, "extensions/v1beta1 ingresses");
        assert_eq!(judged[0].subject.kind, DEPRECATED_API);
        assert_eq!(
            judged[0].findings[0].what,
            vec![
                What::Requested {
                    kind: Some("Ingress".into()),
                    removed: Some("1.22".into()),
                    replacement: Some("networking.k8s.io/v1".into()),
                },
                What::RequestedToday { requests: 14 },
            ]
        );
        assert_eq!(judged[1].subject.name, "example.com/v1beta1 widgets/status");
        assert_eq!(
            judged[1].findings[0].what,
            vec![What::Requested {
                kind: None,
                removed: None,
                replacement: None
            },]
        );

        let uncounted = Counted {
            requested: vec![ingress],
            today: None,
        };
        let judged = judge_requested(&uncounted, &groups);
        assert_eq!(judged[0].findings[0].what.len(), 1);
    }
}
