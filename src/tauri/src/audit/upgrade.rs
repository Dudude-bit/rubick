//! Upgrade: what names an API version this cluster no longer serves, or one
//! a later Kubernetes removes. When a version goes, and what replaces it, is
//! the Deprecated API Migration Guide's table, held in
//! `src/contracts/removed-apis.json`; whether this cluster serves a version
//! is its discovery's answer.
//!
//! Two readings: each Helm release at the revision `helm upgrade` diffs
//! against, whose stored manifest is rebuilt before any upgrade; and the
//! `managedFields` of objects whose deprecated versions are still served,
//! which name the version each writer last wrote through.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Arc, LazyLock};

use futures::StreamExt;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::ManagedFieldsEntry;
use kube::api::{Api, DynamicObject, ListParams};
use kube::discovery::ApiResource;
use kube::Client;
use serde::{Deserialize, Serialize};

use super::answer::{in_scope, Audited, NotChecked, World};
use super::{is_system, AuditFinding, AuditSeverity, RuleId, Subject, Unchecked, What, Why};
use crate::client::served::{ServedIndex, ServedKind};
use crate::commands::helm::{release_objects, upgraded_from_in, ReleaseObject, ReleaseRevision};
use crate::error::Error;

/// A Helm release as a subject: no Kubernetes kind holds a dot.
pub const HELM_RELEASE: &str = "HelmRelease.helm.sh";

/// The Secret a release is stored in, named where its read went wrong.
const RELEASE_STORE: &str = "Secret";

/// Events turn over by the thousand and nobody plans an upgrade around one.
const UNREAD_WRITERS: &str = "Event";

const PAGE: u32 = 500;

/// When Kubernetes stops serving a version, and what replaces it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Removal {
    /// `1.22`.
    pub removed: String,
    /// `None` where nothing replaces it: `PodSecurityPolicy`.
    pub replacement: Option<String>,
    /// The release the replacement is served from, where the guide says.
    pub since: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Row {
    api_version: String,
    kinds: Vec<String>,
    removed_in: String,
    replacement: Option<String>,
    since: Option<String>,
}

#[derive(Deserialize)]
struct Table {
    removed: Vec<Row>,
}

/// The guide's table, by `(apiVersion, kind)`.
static REMOVED: LazyLock<BTreeMap<(String, String), Removal>> = LazyLock::new(|| {
    let table: Table =
        serde_json::from_str(include_str!("../../../contracts/removed-apis.json")).expect("table");
    let mut by = BTreeMap::new();
    for row in table.removed {
        for kind in row.kinds {
            let removal = Removal {
                removed: row.removed_in.clone(),
                replacement: row.replacement.clone(),
                since: row.since.clone(),
            };
            by.insert((row.api_version.clone(), kind), removal);
        }
    }
    by
});

/// When Kubernetes removes `api` for `kind`, where the guide lists it.
#[must_use]
pub fn removal(api: &str, kind: &str) -> Option<&'static Removal> {
    REMOVED.get(&(api.to_string(), kind.to_string()))
}

/// Whether the guide lists any version of `kind`.
#[must_use]
pub fn listed(kind: &str) -> bool {
    REMOVED.keys().any(|(_, listed)| listed == kind)
}

fn minor(version: &str) -> Option<u32> {
    version.split('.').nth(1)?.parse().ok()
}

fn group_of(api: &str) -> &str {
    api.split_once('/').map_or("", |(group, _)| group)
}

fn version_of(api: &str) -> &str {
    api.split_once('/').map_or(api, |(_, version)| version)
}

/// What discovery said of one group.
#[derive(Debug, Clone)]
pub enum Group {
    Serves(Vec<ServedKind>),
    Absent,
    Failed(Why),
}

pub type Groups = HashMap<String, Group>;

/// The version a removal already took on this cluster: certain without
/// discovery, since a removed version's code is gone from the server.
fn gone_by_version(api: &str, kind: &str, now: Option<u32>) -> bool {
    let removed = removal(api, kind).and_then(|r| minor(&r.removed));
    matches!((removed, now), (Some(removed), Some(now)) if now >= removed)
}

/// The group discovery is asked about to tell whether `kind` at `api` is
/// served, or none where the cluster's version already tells.
fn needs_group<'a>(api: &'a str, kind: &str, now: Option<u32>) -> Option<&'a str> {
    (!gone_by_version(api, kind, now)).then(|| group_of(api))
}

/// Whether this cluster serves `kind` at `api`: discovery's answer, or,
/// where discovery failed, the guide's for a version it lists against the
/// cluster's minor version. `Err` where neither can tell.
///
/// # Errors
///
/// Nothing could tell: the reason discovery was not read.
pub fn served(groups: &Groups, api: &str, kind: &str, now: Option<u32>) -> Result<bool, Why> {
    if gone_by_version(api, kind, now) {
        return Ok(false);
    }
    match groups.get(group_of(api)) {
        Some(Group::Serves(kinds)) => {
            let version = version_of(api);
            Ok(kinds
                .iter()
                .any(|k| k.kind == kind && k.versions.iter().any(|v| v == version)))
        }
        Some(Group::Absent) => Ok(false),
        Some(Group::Failed(why)) => match removal(api, kind) {
            Some(_) if now.is_some() => Ok(true),
            _ => Err(why.clone()),
        },
        None => Err(Why::Reading),
    }
}

/// A release's finding at the revision an upgrade builds from, and the
/// kinds in it nothing could tell were served.
#[must_use]
pub fn judge_release(
    revision: &ReleaseRevision,
    objects: &[ReleaseObject],
    groups: &Groups,
    now: Option<u32>,
) -> (Option<AuditFinding>, Vec<Unchecked>) {
    let mut what = Vec::new();
    let mut unchecked: Vec<Unchecked> = Vec::new();
    let mut gone = false;
    for object in objects {
        let stored = |served: bool| What::Stored {
            kind: object.kind.clone(),
            name: object.name.clone(),
            api: object.api.clone(),
            served,
            removal: removal(&object.api, &object.kind).cloned(),
        };
        match served(groups, &object.api, &object.kind, now) {
            Ok(true) if removal(&object.api, &object.kind).is_some() => what.push(stored(true)),
            Ok(true) => {}
            Ok(false) => {
                gone = true;
                what.push(stored(false));
            }
            Err(why) => {
                if !unchecked.iter().any(|u| u.kind == object.kind) {
                    unchecked.push(Unchecked {
                        rule: RuleId::RemovedApiInHelmRelease,
                        kind: object.kind.clone(),
                        namespace: Some(revision.namespace.clone()),
                        why,
                    });
                }
            }
        }
    }
    if what.is_empty() {
        return (None, unchecked);
    }
    what.insert(
        0,
        What::Revision {
            revision: revision.revision,
            status: revision.status.clone(),
        },
    );
    let mut finding = AuditFinding::of(RuleId::RemovedApiInHelmRelease, what);
    if !gone {
        finding.severity = AuditSeverity::Medium;
    }
    (Some(finding), unchecked)
}

/// The versions of `kind` the guide lists that this cluster still serves,
/// each with its removal.
///
/// # Errors
///
/// Discovery of a group one of them is in could not be read.
pub fn pending(
    kind: &str,
    groups: &Groups,
    now: Option<u32>,
) -> Result<Vec<(String, Removal)>, Why> {
    let mut found = Vec::new();
    for ((api, listed), removal) in REMOVED.iter() {
        if listed == kind && served(groups, api, kind, now)? {
            found.push((api.clone(), removal.clone()));
        }
    }
    Ok(found)
}

/// The groups discovery is asked about for `kind`'s pending versions.
fn pending_groups(kind: &str, now: Option<u32>) -> BTreeSet<String> {
    REMOVED
        .keys()
        .filter(|(_, listed)| listed == kind)
        .filter_map(|(api, listed)| needs_group(api, listed, now).map(str::to_string))
        .collect()
}

/// What an object's `managedFields` say was last written through one of
/// `pending`.
#[must_use]
pub fn judge_written(
    fields: &[ManagedFieldsEntry],
    pending: &[(String, Removal)],
) -> Option<AuditFinding> {
    let what: Vec<What> = fields
        .iter()
        .filter_map(|entry| {
            let api = entry.api_version.as_deref()?;
            let (_, removal) = pending.iter().find(|(held, _)| held == api)?;
            Some(What::Written {
                manager: entry.manager.clone().unwrap_or_default(),
                operation: entry.operation.clone().unwrap_or_default(),
                time: entry.time.as_ref().map(|time| time.0.to_string()),
                api: api.to_string(),
                removal: removal.clone(),
            })
        })
        .collect();
    (!what.is_empty()).then(|| AuditFinding::of(RuleId::DeprecatedApiWriter, what))
}

/// Discovery for `groups`, each read once through the shared index.
async fn discover(
    served: &ServedIndex,
    context: &str,
    client: &Client,
    groups: BTreeSet<String>,
) -> Groups {
    let reads = groups.into_iter().map(|group| async move {
        let found = match served.kinds(context, client, &group).await {
            Ok(Some(kinds)) => Group::Serves(kinds),
            Ok(None) => Group::Absent,
            Err(error) => Group::Failed(super::why_of(&error)),
        };
        (group, found)
    });
    futures::future::join_all(reads).await.into_iter().collect()
}

/// One object's writers judged for its own page: the same reading as the
/// Audit page's, from the `managedFields` the page's read already holds.
pub async fn written_of(
    here: &crate::state::Here<'_>,
    now: Option<u32>,
    subject: &Subject,
    fields: &[ManagedFieldsEntry],
) -> (Option<AuditFinding>, Option<Unchecked>) {
    let groups = pending_groups(&subject.kind, now);
    if groups.is_empty() {
        return (None, None);
    }
    let mut read = Groups::new();
    for group in groups {
        let found = match here.served_kinds(&group).await {
            Ok(Some(kinds)) => Group::Serves(kinds),
            Ok(None) => Group::Absent,
            Err(error) => Group::Failed(super::why_of(&error)),
        };
        read.insert(group, found);
    }
    match pending(&subject.kind, &read, now) {
        Ok(pending) => (judge_written(fields, &pending), None),
        Err(why) => (
            None,
            Some(Unchecked {
                rule: RuleId::DeprecatedApiWriter,
                kind: subject.kind.clone(),
                namespace: subject.namespace.clone(),
                why,
            }),
        ),
    }
}

/// What one pass read, and for which scope.
#[derive(Debug, Clone, Default)]
pub struct Read {
    pub scope: Option<Vec<String>>,
    /// When the pass ended, as the cluster's timestamps are written.
    pub at: String,
    pub objects: Vec<Audited>,
    pub checked: BTreeMap<String, u32>,
    pub not_checked: Vec<NotChecked>,
}

/// A release decoded, kept while its Secret's `resourceVersion` holds.
type Kept = (String, Arc<Result<Vec<ReleaseObject>, Why>>);

/// Releases decoded, by namespace and Secret.
#[derive(Default)]
pub struct Decoded {
    held: HashMap<(String, String), Kept>,
    /// Release Secrets fetched whole, ever: what a pass costs.
    pub fetched: u64,
}

fn reaches(scope: Option<&[String]>, namespaced: bool) -> Vec<Option<String>> {
    match scope {
        None => vec![None],
        Some(names) if namespaced => names.iter().cloned().map(Some).collect(),
        // A selection of namespaces holds no cluster-wide object.
        Some(_) => Vec::new(),
    }
}

/// Every release in the scope at the revision an upgrade builds from, each
/// Secret fetched only where it changed since the last pass.
async fn releases(
    client: &Client,
    scope: Option<&[String]>,
    decoded: &mut Decoded,
    read: &mut Read,
) -> Vec<(ReleaseRevision, Arc<Result<Vec<ReleaseObject>, Why>>)> {
    let mut revisions = Vec::new();
    let listed = futures::stream::iter(reaches(scope, true))
        .map(|reach| async move { (upgraded_from_in(client, reach.as_deref()).await, reach) })
        .buffered(6)
        .collect::<Vec<_>>()
        .await;
    for (found, reach) in listed {
        match found {
            Ok(found) => revisions.extend(found),
            Err(error) => read.not_checked.push(NotChecked {
                kind: RELEASE_STORE.to_string(),
                namespace: reach,
                why: super::why_of(&error),
                rules: vec![RuleId::RemovedApiInHelmRelease],
            }),
        }
    }
    let stale: Vec<ReleaseRevision> = revisions
        .iter()
        .filter(|r| {
            decoded
                .held
                .get(&(r.namespace.clone(), r.secret.clone()))
                .is_none_or(|(version, _)| *version != r.version)
        })
        .cloned()
        .collect();
    let fetched = futures::stream::iter(stale)
        .map(|revision| async move {
            let got = release_objects(client, &revision.namespace, &revision.secret).await;
            (revision, got)
        })
        .buffer_unordered(6)
        .collect::<Vec<_>>()
        .await;
    for (revision, got) in fetched {
        decoded.fetched += 1;
        let objects = match got {
            Ok(None) => continue,
            Ok(Some(Ok(objects))) => Ok(objects),
            Ok(Some(Err(words))) => Err(Why::Failed { message: words }),
            Err(error) => Err(super::why_of(&error)),
        };
        decoded.held.insert(
            (revision.namespace.clone(), revision.secret.clone()),
            (revision.version.clone(), Arc::new(objects)),
        );
    }
    let live: BTreeSet<(String, String)> = revisions
        .iter()
        .map(|r| (r.namespace.clone(), r.secret.clone()))
        .collect();
    decoded.held.retain(|key, _| live.contains(key));
    revisions
        .into_iter()
        .filter_map(|revision| {
            let key = (revision.namespace.clone(), revision.secret.clone());
            let objects = decoded.held.get(&key)?.1.clone();
            Some((revision, objects))
        })
        .collect()
}

/// Every object of one kind in `reach`, a page at a time, each page judged
/// and let go.
async fn writers_of(
    api: &Api<DynamicObject>,
    pending: &[(String, Removal)],
    kind: &str,
    read: &mut Read,
) -> kube::Result<u32> {
    let mut params = ListParams::default().limit(PAGE);
    let mut seen = 0;
    loop {
        let page = api.list_metadata(&params).await?;
        for object in page.items {
            seen += 1;
            let fields = object
                .metadata
                .managed_fields
                .as_deref()
                .unwrap_or_default();
            let Some(finding) = judge_written(fields, pending) else {
                continue;
            };
            let subject = Subject {
                kind: kind.to_string(),
                namespace: object.metadata.namespace.clone(),
                name: object.metadata.name.clone().unwrap_or_default(),
            };
            read.objects.push(Audited {
                system: is_system(&subject, object.metadata.labels.as_ref()),
                subject,
                findings: vec![finding],
                unchecked: Vec::new(),
            });
        }
        match page.metadata.continue_ {
            Some(token) if !token.is_empty() => params = params.continue_token(&token),
            _ => return Ok(seen),
        }
    }
}

/// One pass over the scope: the releases, then the writers of every kind
/// whose deprecated versions this cluster still serves.
pub async fn read(
    client: &Client,
    served: &ServedIndex,
    context: &str,
    scope: Option<&[String]>,
    now: Option<u32>,
    decoded: &mut Decoded,
) -> Read {
    let mut read = Read {
        scope: scope.map(<[String]>::to_vec),
        ..Read::default()
    };
    let releases = releases(client, scope, decoded, &mut read).await;

    let mut groups: BTreeSet<String> = BTreeSet::new();
    for (_, objects) in &releases {
        for object in objects.iter().flatten() {
            groups.extend(needs_group(&object.api, &object.kind, now).map(str::to_string));
        }
    }
    let kinds: BTreeSet<&str> = REMOVED.keys().map(|(_, kind)| kind.as_str()).collect();
    for kind in &kinds {
        groups.extend(pending_groups(kind, now));
    }
    let groups = discover(served, context, client, groups).await;

    for (revision, objects) in &releases {
        let subject = Subject {
            kind: HELM_RELEASE.to_string(),
            namespace: Some(revision.namespace.clone()),
            name: revision.release.clone(),
        };
        let (findings, unchecked) = match objects.as_ref() {
            Ok(objects) => {
                *read.checked.entry(HELM_RELEASE.to_string()).or_default() += 1;
                let (finding, unchecked) = judge_release(revision, objects, &groups, now);
                (finding.into_iter().collect(), unchecked)
            }
            Err(why) => (
                Vec::new(),
                vec![Unchecked {
                    rule: RuleId::RemovedApiInHelmRelease,
                    kind: RELEASE_STORE.to_string(),
                    namespace: Some(revision.namespace.clone()),
                    why: why.clone(),
                }],
            ),
        };
        read.objects.push(Audited {
            system: is_system(&subject, None),
            subject,
            findings,
            unchecked,
        });
    }

    for kind in kinds {
        let blind = |why: Why| NotChecked {
            kind: kind.to_string(),
            namespace: None,
            why,
            rules: vec![RuleId::DeprecatedApiWriter],
        };
        let pending = match pending(kind, &groups, now) {
            Ok(pending) if pending.is_empty() => continue,
            Ok(pending) => pending,
            Err(why) => {
                read.not_checked.push(blind(why));
                continue;
            }
        };
        if kind == UNREAD_WRITERS {
            read.not_checked.push(blind(Why::NotAudited));
            continue;
        }
        let Some((resource, namespaced)) =
            served_resource(served, context, client, kind, &pending).await
        else {
            continue;
        };
        for reach in reaches(scope, namespaced) {
            let api: Api<DynamicObject> = match &reach {
                Some(namespace) => Api::namespaced_with(client.clone(), namespace, &resource),
                None => Api::all_with(client.clone(), &resource),
            };
            match writers_of(&api, &pending, kind, &mut read).await {
                Ok(seen) => *read.checked.entry(kind.to_string()).or_default() += seen,
                Err(error) => read.not_checked.push(NotChecked {
                    namespace: reach,
                    ..blind(super::why_of(&Error::from(error)))
                }),
            }
        }
    }
    read.at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    read
}

/// Where `kind` is listed from, at the version kubectl would use, and
/// whether it lives in a namespace; `None` for a kind that cannot be listed,
/// such as a review nobody stores.
async fn served_resource(
    served: &ServedIndex,
    context: &str,
    client: &Client,
    kind: &str,
    pending: &[(String, Removal)],
) -> Option<(ApiResource, bool)> {
    let group = group_of(&pending.first()?.0);
    let found = served.recommended(context, client, group).await.ok()??;
    let (resource, caps) = found
        .into_iter()
        .find(|(resource, _)| resource.kind == kind)?;
    caps.supports_operation(kube::discovery::verbs::LIST)
        .then_some((resource, caps.scope == kube::discovery::Scope::Namespaced))
}

/// Whether a pass read for `held` answers for `scope`.
fn covers(held: Option<&[String]>, scope: Option<&[String]>) -> bool {
    match (held, scope) {
        (None, _) => true,
        (Some(_), None) => false,
        (Some(held), Some(scope)) => scope.iter().all(|name| held.contains(name)),
    }
}

/// Puts a pass into `world`: its objects merged into those the world
/// already judges, and the writers' rule said unanswered on every object of
/// a listed kind where the pass did not read it.
pub fn merge(world: &mut World, read: Option<&Read>, scope: Option<&[String]>) {
    let read = read.filter(|read| covers(read.scope.as_deref(), scope));
    for object in &mut world.objects {
        if !listed(&object.subject.kind) {
            continue;
        }
        let why = match read {
            None => Some(Why::Reading),
            Some(read) => read
                .not_checked
                .iter()
                .find(|each| {
                    each.kind == object.subject.kind
                        && each.rules.contains(&RuleId::DeprecatedApiWriter)
                        && (each.namespace.is_none() || each.namespace == object.subject.namespace)
                })
                .map(|each| each.why.clone()),
        };
        if let Some(why) = why {
            object.unchecked.push(Unchecked {
                rule: RuleId::DeprecatedApiWriter,
                kind: object.subject.kind.clone(),
                namespace: object.subject.namespace.clone(),
                why,
            });
        }
    }
    let Some(read) = read else {
        world.upgrade_read = None;
        return;
    };
    world.upgrade_read = Some(read.at.clone());
    for found in &read.objects {
        if !in_scope(found.subject.namespace.as_deref(), scope) {
            continue;
        }
        match world
            .objects
            .iter_mut()
            .find(|o| o.subject == found.subject)
        {
            Some(object) => {
                object.findings.extend(found.findings.iter().cloned());
                object.unchecked.extend(found.unchecked.iter().cloned());
            }
            None => world.objects.push(found.clone()),
        }
    }
    for (kind, objects) in &read.checked {
        let counted = world.checked.entry(kind.clone()).or_default();
        *counted = (*counted).max(*objects);
    }
    world.not_checked.extend(
        read.not_checked
            .iter()
            .filter(|each| each.namespace.is_none() || in_scope(each.namespace.as_deref(), scope))
            .cloned(),
    );
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use serde_json::json;

    use super::*;
    use crate::audit::answer::{page, AuditQuery, AuditRow};
    use crate::client::served::test_server::{answering, failure};
    use crate::state::perf::{wire_len, IPC_TARGET_BYTES};

    fn serves(list: &[(&str, &[&str])]) -> Group {
        Group::Serves(
            list.iter()
                .map(|(kind, versions)| ServedKind {
                    kind: (*kind).to_string(),
                    plural: format!("{}s", kind.to_lowercase()),
                    versions: versions.iter().map(ToString::to_string).collect(),
                    namespaced: true,
                })
                .collect(),
        )
    }

    fn groups(list: Vec<(&str, Group)>) -> Groups {
        list.into_iter()
            .map(|(group, found)| (group.to_string(), found))
            .collect()
    }

    fn web() -> ReleaseRevision {
        ReleaseRevision {
            namespace: "shop".to_string(),
            release: "web".to_string(),
            secret: "sh.helm.release.v1.web.v2".to_string(),
            version: "20".to_string(),
            revision: 2,
            status: "deployed".to_string(),
        }
    }

    fn object(api: &str, kind: &str) -> ReleaseObject {
        ReleaseObject {
            api: api.to_string(),
            kind: kind.to_string(),
            name: "web".to_string(),
        }
    }

    fn stored(finding: &AuditFinding) -> Vec<(String, bool, Option<String>)> {
        finding
            .what
            .iter()
            .filter_map(|what| match what {
                What::Stored {
                    api,
                    served,
                    removal,
                    ..
                } => Some((
                    api.clone(),
                    *served,
                    removal.as_ref().map(|r| r.removed.clone()),
                )),
                _ => None,
            })
            .collect()
    }

    /// The table is the guide's: every version and kind listed once, every
    /// release a version, every replacement a version removed later than
    /// what it replaces, and the rows a reader checks against the page.
    /// Would break if a row were mistyped or a kind listed twice, which the
    /// map would swallow.
    #[test]
    fn the_removal_table_is_the_guides_and_every_row_reads() {
        let table: Table =
            serde_json::from_str(include_str!("../../../contracts/removed-apis.json")).unwrap();
        let rows: usize = table.removed.iter().map(|row| row.kinds.len()).sum();
        assert_eq!(rows, REMOVED.len(), "a version and kind is listed twice");
        for ((api, kind), gone) in REMOVED.iter() {
            assert!(api.contains('/'), "{api}");
            let removed = minor(&gone.removed).expect("a release");
            if let Some(since) = &gone.since {
                assert!(minor(since).is_some(), "{api} {kind}");
            }
            if let Some(replacement) = &gone.replacement {
                let later = removal(replacement, kind).and_then(|r| minor(&r.removed));
                assert!(later.is_none_or(|later| later > removed), "{api} {kind}");
            }
        }
        let ingress = removal("extensions/v1beta1", "Ingress").unwrap();
        assert_eq!(ingress.removed, "1.22");
        assert_eq!(ingress.replacement.as_deref(), Some("networking.k8s.io/v1"));
        assert_eq!(
            removal("apps/v1beta2", "Deployment").unwrap().removed,
            "1.16"
        );
        assert_eq!(
            removal("policy/v1beta1", "PodSecurityPolicy")
                .unwrap()
                .replacement,
            None
        );
        assert_eq!(
            removal("flowcontrol.apiserver.k8s.io/v1beta3", "FlowSchema")
                .unwrap()
                .removed,
            "1.32"
        );
        assert!(removal("apps/v1", "Deployment").is_none());
    }

    /// A version the cluster's own release has already removed fails the
    /// next `helm upgrade`, and is known with no discovery read: High. A
    /// version discovery still serves that a later release removes is
    /// Medium. A version the guide does not list and discovery serves is
    /// nothing. Would break if a stored version were judged by the guide
    /// alone or by discovery alone.
    #[test]
    fn a_stored_version_the_cluster_no_longer_serves_is_high_and_one_due_to_go_is_medium() {
        let none = Groups::new();
        let (gone, blind) = judge_release(
            &web(),
            &[object("extensions/v1beta1", "Ingress")],
            &none,
            Some(31),
        );
        let gone = gone.expect("a finding");
        assert!(blind.is_empty());
        assert_eq!(gone.severity, AuditSeverity::High);
        assert!(matches!(
            gone.what[0],
            What::Revision { revision: 2, ref status } if status == "deployed"
        ));
        assert_eq!(
            stored(&gone),
            vec![(
                "extensions/v1beta1".to_string(),
                false,
                Some("1.22".to_string())
            )]
        );

        let flow = groups(vec![(
            "flowcontrol.apiserver.k8s.io",
            serves(&[("FlowSchema", &["v1", "v1beta3"])]),
        )]);
        let (due, _) = judge_release(
            &web(),
            &[object("flowcontrol.apiserver.k8s.io/v1beta3", "FlowSchema")],
            &flow,
            Some(31),
        );
        let due = due.expect("a finding");
        assert_eq!(due.severity, AuditSeverity::Medium);
        assert_eq!(
            stored(&due),
            vec![(
                "flowcontrol.apiserver.k8s.io/v1beta3".to_string(),
                true,
                Some("1.32".to_string())
            )]
        );

        let apps = groups(vec![("apps", serves(&[("Deployment", &["v1"])]))]);
        let (fine, blind) =
            judge_release(&web(), &[object("apps/v1", "Deployment")], &apps, Some(31));
        assert!(fine.is_none() && blind.is_empty());
    }

    /// A version the guide does not list is discovery's to judge: a custom
    /// resource whose CRD no longer serves it fails the upgrade as surely.
    /// Where discovery was not read and the guide cannot decide, the release
    /// says not checked for that kind instead of passing it. Would break if
    /// a failed discovery read as served, or as not served.
    #[test]
    fn an_unlisted_version_is_discoverys_to_judge_and_unread_discovery_is_not_a_pass() {
        let refused = Why::Refused {
            message: "forbidden".to_string(),
        };
        let found = groups(vec![
            ("cert-manager.io", serves(&[("Certificate", &["v1"])])),
            ("gone.example.com", Group::Absent),
            ("locked.example.com", Group::Failed(refused.clone())),
            (
                "flowcontrol.apiserver.k8s.io",
                Group::Failed(refused.clone()),
            ),
        ]);
        let objects = [
            object("cert-manager.io/v1alpha2", "Certificate"),
            object("gone.example.com/v1", "Widget"),
            object("locked.example.com/v1", "Gadget"),
            object("flowcontrol.apiserver.k8s.io/v1beta3", "FlowSchema"),
        ];

        let (finding, blind) = judge_release(&web(), &objects, &found, Some(31));

        let finding = finding.expect("a finding");
        assert_eq!(finding.severity, AuditSeverity::High);
        assert_eq!(
            stored(&finding),
            vec![
                ("cert-manager.io/v1alpha2".to_string(), false, None),
                ("gone.example.com/v1".to_string(), false, None),
                (
                    "flowcontrol.apiserver.k8s.io/v1beta3".to_string(),
                    true,
                    Some("1.32".to_string())
                ),
            ]
        );
        assert_eq!(blind.len(), 1);
        assert_eq!(blind[0].kind, "Gadget");
        assert_eq!(blind[0].why, refused);

        let (unknown, blind) = judge_release(
            &web(),
            &[object("flowcontrol.apiserver.k8s.io/v1beta3", "FlowSchema")],
            &found,
            None,
        );
        assert!(unknown.is_none());
        assert_eq!(blind[0].kind, "FlowSchema");
    }

    fn entry(manager: &str, api: &str) -> ManagedFieldsEntry {
        serde_json::from_value(json!({
            "manager": manager, "operation": "Update", "apiVersion": api,
            "time": "2026-11-01T10:00:00Z",
        }))
        .unwrap()
    }

    /// A writer is named only for a version this cluster still serves and a
    /// later release removes; an entry from a version already gone is
    /// history, and the current version is nothing. Where discovery was not
    /// read and the cluster's version is unknown, the kind cannot be judged.
    /// Would break if every entry naming a listed version were a finding.
    #[test]
    fn a_writer_is_named_for_a_version_still_served_and_due_to_go() {
        let found = groups(vec![(
            "autoscaling",
            serves(&[("HorizontalPodAutoscaler", &["v2", "v2beta2"])]),
        )]);
        let due = pending("HorizontalPodAutoscaler", &found, Some(25)).unwrap();
        assert_eq!(
            due.iter().map(|(api, _)| api.as_str()).collect::<Vec<_>>(),
            vec!["autoscaling/v2beta2"]
        );

        let fields = [
            entry("kubectl-client-side-apply", "autoscaling/v2beta2"),
            entry("old-deployer", "autoscaling/v2beta1"),
            entry("kube-controller-manager", "autoscaling/v2"),
        ];
        let finding = judge_written(&fields, &due).expect("a finding");
        assert_eq!(finding.rule, RuleId::DeprecatedApiWriter);
        assert_eq!(finding.severity, AuditSeverity::Medium);
        assert_eq!(finding.what.len(), 1);
        assert!(matches!(
            &finding.what[0],
            What::Written { manager, api, removal, time, .. }
                if manager == "kubectl-client-side-apply"
                    && api == "autoscaling/v2beta2"
                    && removal.removed == "1.26"
                    && time.as_deref() == Some("2026-11-01T10:00:00Z")
        ));

        let unread = groups(vec![(
            "autoscaling",
            Group::Failed(Why::Failed {
                message: "timeout".to_string(),
            }),
        )]);
        assert!(pending("HorizontalPodAutoscaler", &unread, None).is_err());
        assert!(pending("HorizontalPodAutoscaler", &Groups::new(), Some(33))
            .unwrap()
            .is_empty());
    }

    fn audited(kind: &str, namespace: &str, name: &str) -> Audited {
        Audited {
            subject: Subject {
                kind: kind.to_string(),
                namespace: Some(namespace.to_string()),
                name: name.to_string(),
            },
            system: false,
            findings: Vec::new(),
            unchecked: Vec::new(),
        }
    }

    fn writers_unchecked(world: &World, kind: &str) -> Vec<Why> {
        world
            .objects
            .iter()
            .filter(|o| o.subject.kind == kind)
            .flat_map(|o| &o.unchecked)
            .filter(|u| u.rule == RuleId::DeprecatedApiWriter)
            .map(|u| u.why.clone())
            .collect()
    }

    /// Before a pass over the scope ends, every object of a kind the guide
    /// lists says its writers were not checked, and the summary says the
    /// upgrade rules are still reading; a pass over fewer namespaces than
    /// asked answers for none of them. Would break if no pass yet read as
    /// nothing found.
    #[test]
    fn until_a_pass_covers_the_scope_its_rules_are_not_checked() {
        let mut world = World {
            objects: vec![
                audited("Deployment", "shop", "web"),
                audited("ConfigMap", "shop", "web"),
            ],
            ..World::default()
        };
        merge(&mut world, None, None);
        assert_eq!(writers_unchecked(&world, "Deployment"), vec![Why::Reading]);
        assert!(writers_unchecked(&world, "ConfigMap").is_empty());
        assert!(world.upgrade_read.is_none());

        let narrow = Read {
            scope: Some(vec!["shop".to_string()]),
            at: "2026-11-14T10:00:00Z".to_string(),
            ..Read::default()
        };
        let mut world = World {
            objects: vec![audited("Deployment", "shop", "web")],
            ..World::default()
        };
        let scope = ["shop".to_string(), "bank".to_string()];
        merge(&mut world, Some(&narrow), Some(&scope));
        assert_eq!(writers_unchecked(&world, "Deployment"), vec![Why::Reading]);
        assert!(world.upgrade_read.is_none());

        let mut world = World {
            objects: vec![audited("Deployment", "shop", "web")],
            ..World::default()
        };
        merge(&mut world, Some(&narrow), Some(&scope[..1]));
        assert!(writers_unchecked(&world, "Deployment").is_empty());
        assert_eq!(world.upgrade_read.as_deref(), Some("2026-11-14T10:00:00Z"));
    }

    /// A kind whose writers were refused leaves each of its objects not
    /// checked with the cluster's words; an object the pass found joins the
    /// one the world already judges rather than standing beside it, and a
    /// count read twice is not added twice. Would break if the refusal were
    /// kept to the summary, so the `CronJob`'s tab said nothing.
    #[test]
    fn a_pass_merges_into_the_objects_judged_and_carries_what_it_could_not_read() {
        let refused = Why::Refused {
            message: "cronjobs is forbidden".to_string(),
        };
        let mut hpa = audited("HorizontalPodAutoscaler", "shop", "web");
        hpa.findings
            .push(AuditFinding::of(RuleId::DeprecatedApiWriter, Vec::new()));
        let read = Read {
            scope: None,
            at: "2026-11-14T10:00:00Z".to_string(),
            objects: vec![hpa],
            checked: BTreeMap::from([("HorizontalPodAutoscaler".to_string(), 1)]),
            not_checked: vec![NotChecked {
                kind: "CronJob".to_string(),
                namespace: Some("shop".to_string()),
                why: refused.clone(),
                rules: vec![RuleId::DeprecatedApiWriter],
            }],
        };
        let mut world = World {
            objects: vec![
                audited("HorizontalPodAutoscaler", "shop", "web"),
                audited("CronJob", "shop", "nightly"),
                audited("CronJob", "bank", "nightly"),
            ],
            checked: BTreeMap::from([("HorizontalPodAutoscaler".to_string(), 1)]),
            ..World::default()
        };

        merge(&mut world, Some(&read), None);

        assert_eq!(world.objects.len(), 3);
        assert_eq!(world.objects[0].findings.len(), 1);
        assert_eq!(world.checked["HorizontalPodAutoscaler"], 1);
        let blind: Vec<(&str, Vec<Why>)> = world.objects[1..]
            .iter()
            .map(|o| {
                (
                    o.subject.namespace.as_deref().unwrap(),
                    o.unchecked.iter().map(|u| u.why.clone()).collect(),
                )
            })
            .collect();
        assert_eq!(blind, vec![("shop", vec![refused]), ("bank", vec![])]);
        assert_eq!(world.not_checked.len(), 1);
    }

    fn release_secret(manifest: &str) -> String {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let payload = json!({
            "name": "web", "namespace": "shop", "version": 2,
            "info": { "status": "deployed" },
            "chart": { "metadata": { "name": "web", "version": "1.0.0" } },
            "manifest": manifest,
        });
        json!({
            "apiVersion": "v1", "kind": "Secret",
            "metadata": { "name": "sh.helm.release.v1.web.v2", "namespace": "shop" },
            "data": { "release": STANDARD.encode(STANDARD.encode(payload.to_string())) },
        })
        .to_string()
    }

    fn release_list(version: &str) -> String {
        let meta = |revision: i32, status: &str, rv: &str| {
            json!({ "metadata": {
                "name": format!("sh.helm.release.v1.web.v{revision}"), "namespace": "shop",
                "resourceVersion": rv,
                "labels": { "owner": "helm", "name": "web", "status": status,
                            "version": revision.to_string() },
            }})
        };
        json!({
            "kind": "PartialObjectMetadataList", "apiVersion": "meta.k8s.io/v1", "metadata": {},
            "items": [meta(1, "superseded", "10"), meta(2, "deployed", version)],
        })
        .to_string()
    }

    fn api_groups() -> String {
        let group = |name: &str, versions: &[&str]| {
            json!({
                "name": name,
                "versions": versions.iter().map(|v| json!({
                    "groupVersion": format!("{name}/{v}"), "version": v,
                })).collect::<Vec<_>>(),
                "preferredVersion": { "groupVersion": format!("{name}/{}", versions[0]),
                                      "version": versions[0] },
            })
        };
        json!({
            "kind": "APIGroupList", "apiVersion": "v1",
            "groups": [
                group("apps", &["v1"]),
                group("flowcontrol.apiserver.k8s.io", &["v1", "v1beta3"]),
            ],
        })
        .to_string()
    }

    fn resources(group_version: &str, kinds: &[(&str, &str)]) -> String {
        json!({
            "kind": "APIResourceList", "apiVersion": "v1", "groupVersion": group_version,
            "resources": kinds.iter().map(|(plural, kind)| json!({
                "name": plural, "singularName": "", "namespaced": false, "kind": kind,
                "verbs": ["get", "list", "watch"],
            })).collect::<Vec<_>>(),
        })
        .to_string()
    }

    fn flow_schemas() -> String {
        let schema = |name: &str, api: &str| {
            json!({ "metadata": {
                "name": name, "resourceVersion": "5",
                "managedFields": [{ "manager": "deployer", "operation": "Update",
                                    "apiVersion": api, "time": "2026-11-01T10:00:00Z" }],
            }})
        };
        json!({
            "kind": "PartialObjectMetadataList", "apiVersion": "meta.k8s.io/v1", "metadata": {},
            "items": [
                schema("legacy", "flowcontrol.apiserver.k8s.io/v1beta3"),
                schema("current", "flowcontrol.apiserver.k8s.io/v1"),
            ],
        })
        .to_string()
    }

    const SECRET: &str = "/api/v1/namespaces/shop/secrets/sh.helm.release.v1.web.v2";

    /// One cluster as a pass reads it: a release whose deployed revision
    /// stores a removed Ingress, an apps/v1 Deployment and a kind whose
    /// group is gone, and two `FlowSchema`s, one last written through a
    /// version 1.32 removes. A second pass fetches no release that did not
    /// change; a rewritten Secret is fetched again. Would break if a pass
    /// fetched every release each time, or listed writers of a kind with no
    /// served deprecated version.
    #[tokio::test]
    async fn a_pass_judges_releases_and_writers_and_fetches_only_what_changed() {
        let manifest = "---\napiVersion: extensions/v1beta1\nkind: Ingress\nmetadata:\n  name: web\n---\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n---\napiVersion: gone.example.com/v1\nkind: Widget\nmetadata:\n  name: web\n";
        let secret = release_secret(manifest);
        let (client, hits) = answering(move |path, nth| match path {
            "/api/v1/secrets" => (200, release_list(if nth < 3 { "20" } else { "21" })),
            SECRET => (200, secret.clone()),
            "/apis" => (200, api_groups()),
            "/apis/apps/v1" => (200, resources("apps/v1", &[("deployments", "Deployment")])),
            "/apis/flowcontrol.apiserver.k8s.io/v1"
            | "/apis/flowcontrol.apiserver.k8s.io/v1beta3" => (
                200,
                resources(
                    "flowcontrol.apiserver.k8s.io/v1",
                    &[
                        ("flowschemas", "FlowSchema"),
                        ("prioritylevelconfigurations", "PriorityLevelConfiguration"),
                    ],
                ),
            ),
            "/apis/flowcontrol.apiserver.k8s.io/v1/flowschemas" => (200, flow_schemas()),
            "/apis/flowcontrol.apiserver.k8s.io/v1/prioritylevelconfigurations" => (
                200,
                json!({ "kind": "PartialObjectMetadataList", "apiVersion": "meta.k8s.io/v1",
                        "metadata": {}, "items": [] })
                .to_string(),
            ),
            _ => failure(404, "NotFound"),
        })
        .await;
        let served = ServedIndex::default();
        let mut decoded = Decoded::default();

        let first = read(&client, &served, "fake", None, Some(31), &mut decoded).await;

        let release = first
            .objects
            .iter()
            .find(|o| o.subject.kind == HELM_RELEASE)
            .expect("the release");
        assert_eq!(release.subject.name, "web");
        assert_eq!(release.findings.len(), 1);
        assert_eq!(release.findings[0].severity, AuditSeverity::High);
        assert_eq!(
            stored(&release.findings[0]),
            vec![
                (
                    "extensions/v1beta1".to_string(),
                    false,
                    Some("1.22".to_string())
                ),
                ("gone.example.com/v1".to_string(), false, None),
            ]
        );
        let writers: Vec<&str> = first
            .objects
            .iter()
            .filter(|o| o.subject.kind == "FlowSchema")
            .map(|o| o.subject.name.as_str())
            .collect();
        assert_eq!(writers, vec!["legacy"]);
        assert_eq!(first.checked["FlowSchema"], 2);
        assert_eq!(first.checked[HELM_RELEASE], 1);
        assert!(first.not_checked.is_empty(), "{:?}", first.not_checked);
        assert!(!hits
            .lock()
            .unwrap()
            .contains_key("/apis/apps/v1/deployments"));
        assert_eq!(decoded.fetched, 1);

        let second = read(&client, &served, "fake", None, Some(31), &mut decoded).await;
        assert_eq!(decoded.fetched, 1);
        assert_eq!(second.objects.len(), first.objects.len());

        read(&client, &served, "fake", None, Some(31), &mut decoded).await;
        assert_eq!(decoded.fetched, 2);
        assert_eq!(hits.lock().unwrap()[SECRET], 2);
    }

    /// A namespace whose release Secrets would not list is named as not
    /// checked with the cluster's words, and the namespaces that did list
    /// are judged. Would break if a refused list read as "no releases".
    #[tokio::test]
    async fn a_namespace_whose_releases_would_not_list_is_named_not_none() {
        let (client, _) = answering(|path, _| match path {
            "/api/v1/namespaces/locked/secrets" => failure(403, "Forbidden"),
            "/api/v1/namespaces/shop/secrets" => (
                200,
                json!({ "kind": "PartialObjectMetadataList", "apiVersion": "meta.k8s.io/v1",
                        "metadata": {}, "items": [] })
                .to_string(),
            ),
            "/apis" => (200, api_groups()),
            _ => failure(404, "NotFound"),
        })
        .await;
        let scope = ["shop".to_string(), "locked".to_string()];
        let mut decoded = Decoded::default();

        let pass = read(
            &client,
            &ServedIndex::default(),
            "fake",
            Some(&scope),
            Some(33),
            &mut decoded,
        )
        .await;

        assert_eq!(pass.not_checked.len(), 1);
        let blind = &pass.not_checked[0];
        assert_eq!(blind.kind, "Secret");
        assert_eq!(blind.namespace.as_deref(), Some("locked"));
        assert!(matches!(blind.why, Why::Refused { .. }));
        assert_eq!(blind.rules, vec![RuleId::RemovedApiInHelmRelease]);
    }

    fn batch_groups() -> String {
        json!({
            "kind": "APIGroupList", "apiVersion": "v1",
            "groups": [{
                "name": "batch",
                "versions": [
                    { "groupVersion": "batch/v1", "version": "v1" },
                    { "groupVersion": "batch/v1beta1", "version": "v1beta1" },
                ],
                "preferredVersion": { "groupVersion": "batch/v1", "version": "v1" },
            }],
        })
        .to_string()
    }

    /// A `CronJob`'s own page judges the `managedFields` its read already holds
    /// with the Audit page's functions, and says not checked where discovery
    /// failed and the cluster's version is unknown. Would break if the page
    /// judged writers some other way, or passed an unread kind.
    #[tokio::test]
    async fn a_page_judges_its_objects_writers_as_the_audit_page_does() {
        let (state, _) =
            crate::client::served::test_server::connected(ServedIndex::default(), |path, _| {
                match path {
                    "/apis" => (200, batch_groups()),
                    "/apis/batch/v1" | "/apis/batch/v1beta1" => {
                        (200, resources("batch/v1", &[("cronjobs", "CronJob")]))
                    }
                    _ => failure(404, "NotFound"),
                }
            })
            .await;
        let here = state.here().expect("connected");
        let subject = Subject {
            kind: "CronJob".to_string(),
            namespace: Some("shop".to_string()),
            name: "nightly".to_string(),
        };
        let fields = [
            entry("ci", "batch/v1beta1"),
            entry("kube-controller-manager", "batch/v1"),
        ];

        let (finding, blind) = written_of(&here, Some(24), &subject, &fields).await;

        assert!(blind.is_none());
        let finding = finding.expect("a finding");
        assert!(matches!(
            &finding.what[..],
            [What::Written { manager, removal, .. }] if manager == "ci" && removal.removed == "1.25"
        ));

        let (state, _) =
            crate::client::served::test_server::connected(ServedIndex::default(), |_, _| {
                failure(503, "ServiceUnavailable")
            })
            .await;
        let here = state.here().expect("connected");
        let (finding, blind) = written_of(&here, None, &subject, &fields).await;
        assert!(finding.is_none());
        assert_eq!(
            blind.expect("not checked").rule,
            RuleId::DeprecatedApiWriter
        );
    }

    /// 500 releases each storing 30 removed objects, opened under their
    /// rule: every page stays inside one IPC message and the pages follow
    /// one another to the last release. Would break if a page were cut by
    /// rows alone, which puts 200 such rows in one message.
    #[test]
    fn a_rule_of_long_releases_pages_inside_the_message_budget() {
        let objects: Vec<ReleaseObject> = (0..30)
            .map(|n| ReleaseObject {
                name: format!("ingress-{n}"),
                ..object("extensions/v1beta1", "Ingress")
            })
            .collect();
        let started = Instant::now();
        let mut pass = Read {
            at: "2026-11-14T10:00:00Z".to_string(),
            ..Read::default()
        };
        for n in 0..500 {
            let revision = ReleaseRevision {
                release: format!("web-{n}"),
                ..web()
            };
            let (finding, _) = judge_release(&revision, &objects, &Groups::new(), Some(33));
            pass.objects.push(Audited {
                subject: Subject {
                    kind: HELM_RELEASE.to_string(),
                    namespace: Some("shop".to_string()),
                    name: revision.release.clone(),
                },
                system: false,
                findings: finding.into_iter().collect(),
                unchecked: Vec::new(),
            });
        }
        let mut world = World::default();
        merge(&mut world, Some(&pass), None);
        let judged = started.elapsed();

        let mut offset = 0;
        let mut seen = 0;
        let mut largest = 0;
        let mut pages = 0;
        loop {
            let query: AuditQuery = serde_json::from_value(json!({
                "by": "rule", "rule": "removed-api-in-helm-release", "offset": offset,
            }))
            .unwrap();
            let answer = page(&world, &query, 1, Vec::new());
            let bytes = wire_len(&answer);
            largest = largest.max(bytes);
            assert!(bytes <= IPC_TARGET_BYTES, "a page of {bytes} bytes");
            seen += answer
                .rows
                .iter()
                .filter(|row| matches!(row, AuditRow::Found { .. }))
                .count();
            pages += 1;
            match answer.next {
                Some(next) => offset = next,
                None => break,
            }
        }
        assert_eq!(seen, 500);
        println!(
            "500 releases x 30 objects: judged in {judged:?}, {pages} pages, largest {largest} bytes"
        );
    }
}
