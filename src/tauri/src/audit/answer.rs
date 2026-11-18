//! What the Audit page and a detail page are told: everything the index
//! holds for a scope, counted whole, and a page of it at a time.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::context::{beside, Beside, Defaults};
use super::index::{audited, key_of, why_unread, AuditIndex, Body, Entry, PodRead, POD_READ_AGAIN};
use super::rules::{AUTOSCALER, BUDGET, DEPLOYMENT, NETWORK_POLICY, POD, STATEFUL_SET};
use super::{
    is_system, AuditFinding, AuditSeverity, Category, RuleId, Subject, Unchecked, What, Why,
};
use crate::feeds::FeedState;
use crate::ownership::{ClusterIndex, KindKey, SlotKey};
use crate::resources::OtherPolicies;
use crate::state::perf::{wire_len, IPC_TARGET_BYTES};

/// The most rows one answer carries.
pub const PAGE_LIMIT: u32 = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Grouping {
    Rule,
    Object,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditQuery {
    pub by: Grouping,
    #[serde(default)]
    pub categories: Vec<Category>,
    #[serde(default)]
    pub severities: Vec<AuditSeverity>,
    #[serde(default)]
    pub rules: Vec<RuleId>,
    /// The objects one rule found, in place of the groups.
    #[serde(default)]
    pub rule: Option<RuleId>,
    /// The folded system part, in place of the rest.
    #[serde(default)]
    pub system: bool,
    #[serde(default)]
    pub offset: u32,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BySeverity {
    pub high: u32,
    pub medium: u32,
    pub low: u32,
}

impl BySeverity {
    fn add(&mut self, severity: AuditSeverity) {
        match severity {
            AuditSeverity::High => self.high += 1,
            AuditSeverity::Medium => self.medium += 1,
            AuditSeverity::Low => self.low += 1,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ByCategory {
    pub security: u32,
    pub reliability: u32,
    pub efficiency: u32,
    pub upgrade: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleCount {
    pub rule: RuleId,
    /// Objects it found something in, outside the system part.
    pub objects: u32,
    /// Objects it could not answer for, outside the system part.
    pub unchecked: u32,
    pub system: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KindChecked {
    pub kind: String,
    pub objects: u32,
}

/// A kind not read somewhere in the scope, and the rules it leaves blind.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotChecked {
    pub kind: String,
    /// `None` across the whole cluster.
    pub namespace: Option<String>,
    pub why: Why,
    pub rules: Vec<RuleId>,
}

/// A kind whose watch broke: what is shown of it is as read then.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Late {
    pub kind: String,
    pub namespace: Option<String>,
    pub since: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Enforced {
    pub namespace: String,
    pub level: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemPart {
    pub namespaces: Vec<String>,
    pub objects: u32,
    pub findings: u32,
}

/// Where the upgrade rules stand: when their last pass over the scope
/// ended, and the version the cluster said it runs.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpgradeRead {
    /// `None` while the first pass over this scope is still reading.
    pub read: Option<String>,
    pub server: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditSummary {
    /// Findings outside the system part: one per object and rule.
    pub findings: u32,
    pub severities: BySeverity,
    pub categories: ByCategory,
    pub rules: Vec<RuleCount>,
    pub checked: Vec<KindChecked>,
    pub not_checked: Vec<NotChecked>,
    pub late: Vec<Late>,
    pub system: SystemPart,
    /// Pods read whole one at a time whose answer has not come.
    pub reading: u32,
    /// Pods whose controller could not be told, so nothing judged them.
    pub unattributed: u32,
    /// Namespaces that enforce a Pod Security level, where it was read.
    pub enforced: Vec<Enforced>,
    /// Why the namespaces' Pod Security labels were not read: `enforced`
    /// then says nothing of them.
    pub enforced_unread: Option<Why>,
    pub upgrade: UpgradeRead,
    /// Where requests against use stand: `None` where nothing asked.
    pub usage: Option<super::UsageState>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "row", rename_all = "camelCase")]
pub enum AuditRow {
    Rule {
        rule: RuleId,
        /// `None` where the rule found nothing and only could not check.
        worst: Option<AuditSeverity>,
        objects: u32,
        unchecked: u32,
    },
    Object {
        subject: Subject,
        worst: Option<AuditSeverity>,
        severities: BySeverity,
        rules: Vec<RuleId>,
        unchecked: u32,
    },
    /// One object under an opened rule, and what the rule found in it.
    Found {
        subject: Subject,
        finding: AuditFinding,
    },
    /// One object under an opened rule that the rule could not answer for.
    Blind {
        subject: Subject,
        unchecked: Unchecked,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditPage {
    /// Moves with every change the index takes; the page reads again on it.
    pub revision: u64,
    pub summary: AuditSummary,
    pub rows: Vec<AuditRow>,
    pub total: u32,
    pub next: Option<u32>,
}

/// One object's findings and blind rules.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectAudit {
    pub subject: Subject,
    pub system: bool,
    pub findings: Vec<AuditFinding>,
    pub unchecked: Vec<Unchecked>,
    /// The object whose template this one is judged as, where it is another.
    pub judged_on: Option<Subject>,
}

/// One object as the page counts it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Audited {
    pub subject: Subject,
    pub system: bool,
    pub findings: Vec<AuditFinding>,
    pub unchecked: Vec<Unchecked>,
}

/// Everything known about a scope, before any filter or page.
#[derive(Debug, Clone, Default)]
pub struct World {
    pub objects: Vec<Audited>,
    pub checked: BTreeMap<String, u32>,
    pub not_checked: Vec<NotChecked>,
    pub late: Vec<Late>,
    pub reading: u32,
    pub unattributed: u32,
    /// When the upgrade rules' last pass over this scope ended.
    pub upgrade_read: Option<String>,
    /// What the webview read of usage, where the page was asked with it.
    pub usage: Option<super::UsageState>,
}

pub(super) fn in_scope(namespace: Option<&str>, scope: Option<&[String]>) -> bool {
    match (scope, namespace) {
        (None, _) => true,
        (Some(names), Some(namespace)) => names.iter().any(|name| name == namespace),
        // A selection of namespaces holds no cluster-wide object.
        (Some(_), None) => false,
    }
}

/// The rules that read `kind` beside the object judged.
fn blinded_by(kind: &str) -> Vec<RuleId> {
    super::rules::RULES
        .iter()
        .filter(|rule| rule.needs.contains(&kind))
        .map(|rule| rule.id)
        .collect()
}

/// The rules a kind not read leaves unanswered: those that read it beside
/// what they judge, and those that judge it.
fn unread_rules(kind: &str) -> Vec<RuleId> {
    let mut rules = blinded_by(kind);
    if counted(kind) {
        rules.extend(
            super::rules::RULES
                .iter()
                .filter(|rule| judges(rule.id, kind))
                .map(|rule| rule.id),
        );
    }
    rules.sort();
    rules.dedup();
    rules
}

/// A namespace's neighbours, as its slots read them.
pub(super) fn beside_of(
    slots: &BTreeMap<SlotKey, FeedState>,
    entries: &[&Entry],
    namespace: &str,
) -> Beside {
    let unread = |kind: &KindKey| why_unread(slots, kind, Some(namespace));
    let key = |group: &str, plural: &str| KindKey {
        group: group.to_string(),
        plural: plural.to_string(),
    };
    let read = |kind: KindKey| unread(&kind).map_or(Ok(()), Err);
    Beside {
        namespace: namespace.to_string(),
        services: read(key("", "services")).map(|()| {
            entries
                .iter()
                .filter_map(|entry| match &entry.body {
                    Body::Service(selector) => Some((entry.subject.name.clone(), selector.clone())),
                    _ => None,
                })
                .collect()
        }),
        budgets: read(key("policy", "poddisruptionbudgets")).map(|()| {
            entries
                .iter()
                .filter_map(|entry| match &entry.body {
                    Body::Budget(selector) => Some(selector.clone()),
                    _ => None,
                })
                .collect()
        }),
        autoscalers: read(key("autoscaling", "horizontalpodautoscalers")).map(|()| {
            entries
                .iter()
                .filter_map(|entry| match &entry.body {
                    Body::Autoscaler(scales) => Some(scales.clone()),
                    _ => None,
                })
                .collect()
        }),
        limits: read(key("", "limitranges")).map(|()| {
            entries
                .iter()
                .fold(Defaults::default(), |all, entry| match &entry.body {
                    Body::Limits(one) => Defaults {
                        cpu_request: all.cpu_request || one.cpu_request,
                        memory_request: all.memory_request || one.memory_request,
                        memory_limit: all.memory_limit || one.memory_limit,
                    },
                    _ => all,
                })
        }),
        account: read(key("", "serviceaccounts")).map(|()| {
            entries
                .iter()
                .find_map(|entry| match &entry.body {
                    Body::Account(automount) => Some(*automount),
                    _ => None,
                })
                .flatten()
        }),
    }
}

/// The kinds counted as checked: those a rule judges, not those only read beside.
fn counted(kind: &str) -> bool {
    !matches!(
        kind,
        "Service" | "ServiceAccount" | "LimitRange" | "NetworkPolicy"
    )
}

/// How pods are read, from the ownership index's slots, per namespace.
fn pods_unread(owners: Owners<'_>, namespace: &str) -> Option<Why> {
    match owners {
        Ok(owners) => why_unread(&owner_states(owners), &pods_key(), Some(namespace)),
        Err(why) => Some(why.clone()),
    }
}

/// The ownership index pods are read from, or why there is none.
pub type Owners<'a> = Result<&'a ClusterIndex, &'a Why>;

/// The ownership index's slots, read as the feeds' are.
fn owner_states(owners: &ClusterIndex) -> BTreeMap<SlotKey, FeedState> {
    owners
        .slot_states()
        .iter()
        .map(|(slot, state)| (slot.clone(), FeedState::of(state)))
        .collect()
}

fn pods_key() -> KindKey {
    KindKey {
        group: String::new(),
        plural: "pods".to_string(),
    }
}

/// Everything the index holds for `scope`, with the pods the ownership
/// index holds beside it.
pub(super) fn world(
    index: &Arc<AuditIndex>,
    owners: Owners<'_>,
    scope: Option<&[String]>,
) -> World {
    let slots = index.slot_states();
    let mut store = index.store.write();
    store.refresh(&|entries, namespace| beside_of(&slots, entries, namespace));
    let store = parking_lot::RwLockWriteGuard::downgrade(store);

    let mut world = World::default();
    let mut names: BTreeSet<(String, String, String)> = BTreeSet::new();
    let mut namespaces: BTreeSet<String> = scope
        .map(|s| s.iter().cloned().collect())
        .unwrap_or_default();
    let mut policies: HashMap<&str, u32> = HashMap::new();
    let mut autoscalers: Vec<&Entry> = Vec::new();

    for (uid, entry) in &store.entries {
        let namespace = entry.subject.namespace.as_deref();
        if !in_scope(namespace, scope) {
            continue;
        }
        if let Some(namespace) = namespace {
            namespaces.insert(namespace.to_string());
        }
        names.insert((
            entry.subject.kind.clone(),
            namespace.unwrap_or_default().to_string(),
            entry.subject.name.clone(),
        ));
        match &entry.body {
            Body::Policy => *policies.entry(namespace.unwrap_or_default()).or_default() += 1,
            Body::Autoscaler(_) => autoscalers.push(entry),
            _ => {}
        }
        if !counted(&entry.subject.kind) {
            continue;
        }
        *world.checked.entry(entry.subject.kind.clone()).or_default() += 1;
        let (mut findings, mut unchecked) = namespace
            .and_then(|ns| store.beside.get(ns))
            .and_then(|found| found.get(uid))
            .cloned()
            .unwrap_or_default();
        findings.extend(entry.own.iter().cloned());
        unchecked.extend(entry.unread.iter().cloned());
        world.objects.push(Audited {
            subject: entry.subject.clone(),
            system: entry.system,
            findings,
            unchecked,
        });
    }

    autoscaler_targets(&mut world, &slots, &autoscalers, &names);
    pods(
        &mut world,
        index,
        owners,
        &store,
        scope,
        &slots,
        &mut namespaces,
    );
    let others = index.others.read().clone();
    network_policies(
        &mut world,
        owners,
        &slots,
        &namespaces,
        &policies,
        others.as_ref(),
    );
    readings(&mut world, &slots, owners, scope);
    admitted(&mut world, index.admission.read().as_ref(), &namespaces);
    super::upgrade::merge(&mut world, index.upgrade.read().as_deref(), scope);
    for object in &mut world.objects {
        object.findings.sort_by_key(|f| (f.severity, f.rule));
        object.unchecked.sort_by_key(|u| u.rule);
    }
    world
}

fn autoscaler_targets(
    world: &mut World,
    slots: &BTreeMap<SlotKey, FeedState>,
    autoscalers: &[&Entry],
    names: &BTreeSet<(String, String, String)>,
) {
    for entry in autoscalers {
        let Body::Autoscaler(scales) = &entry.body else {
            continue;
        };
        let namespace = entry.subject.namespace.clone().unwrap_or_default();
        let kind = match scales.kind.as_str() {
            DEPLOYMENT => Some(KindKey {
                group: "apps".to_string(),
                plural: "deployments".to_string(),
            }),
            STATEFUL_SET => Some(KindKey {
                group: "apps".to_string(),
                plural: "statefulsets".to_string(),
            }),
            _ => None,
        };
        let audited = world
            .objects
            .iter_mut()
            .find(|object| object.subject == entry.subject);
        let Some(object) = audited else { continue };
        let Some(kind) = kind else {
            object.unchecked.push(Unchecked {
                rule: RuleId::AutoscalerTargetMissing,
                kind: scales.kind.clone(),
                namespace: Some(namespace),
                why: Why::NotAudited,
            });
            continue;
        };
        if let Some(why) = why_unread(slots, &kind, Some(&namespace)) {
            object.unchecked.push(Unchecked {
                rule: RuleId::AutoscalerTargetMissing,
                kind: scales.kind.clone(),
                namespace: Some(namespace),
                why,
            });
        } else if !names.contains(&(scales.kind.clone(), namespace, scales.target.clone())) {
            object.findings.push(AuditFinding::of(
                RuleId::AutoscalerTargetMissing,
                vec![What::Target {
                    kind: scales.kind.clone(),
                    name: scales.target.clone(),
                }],
            ));
        }
    }
}

/// Pods nothing judged here stamped, judged whole: one per controller of a
/// kind Audit does not read, each pod with no controller, and each pod a
/// node runs from a file. A pod of a workload Audit judges is that
/// workload's. Where the workloads or the pods' owners were not read, the
/// pod is counted as unattributed, never judged twice.
fn pods(
    world: &mut World,
    index: &Arc<AuditIndex>,
    owners: Owners<'_>,
    store: &super::index::Store,
    scope: Option<&[String]>,
    slots: &BTreeMap<SlotKey, FeedState>,
    namespaces: &mut BTreeSet<String>,
) {
    let Ok(owners) = owners else { return };
    let owner_slots = owner_states(owners);
    let judged: std::collections::HashSet<&str> =
        store.entries.keys().map(String::as_str).collect();
    let workloads: Vec<KindKey> = audited()
        .iter()
        .filter(|(resource, _)| {
            matches!(
                resource.kind.as_str(),
                "Deployment" | "StatefulSet" | "DaemonSet" | "Job" | "CronJob"
            )
        })
        .map(|(resource, _)| key_of(resource))
        .collect();
    let replica_sets = KindKey {
        group: "apps".to_string(),
        plural: "replicasets".to_string(),
    };
    let mut wanted: BTreeMap<String, (String, String)> = BTreeMap::new();
    for pod in owners.held(&pods_key()) {
        let Some(namespace) = pod.namespace.clone() else {
            continue;
        };
        if !in_scope(Some(&namespace), scope) {
            continue;
        }
        namespaces.insert(namespace.clone());
        let read_here = workloads
            .iter()
            .all(|kind| why_unread(slots, kind, Some(&namespace)).is_none());
        let key = match pod.controller.as_deref() {
            None => Some(format!("pod/{}", pod.uid)),
            Some(controller) if judged.contains(controller) => None,
            Some(controller) => match owners.held_one(controller) {
                Some(held) if held.kind == "Node" => Some(format!("pod/{}", pod.uid)),
                // A Deployment's ReplicaSet, a CronJob's Job: the workload above is judged.
                Some(held)
                    if held
                        .controller
                        .as_deref()
                        .is_some_and(|c| judged.contains(c)) =>
                {
                    None
                }
                Some(_) if read_here => Some(format!("controller/{controller}")),
                None if read_here
                    && why_unread(&owner_slots, &replica_sets, Some(&namespace)).is_none() =>
                {
                    Some(format!("controller/{controller}"))
                }
                _ => {
                    world.unattributed += 1;
                    None
                }
            },
        };
        if let Some(key) = key {
            wanted.entry(key).or_insert((namespace, pod.name.clone()));
        }
    }
    // Let go only of what this scope no longer wants: a judged pod of a
    // namespace another caller reads is theirs to keep, or every object's
    // read would make the page read its pods again.
    let held = {
        let mut pods = index.pods.lock();
        pods.retain(|key, held| {
            wanted.contains_key(key)
                || match held {
                    PodRead::Reading => true,
                    PodRead::Judged(pod) => !in_scope(pod.subject.namespace.as_deref(), scope),
                    PodRead::Unread { namespace, .. } => !in_scope(Some(namespace), scope),
                }
        });
        pods.clone()
    };
    let mut seen: BTreeSet<Subject> = BTreeSet::new();
    for (key, (namespace, name)) in wanted {
        match held.get(&key) {
            None => {
                index.read_pod(key, namespace, name);
                world.reading += 1;
            }
            Some(PodRead::Unread { at, .. }) if at.elapsed() >= POD_READ_AGAIN => {
                index.read_pod(key, namespace, name);
                world.reading += 1;
            }
            Some(PodRead::Reading) => world.reading += 1,
            Some(PodRead::Unread { why, .. }) => {
                let unread = NotChecked {
                    kind: POD.to_string(),
                    namespace: Some(namespace),
                    why: why.clone(),
                    rules: unread_rules(POD),
                };
                if !world.not_checked.contains(&unread) {
                    world.not_checked.push(unread);
                }
            }
            Some(PodRead::Judged(pod)) => {
                if !seen.insert(pod.subject.clone()) {
                    continue;
                }
                let entries: Vec<&Entry> = store
                    .entries
                    .values()
                    .filter(|entry| entry.subject.namespace.as_deref() == Some(namespace.as_str()))
                    .collect();
                let ns = beside_of(slots, &entries, &namespace);
                let (mut findings, unchecked) = beside(
                    &pod.subject.kind,
                    &pod.subject.name,
                    &pod.facts,
                    super::context::Replicated(None),
                    &ns,
                );
                findings.extend(pod.own.iter().cloned());
                *world.checked.entry(POD.to_string()).or_default() += 1;
                world.objects.push(Audited {
                    subject: pod.subject.clone(),
                    system: pod.system,
                    findings,
                    unchecked,
                });
            }
        }
    }
}

/// One finding per namespace that runs pods and has no `NetworkPolicy`,
/// where no other engine's policy may hold over them: Cilium, Calico,
/// Antrea and `AdminNetworkPolicy` admit what a namespace's `NetworkPolicy`
/// objects alone do not say, so there the rule could not check.
fn network_policies(
    world: &mut World,
    owners: Owners<'_>,
    slots: &BTreeMap<SlotKey, FeedState>,
    namespaces: &BTreeSet<String>,
    policies: &HashMap<&str, u32>,
    others: Option<&(Option<Vec<String>>, OtherPolicies)>,
) {
    let pod_counts: HashMap<String, usize> = owners
        .ok()
        .map(|owners| {
            let mut counts = HashMap::new();
            for pod in owners.held(&pods_key()) {
                if let Some(namespace) = pod.namespace {
                    *counts.entry(namespace).or_default() += 1;
                }
            }
            counts
        })
        .unwrap_or_default();
    let policy_kind = KindKey {
        group: "networking.k8s.io".to_string(),
        plural: "networkpolicies".to_string(),
    };
    for namespace in namespaces {
        let subject = Subject {
            kind: "Namespace".to_string(),
            namespace: None,
            name: namespace.clone(),
        };
        let engines = match others {
            Some((read, found)) if read.as_ref().is_none_or(|read| read.contains(namespace)) => {
                let kinds = found.over(namespace);
                (!kinds.is_empty()).then(|| (kinds.join(", "), Why::NotAudited))
            }
            _ => Some((
                crate::commands::other_policies::kind_names().join(", "),
                Why::Reading,
            )),
        };
        let blind = pods_unread(owners, namespace)
            .map(|why| (POD.to_string(), why))
            .or_else(|| {
                why_unread(slots, &policy_kind, Some(namespace))
                    .map(|why| (NETWORK_POLICY.to_string(), why))
            })
            .or(engines);
        let mut audited = Audited {
            system: is_system(&subject, None),
            subject,
            findings: Vec::new(),
            unchecked: Vec::new(),
        };
        if let Some((kind, why)) = blind {
            audited.unchecked.push(Unchecked {
                rule: RuleId::NamespaceWithoutNetworkPolicy,
                kind,
                namespace: Some(namespace.clone()),
                why,
            });
        } else {
            let pods = pod_counts.get(namespace).copied().unwrap_or(0);
            if pods > 0 && policies.get(namespace.as_str()).copied().unwrap_or(0) == 0 {
                audited.findings.push(AuditFinding::of(
                    RuleId::NamespaceWithoutNetworkPolicy,
                    vec![What::Pods { pods }],
                ));
            }
        }
        *world.checked.entry("Namespace".to_string()).or_default() += 1;
        world.objects.push(audited);
    }
}

/// Where a mutating webhook may change pods on admission, what the Pod
/// Security controls judged is the template and not what runs: said where
/// the counts are, as any kind not read is.
fn admitted(
    world: &mut World,
    admission: Option<&super::admitted::Admission>,
    namespaces: &BTreeSet<String>,
) {
    let controls: Vec<RuleId> = super::rules::RULES
        .iter()
        .filter(|rule| rule.standard.is_some())
        .map(|rule| rule.id)
        .collect();
    let webhooks = "MutatingWebhookConfiguration".to_string();
    for namespace in namespaces {
        let unread = match admission.and_then(|admission| admission.over(namespace)) {
            Some(Ok(names)) if names.is_empty() => continue,
            Some(Ok(names)) => NotChecked {
                kind: POD.to_string(),
                namespace: Some(namespace.clone()),
                why: Why::Admitted { webhooks: names },
                rules: controls.clone(),
            },
            Some(Err(why)) => NotChecked {
                kind: webhooks.clone(),
                namespace: None,
                why,
                rules: controls.clone(),
            },
            None => NotChecked {
                kind: webhooks.clone(),
                namespace: None,
                why: Why::Reading,
                rules: controls.clone(),
            },
        };
        if !world.not_checked.contains(&unread) {
            world.not_checked.push(unread);
        }
    }
}

/// Every kind not read somewhere in the scope, and every kind read late.
fn readings(
    world: &mut World,
    slots: &BTreeMap<SlotKey, FeedState>,
    owners: Owners<'_>,
    scope: Option<&[String]>,
) {
    let mut kinds: Vec<(String, KindKey, bool, BTreeMap<SlotKey, FeedState>)> = audited()
        .into_iter()
        .map(|(resource, namespaced)| {
            (
                resource.kind.clone(),
                key_of(&resource),
                namespaced,
                slots.clone(),
            )
        })
        .collect();
    match owners {
        Ok(owners) => kinds.push((POD.to_string(), pods_key(), true, owner_states(owners))),
        Err(why) => world.not_checked.push(NotChecked {
            kind: POD.to_string(),
            namespace: None,
            why: why.clone(),
            rules: unread_rules(POD),
        }),
    }
    for (kind, key, namespaced, states) in kinds {
        let rules = unread_rules(&kind);
        let reaches: Vec<Option<String>> = match scope {
            None => vec![None],
            Some(names) if namespaced => names.iter().cloned().map(Some).collect(),
            Some(_) => Vec::new(),
        };
        for reach in reaches {
            if let Some(why) = why_unread(&states, &key, reach.as_deref()) {
                world.not_checked.push(NotChecked {
                    kind: kind.clone(),
                    namespace: reach,
                    why,
                    rules: rules.clone(),
                });
            }
        }
        for (slot, state) in &states {
            let here = slot.kind == key
                && (slot.namespace.is_none() || in_scope(slot.namespace.as_deref(), scope));
            if let (true, FeedState::Blind { since }) = (here, state) {
                world.late.push(Late {
                    kind: kind.clone(),
                    namespace: slot.namespace.clone(),
                    since: since.clone(),
                });
            }
        }
    }
}

/// The rules judged on an object of `kind` itself.
fn judges(rule: RuleId, kind: &str) -> bool {
    use RuleId as R;
    // A pod no workload Audit reads stamped is judged whole, as a template.
    let template = matches!(
        kind,
        "Deployment" | "StatefulSet" | "DaemonSet" | "Job" | "CronJob" | POD
    );
    match rule {
        R::ConfigMapPrivateKey => kind == "ConfigMap",
        R::WildcardRole => matches!(kind, "Role" | "ClusterRole"),
        R::ClusterAdminBinding => matches!(kind, "RoleBinding" | "ClusterRoleBinding"),
        R::AutoscalerPinned | R::AutoscalerTargetMissing => kind == AUTOSCALER,
        R::BudgetBlocksDisruption => kind == BUDGET,
        // Judged on a replica count, which only these two carry.
        R::SingleReplica | R::NoSpread | R::NoDisruptionBudget => {
            matches!(kind, "Deployment" | "StatefulSet")
        }
        // Read by their own pass, not through the kind's feed.
        R::NamespaceWithoutNetworkPolicy
        | R::RemovedApiInHelmRelease
        | R::DeprecatedApiWriter
        | R::CrdVersionDeprecated
        | R::DeprecatedApiRequested
        | R::RequestsAboveUsage => false,
        _ => template,
    }
}

fn count(rules: &mut BTreeMap<RuleId, RuleCount>, rule: RuleId) -> &mut RuleCount {
    rules.entry(rule).or_insert(RuleCount {
        rule,
        objects: 0,
        unchecked: 0,
        system: 0,
    })
}

/// The summary of a world, apart from its page.
fn summary(world: &World, enforced: Vec<Enforced>) -> AuditSummary {
    let mut summary = AuditSummary {
        checked: world
            .checked
            .iter()
            .map(|(kind, objects)| KindChecked {
                kind: kind.clone(),
                objects: *objects,
            })
            .collect(),
        not_checked: world.not_checked.clone(),
        late: world.late.clone(),
        reading: world.reading,
        unattributed: world.unattributed,
        enforced,
        upgrade: UpgradeRead {
            read: world.upgrade_read.clone(),
            server: None,
        },
        usage: world.usage.clone(),
        ..AuditSummary::default()
    };
    let mut rules: BTreeMap<RuleId, RuleCount> = BTreeMap::new();
    let mut system_namespaces: BTreeSet<String> = BTreeSet::new();
    for object in &world.objects {
        if object.system {
            if !object.findings.is_empty() {
                summary.system.objects += 1;
                summary.system.findings += object.findings.len() as u32;
                system_namespaces.insert(
                    object
                        .subject
                        .namespace
                        .clone()
                        .unwrap_or_else(|| object.subject.name.clone()),
                );
            }
        } else {
            for finding in &object.findings {
                summary.findings += 1;
                summary.severities.add(finding.severity);
                match finding.rule.rule().category {
                    Category::Security => summary.categories.security += 1,
                    Category::Reliability => summary.categories.reliability += 1,
                    Category::Efficiency => summary.categories.efficiency += 1,
                    Category::Upgrade => summary.categories.upgrade += 1,
                }
            }
        }
        for finding in &object.findings {
            let entry = count(&mut rules, finding.rule);
            if object.system {
                entry.system += 1;
            } else {
                entry.objects += 1;
            }
        }
        if !object.system {
            for rule in object
                .unchecked
                .iter()
                .map(|u| u.rule)
                .collect::<BTreeSet<_>>()
            {
                count(&mut rules, rule).unchecked += 1;
            }
        }
    }
    summary.system.namespaces = system_namespaces
        .into_iter()
        .filter(|name| super::is_system_namespace(name))
        .collect();
    summary.rules = rules.into_values().collect();
    summary
}

fn passes(finding: &AuditFinding, query: &AuditQuery) -> bool {
    let rule = finding.rule.rule();
    (query.categories.is_empty() || query.categories.contains(&rule.category))
        && (query.severities.is_empty() || query.severities.contains(&finding.severity))
        && (query.rules.is_empty() || query.rules.contains(&finding.rule))
}

fn blind_passes(unchecked: &Unchecked, query: &AuditQuery) -> bool {
    let rule = unchecked.rule.rule();
    (query.categories.is_empty() || query.categories.contains(&rule.category))
        && (query.severities.is_empty() || query.severities.contains(&rule.severity))
        && (query.rules.is_empty() || query.rules.contains(&unchecked.rule))
}

/// The rows a query asks for, all of them, in the order they are drawn.
fn rows(world: &World, query: &AuditQuery) -> Vec<AuditRow> {
    let part = world.objects.iter().filter(|o| o.system == query.system);
    if let Some(rule) = query.rule {
        let mut found: Vec<AuditRow> = Vec::new();
        let mut blind: Vec<AuditRow> = Vec::new();
        for object in part {
            for finding in object
                .findings
                .iter()
                .filter(|f| f.rule == rule && passes(f, query))
            {
                found.push(AuditRow::Found {
                    subject: object.subject.clone(),
                    finding: finding.clone(),
                });
            }
            if let Some(unchecked) = object.unchecked.iter().find(|u| u.rule == rule) {
                blind.push(AuditRow::Blind {
                    subject: object.subject.clone(),
                    unchecked: unchecked.clone(),
                });
            }
        }
        found.sort_by(|a, b| match (a, b) {
            (
                AuditRow::Found {
                    subject: sa,
                    finding: fa,
                },
                AuditRow::Found {
                    subject: sb,
                    finding: fb,
                },
            ) => (fa.severity, sa).cmp(&(fb.severity, sb)),
            _ => std::cmp::Ordering::Equal,
        });
        found.extend(blind);
        return found;
    }
    match query.by {
        Grouping::Rule => {
            let mut by_rule: BTreeMap<RuleId, (Option<AuditSeverity>, u32, u32)> = BTreeMap::new();
            for object in part {
                for finding in object.findings.iter().filter(|f| passes(f, query)) {
                    let entry = by_rule.entry(finding.rule).or_default();
                    entry.0 = Some(
                        entry
                            .0
                            .map_or(finding.severity, |w| w.min(finding.severity)),
                    );
                    entry.1 += 1;
                }
                for unchecked in object.unchecked.iter().filter(|u| blind_passes(u, query)) {
                    by_rule.entry(unchecked.rule).or_default().2 += 1;
                }
            }
            let mut rows: Vec<(Option<AuditSeverity>, RuleId, u32, u32)> = by_rule
                .into_iter()
                .map(|(rule, (worst, objects, unchecked))| (worst, rule, objects, unchecked))
                .collect();
            rows.sort_by_key(|(worst, rule, objects, _)| {
                (
                    worst.map_or(3, |s| s as u8),
                    std::cmp::Reverse(*objects),
                    *rule,
                )
            });
            rows.into_iter()
                .map(|(worst, rule, objects, unchecked)| AuditRow::Rule {
                    rule,
                    worst,
                    objects,
                    unchecked,
                })
                .collect()
        }
        Grouping::Object => {
            let mut rows: Vec<(Option<AuditSeverity>, std::cmp::Reverse<u32>, AuditRow)> = part
                .filter_map(|object| {
                    let shown: Vec<&AuditFinding> = object
                        .findings
                        .iter()
                        .filter(|f| passes(f, query))
                        .collect();
                    let unchecked = object
                        .unchecked
                        .iter()
                        .filter(|u| blind_passes(u, query))
                        .count() as u32;
                    if shown.is_empty() && unchecked == 0 {
                        return None;
                    }
                    let mut severities = BySeverity::default();
                    for finding in &shown {
                        severities.add(finding.severity);
                    }
                    let worst = shown.iter().map(|f| f.severity).min();
                    let mut rules: Vec<RuleId> = shown.iter().map(|f| f.rule).collect();
                    rules.dedup();
                    Some((
                        worst,
                        std::cmp::Reverse(
                            severities.high * 10_000 + severities.medium * 100 + severities.low,
                        ),
                        AuditRow::Object {
                            subject: object.subject.clone(),
                            worst,
                            severities,
                            rules,
                            unchecked,
                        },
                    ))
                })
                .collect();
            rows.sort_by(|a, b| {
                let rank = |s: Option<AuditSeverity>| s.map_or(3, |s| s as u8);
                (rank(a.0), &a.1)
                    .cmp(&(rank(b.0), &b.1))
                    .then_with(|| match (&a.2, &b.2) {
                        (
                            AuditRow::Object { subject: x, .. },
                            AuditRow::Object { subject: y, .. },
                        ) => x.cmp(y),
                        _ => std::cmp::Ordering::Equal,
                    })
            });
            rows.into_iter().map(|(_, _, row)| row).collect()
        }
    }
}

/// One page of the answer to `query`, with the whole scope's summary.
#[must_use]
pub fn page(
    world: &World,
    query: &AuditQuery,
    revision: u64,
    enforced: Vec<Enforced>,
) -> AuditPage {
    let rows = rows(world, query);
    let total = rows.len() as u32;
    let limit = query.limit.unwrap_or(PAGE_LIMIT).clamp(1, PAGE_LIMIT);
    let start = query.offset.min(total);
    let summary = summary(world, enforced);
    // A row may carry a release's whole list of objects: the page ends
    // where the next row would take the message past its budget.
    let mut room = IPC_TARGET_BYTES.saturating_sub(wire_len(&summary) + 256);
    let mut end = start;
    for row in &rows[start as usize..start.saturating_add(limit).min(total) as usize] {
        let len = wire_len(row) + 1;
        if end > start && len > room {
            break;
        }
        room = room.saturating_sub(len);
        end += 1;
    }
    AuditPage {
        revision,
        summary,
        rows: rows[start as usize..end as usize].to_vec(),
        total,
        next: (end < total).then_some(end),
    }
}

/// One object, as the page holds it, where the index holds it.
#[must_use]
pub fn object_in(world: &World, subject: &Subject) -> Option<ObjectAudit> {
    world
        .objects
        .iter()
        .find(|object| object.subject == *subject)
        .map(|object| ObjectAudit {
            subject: object.subject.clone(),
            system: object.system,
            findings: object.findings.clone(),
            unchecked: object.unchecked.clone(),
            judged_on: None,
        })
}

#[cfg(test)]
mod tests {
    use kube::discovery::ApiResource;
    use serde_json::json;

    use super::*;
    use crate::audit::index::tests::{client, deployment, deployments};

    fn query() -> AuditQuery {
        AuditQuery {
            by: Grouping::Object,
            categories: Vec::new(),
            severities: Vec::new(),
            rules: Vec::new(),
            rule: None,
            system: false,
            offset: 0,
            limit: None,
        }
    }

    fn pods() -> KindKey {
        pods_key()
    }

    fn budgets() -> ApiResource {
        ApiResource::erase::<k8s_openapi::api::policy::v1::PodDisruptionBudget>(&())
    }

    fn autoscalers() -> ApiResource {
        ApiResource::erase::<k8s_openapi::api::autoscaling::v2::HorizontalPodAutoscaler>(&())
    }

    fn policies() -> ApiResource {
        ApiResource::erase::<k8s_openapi::api::networking::v1::NetworkPolicy>(&())
    }

    fn refused() -> FeedState {
        FeedState::Refused {
            message: "poddisruptionbudgets is forbidden".to_string(),
        }
    }

    /// A refused kind is named with the rules it leaves blind, and the
    /// object those rules could not answer for says so. Fails if a refusal
    /// reads as nothing found.
    #[tokio::test]
    async fn a_refused_kind_is_named_with_the_rules_it_blinds_and_never_reads_as_none() {
        let index = crate::audit::index::AuditIndex::holding(client().await, None);
        index.set(&budgets(), None, refused());
        index.feed(&deployments(), deployment("shop", "web", "1", "web:1.0"));
        let missing = Why::Reading;
        let seen = world(&index, Err(&missing), None);
        let answer = page(&seen, &query(), 1, Vec::new());
        let budget = answer
            .summary
            .not_checked
            .iter()
            .find(|n| n.kind == "PodDisruptionBudget")
            .expect("the refusal is named");
        assert!(budget.rules.contains(&RuleId::NoDisruptionBudget));
        let web = seen
            .objects
            .iter()
            .find(|o| o.subject.name == "web")
            .unwrap();
        assert!(web
            .unchecked
            .iter()
            .any(|u| u.rule == RuleId::NoDisruptionBudget));
        assert!(!web
            .findings
            .iter()
            .any(|f| f.rule == RuleId::NoDisruptionBudget));
        assert!(answer.summary.not_checked.iter().any(|n| n.kind == "Pod"));
    }

    /// A refused feed blinds the rules judged through it, and not the upgrade
    /// rules, which read their kinds in a pass of their own. Would break if a
    /// refused Deployment watch said a Helm release went unchecked.
    #[tokio::test]
    async fn a_refused_feed_leaves_the_upgrade_rules_to_their_own_pass() {
        let index = crate::audit::index::AuditIndex::holding(client().await, None);
        index.set(&deployments(), None, refused());
        let missing = Why::Reading;
        let seen = world(&index, Err(&missing), None);
        let refusal = seen
            .not_checked
            .iter()
            .find(|n| n.kind == "Deployment")
            .expect("the refusal is named");
        assert!(refusal.rules.contains(&RuleId::PssPrivileged));
        assert!(!refusal.rules.contains(&RuleId::RemovedApiInHelmRelease));
        assert!(!refusal.rules.contains(&RuleId::DeprecatedApiWriter));
    }

    /// The system's own objects are shown in their own part and kept out of
    /// the counts. Fails if kube-system's findings swell the summary, or
    /// vanish instead of folding.
    #[tokio::test]
    async fn the_systems_findings_fold_apart_and_stay_out_of_the_counts() {
        let index = crate::audit::index::AuditIndex::holding(client().await, None);
        index.feed(
            &deployments(),
            deployment("kube-system", "coredns", "1", "coredns"),
        );
        let missing = Why::Reading;
        let seen = world(&index, Err(&missing), None);
        let answer = page(&seen, &query(), 1, Vec::new());
        assert_eq!(answer.summary.findings, 0);
        assert!(answer.summary.system.findings > 0);
        assert_eq!(
            answer.summary.system.namespaces,
            vec!["kube-system".to_string()]
        );
        let mut folded = query();
        folded.system = true;
        assert!(!page(&seen, &folded, 1, Vec::new()).rows.is_empty());
    }

    /// Fails if a missing target is not said, a target of a kind Audit does
    /// not read is said missing, or one in a namespace whose Deployments
    /// went unread is either.
    #[tokio::test]
    async fn an_autoscaler_target_is_missing_only_where_its_kind_was_read() {
        let hpa = |name: &str, kind: &str, target: &str| {
            json!({
                "apiVersion": "autoscaling/v2", "kind": "HorizontalPodAutoscaler",
                "metadata": { "name": name, "namespace": "shop", "uid": name, "resourceVersion": "1" },
                "spec": { "minReplicas": 2, "maxReplicas": 5,
                    "scaleTargetRef": { "apiVersion": "apps/v1", "kind": kind, "name": target } }
            })
        };
        let index = crate::audit::index::AuditIndex::holding(client().await, None);
        index.feed(&autoscalers(), hpa("gone", "Deployment", "nowhere"));
        index.feed(&autoscalers(), hpa("rollout", "Rollout", "web"));
        let missing = Why::Reading;
        let seen = world(&index, Err(&missing), None);
        let of = |name: &str| {
            seen.objects
                .iter()
                .find(|o| o.subject.name == name)
                .unwrap()
                .clone()
        };
        assert!(of("gone")
            .findings
            .iter()
            .any(|f| f.rule == RuleId::AutoscalerTargetMissing));
        assert!(of("rollout")
            .unchecked
            .iter()
            .any(|u| u.rule == RuleId::AutoscalerTargetMissing && u.why == Why::NotAudited));

        index.set(&deployments(), None, refused());
        index.feed(&autoscalers(), hpa("gone", "Deployment", "nowhere"));
        let seen = world(&index, Err(&missing), None);
        let gone = seen
            .objects
            .iter()
            .find(|o| o.subject.name == "gone")
            .unwrap();
        assert!(!gone
            .findings
            .iter()
            .any(|f| f.rule == RuleId::AutoscalerTargetMissing));
        assert!(gone
            .unchecked
            .iter()
            .any(|u| u.rule == RuleId::AutoscalerTargetMissing));
    }

    /// A rule that found nothing and only could not check carries no
    /// severity and sorts after every rule that found something. Fails if an
    /// autoscaler aimed at a Rollout reads as a High finding on no object.
    #[test]
    fn a_rule_that_only_could_not_check_wears_no_severity() {
        let object = |name: &str| Audited {
            subject: Subject {
                kind: "HorizontalPodAutoscaler".to_string(),
                namespace: Some("shop".to_string()),
                name: name.to_string(),
            },
            system: false,
            findings: Vec::new(),
            unchecked: Vec::new(),
        };
        let mut low = object("web");
        low.findings
            .push(AuditFinding::of(RuleId::NoLivenessProbe, Vec::new()));
        let mut rollout = object("rollout");
        rollout.unchecked.push(Unchecked {
            rule: RuleId::AutoscalerTargetMissing,
            kind: "Rollout".to_string(),
            namespace: Some("shop".to_string()),
            why: Why::NotAudited,
        });
        let world = World {
            objects: vec![low, rollout],
            ..World::default()
        };
        let by_rule = AuditQuery {
            by: Grouping::Rule,
            ..query()
        };
        let shown: Vec<(RuleId, Option<AuditSeverity>, u32, u32)> = rows(&world, &by_rule)
            .into_iter()
            .filter_map(|row| match row {
                AuditRow::Rule {
                    rule,
                    worst,
                    objects,
                    unchecked,
                } => Some((rule, worst, objects, unchecked)),
                _ => None,
            })
            .collect();
        assert_eq!(
            shown,
            vec![
                (RuleId::NoLivenessProbe, Some(AuditSeverity::Low), 1, 0),
                (RuleId::AutoscalerTargetMissing, None, 0, 1),
            ]
        );
    }

    /// One finding per namespace, never per workload. Fails if a namespace
    /// whose policies or pods went unread is said to have none.
    #[tokio::test]
    async fn a_namespace_running_pods_with_no_policy_is_one_finding_and_unread_is_not_none() {
        let client = client().await;
        let index = crate::audit::index::AuditIndex::holding(client.clone(), None);
        let owners = ClusterIndex::holding(client, &[]);
        for n in 0..3 {
            owners.hold(
                &pods(),
                "Pod",
                &format!("p{n}"),
                (&format!("solo-{n}"), Some("shop")),
                Some("someone"),
            );
        }
        let shop = |seen: &World| {
            seen.objects
                .iter()
                .find(|o| o.subject.kind == "Namespace" && o.subject.name == "shop")
                .cloned()
                .unwrap()
        };
        let seen = world(&index, Ok(&owners), Some(&["shop".to_string()]));
        let found = shop(&seen);
        assert_eq!(
            found.findings,
            vec![AuditFinding::of(
                RuleId::NamespaceWithoutNetworkPolicy,
                vec![What::Pods { pods: 3 }]
            )]
        );

        index.set(&policies(), None, refused());
        let blind = shop(&world(&index, Ok(&owners), Some(&["shop".to_string()])));
        assert!(blind.findings.is_empty());
        assert_eq!(blind.unchecked[0].kind, NETWORK_POLICY);

        index.set(&policies(), None, FeedState::Synced);
        let missing = Why::Failed {
            message: "discovery failed".to_string(),
        };
        let blind = shop(&world(&index, Err(&missing), Some(&["shop".to_string()])));
        assert!(blind.findings.is_empty());
        assert_eq!(blind.unchecked[0].kind, POD);
    }

    /// A budget whose controller has not written a status cannot be judged:
    /// its rule says so rather than passing it. Fails if a budget made a
    /// moment ago reads as one that allows an eviction.
    #[tokio::test]
    async fn a_budget_with_no_status_is_not_checked_rather_than_passed() {
        let index = crate::audit::index::AuditIndex::holding(client().await, None);
        let budget = |name: &str, status: Option<serde_json::Value>| {
            let mut value = json!({
                "apiVersion": "policy/v1", "kind": "PodDisruptionBudget",
                "metadata": { "name": name, "namespace": "shop", "uid": name, "resourceVersion": "1" },
                "spec": { "minAvailable": 1, "selector": { "matchLabels": { "app": name } } }
            });
            if let Some(status) = status {
                value["status"] = status;
            }
            value
        };
        index.feed(&budgets(), budget("new", None));
        index.feed(
            &budgets(),
            budget(
                "written",
                Some(json!({ "disruptionsAllowed": 1, "currentHealthy": 2,
                    "desiredHealthy": 1, "expectedPods": 2, "observedGeneration": 1 })),
            ),
        );
        let seen = world(&index, Err(&Why::Reading), None);
        let of = |name: &str| {
            seen.objects
                .iter()
                .find(|o| o.subject.name == name)
                .cloned()
                .unwrap()
        };
        let new = of("new");
        assert!(new.findings.is_empty());
        assert!(new
            .unchecked
            .iter()
            .any(|u| u.rule == RuleId::BudgetBlocksDisruption));
        assert!(!of("written")
            .unchecked
            .iter()
            .any(|u| u.rule == RuleId::BudgetBlocksDisruption));
    }

    /// kubeadm's own cluster-admin binding folds with the system's, its
    /// finding kept; the same group bound by a binding someone made is a
    /// finding in the scope's own part. Fails if every kubeadm cluster
    /// shows its bootstrap as the reader's High finding.
    #[tokio::test]
    async fn kubeadms_own_binding_folds_with_the_systems_and_another_to_its_group_does_not() {
        let index = crate::audit::index::AuditIndex::holding(client().await, None);
        let bindings = ApiResource::erase::<k8s_openapi::api::rbac::v1::ClusterRoleBinding>(&());
        let binding = |name: &str| {
            json!({
                "apiVersion": "rbac.authorization.k8s.io/v1", "kind": "ClusterRoleBinding",
                "metadata": { "name": name, "uid": name, "resourceVersion": "1" },
                "roleRef": { "apiGroup": "rbac.authorization.k8s.io", "kind": "ClusterRole", "name": "cluster-admin" },
                "subjects": [{ "kind": "Group", "name": "kubeadm:cluster-admins" }]
            })
        };
        index.feed(&bindings, binding("kubeadm:cluster-admins"));
        index.feed(&bindings, binding("open"));
        let seen = world(&index, Err(&Why::Reading), None);
        let of = |name: &str| {
            seen.objects
                .iter()
                .find(|o| o.subject.name == name)
                .cloned()
                .unwrap()
        };
        let own = of("kubeadm:cluster-admins");
        assert!(
            own.system,
            "kubeadm's own binding is not filed with the system's"
        );
        assert_eq!(own.findings.len(), 1);
        let open = of("open");
        assert!(!open.system);
        assert_eq!(open.findings[0].rule, RuleId::ClusterAdminBinding);
    }

    /// A world of two namespaces running pods and holding no `NetworkPolicy`,
    /// with `others` as the last read of other engines' policies said.
    async fn policed(others: (Option<Vec<String>>, OtherPolicies)) -> World {
        let client = client().await;
        let index = crate::audit::index::AuditIndex::holding(client.clone(), None);
        let owners = ClusterIndex::holding(client, &[]);
        for namespace in ["shop", "web"] {
            owners.hold(
                &pods(),
                "Pod",
                namespace,
                (namespace, Some(namespace)),
                Some("someone"),
            );
        }
        *index.others.write() = Some(others);
        world(&index, Ok(&owners), None)
    }

    fn namespace(seen: &World, name: &str) -> Audited {
        seen.objects
            .iter()
            .find(|o| o.subject.kind == "Namespace" && o.subject.name == name)
            .cloned()
            .unwrap()
    }

    /// Where another engine's policy may hold over a namespace's pods, its
    /// `NetworkPolicy` objects do not say who is let in: the rule could not
    /// check there, and names the kinds. Fails if a Cilium cluster's
    /// namespaces are each told every pod accepts traffic from every pod.
    #[tokio::test]
    async fn a_namespace_another_engine_may_police_is_not_checked_not_open() {
        let mut found = OtherPolicies::none();
        found.within("shop", "CiliumNetworkPolicy");
        let seen = policed((None, found)).await;
        let shop = namespace(&seen, "shop");
        assert!(shop.findings.is_empty());
        assert_eq!(shop.unchecked[0].kind, "CiliumNetworkPolicy");
        assert_eq!(shop.unchecked[0].why, Why::NotAudited);
        assert_eq!(namespace(&seen, "web").findings.len(), 1);
    }

    /// A namespace whose pods pass a webhook that may add containers is said
    /// not checked by the Pod Security controls, with the webhook named; one
    /// no webhook selects is not. Fails if Istio's injected init container
    /// passes the controls unread, or every namespace is said so.
    #[tokio::test]
    async fn a_namespace_a_webhook_may_change_pods_in_is_not_checked_by_the_controls() {
        let client = client().await;
        let index = crate::audit::index::AuditIndex::holding(client.clone(), None);
        let owners = ClusterIndex::holding(client, &[]);
        index.feed(&deployments(), deployment("mesh", "web", "1", "web:1"));
        index.feed(&deployments(), deployment("plain", "web", "1", "web:1"));
        let injection: k8s_openapi::apimachinery::pkg::apis::meta::v1::LabelSelector =
            serde_json::from_value(
                json!({ "matchLabels": { "kubernetes.io/metadata.name": "mesh" } }),
            )
            .expect("a selector");
        let named = |name: &str| {
            (
                name.to_string(),
                BTreeMap::from([("kubernetes.io/metadata.name".to_string(), name.to_string())]),
            )
        };
        *index.admission.write() = Some(super::super::admitted::Admission::of(
            vec![("sidecar-injector.istio.io".to_string(), injection)],
            BTreeMap::from([named("mesh"), named("plain")]),
        ));
        let seen = world(&index, Ok(&owners), None);
        let mesh: Vec<&NotChecked> = seen
            .not_checked
            .iter()
            .filter(|each| matches!(each.why, Why::Admitted { .. }))
            .collect();
        assert_eq!(mesh.len(), 1, "{:?}", seen.not_checked);
        assert_eq!(mesh[0].kind, POD);
        assert_eq!(mesh[0].namespace.as_deref(), Some("mesh"));
        assert_eq!(
            mesh[0].why,
            Why::Admitted {
                webhooks: vec!["sidecar-injector.istio.io".to_string()]
            }
        );
        assert!(mesh[0].rules.contains(&RuleId::PssCapabilities));
    }

    /// Fails if a namespace the other engines were not yet asked about
    /// reads as open rather than as still being read.
    #[tokio::test]
    async fn a_namespace_not_yet_asked_about_other_engines_is_still_being_read() {
        let seen = policed((Some(vec!["shop".to_string()]), OtherPolicies::none())).await;
        let web = namespace(&seen, "web");
        assert!(
            web.findings.is_empty(),
            "a namespace not yet asked about reads as open"
        );
        assert_eq!(web.unchecked[0].why, Why::Reading);
        assert_eq!(namespace(&seen, "shop").findings.len(), 1);
    }

    /// A `CronJob`'s runs are judged on the `CronJob`, a Deployment's pods on the
    /// Deployment; a pod of a controller Audit does not read is read whole,
    /// once for its controller. Fails if a run is judged again, or a pod no
    /// workload Audit reads stamped goes unjudged without a word.
    #[tokio::test]
    async fn a_pod_is_judged_on_the_workload_above_it_or_read_once_for_its_controller() {
        let client = client().await;
        let index = crate::audit::index::AuditIndex::holding(client.clone(), None);
        let owners = ClusterIndex::holding(client, &[]);
        let crons = ApiResource::erase::<k8s_openapi::api::batch::v1::CronJob>(&());
        index.feed(
            &crons,
            json!({
                "apiVersion": "batch/v1", "kind": "CronJob",
                "metadata": { "name": "nightly", "namespace": "ops", "uid": "cron-1", "resourceVersion": "1" },
                "spec": { "schedule": "* * * * *", "jobTemplate": { "spec": { "template": { "spec": {
                    "restartPolicy": "OnFailure", "containers": [{ "name": "run", "image": "x:1" }] } } } } }
            }),
        );
        let jobs = KindKey {
            group: "batch".to_string(),
            plural: "jobs".to_string(),
        };
        let clusters = KindKey {
            group: "postgresql.cnpg.io".to_string(),
            plural: "clusters".to_string(),
        };
        owners.hold(
            &jobs,
            "Job",
            "job-1",
            ("nightly-1", Some("ops")),
            Some("cron-1"),
        );
        owners.hold(
            &pods(),
            "Pod",
            "run-pod",
            ("nightly-1-x", Some("ops")),
            Some("job-1"),
        );
        owners.hold(&clusters, "Cluster", "pg-1", ("pg", Some("ops")), None);
        owners.hold(&pods(), "Pod", "pg-a", ("pg-1", Some("ops")), Some("pg-1"));
        owners.hold(&pods(), "Pod", "pg-b", ("pg-2", Some("ops")), Some("pg-1"));
        let replica_sets = KindKey {
            group: "apps".to_string(),
            plural: "replicasets".to_string(),
        };
        owners.hold(
            &replica_sets,
            "ReplicaSet",
            "rs-0",
            ("unused", Some("ops")),
            None,
        );

        let seen = world(&index, Ok(&owners), None);
        assert_eq!(seen.unattributed, 0);
        assert_eq!(
            seen.reading, 1,
            "one read for the Cluster's two pods, none for the run"
        );
        let held: Vec<String> = index.pods.lock().keys().cloned().collect();
        assert_eq!(held, vec!["controller/pg-1".to_string()]);
        index.stop_for_test();
    }

    /// One namespace's read lets go of no pod another namespace's reader
    /// judged. Fails if opening an object in `shop` drops the judged static
    /// pods of `kube-system`, which the page then reads again, in a loop.
    #[tokio::test]
    async fn a_read_of_one_namespace_keeps_the_pods_judged_in_others() {
        let client = client().await;
        let index = crate::audit::index::AuditIndex::holding(client.clone(), None);
        let owners = ClusterIndex::holding(client, &[]);
        owners.hold(
            &pods(),
            "Pod",
            "etcd",
            ("etcd-node", Some("kube-system")),
            None,
        );
        owners.hold(&pods(), "Pod", "lone", ("lone", Some("shop")), None);
        let judged = |namespace: &str, name: &str| crate::audit::index::PodJudged {
            subject: Subject {
                kind: POD.to_string(),
                namespace: Some(namespace.to_string()),
                name: name.to_string(),
            },
            system: false,
            own: Vec::new(),
            facts: super::super::template::TemplateFacts::default(),
        };
        {
            let mut pods = index.pods.lock();
            pods.insert(
                "pod/etcd".to_string(),
                PodRead::Judged(judged("kube-system", "etcd-node")),
            );
            pods.insert(
                "pod/lone".to_string(),
                PodRead::Judged(judged("shop", "lone")),
            );
            pods.insert(
                "pod/gone".to_string(),
                PodRead::Judged(judged("shop", "gone")),
            );
        }
        let shop = ["shop".to_string()];
        world(&index, Ok(&owners), Some(&shop[..]));
        let mut held: Vec<String> = index.pods.lock().keys().cloned().collect();
        held.sort();
        assert_eq!(held, vec!["pod/etcd".to_string(), "pod/lone".to_string()]);
        let page = world(&index, Ok(&owners), None);
        assert_eq!(page.reading, 0, "the page reads its pods again");
        index.stop_for_test();
    }

    /// A kind that could not be read leaves unanswered the rules that can
    /// judge it and no others. Fails if a `DaemonSet`, a `Job`, a `CronJob` or a
    /// pod, none of which carries a replica count, is said to leave the
    /// replica rules unchecked.
    #[test]
    fn a_kind_not_read_leaves_the_replica_rules_only_where_there_is_a_count() {
        let replica = [
            RuleId::SingleReplica,
            RuleId::NoSpread,
            RuleId::NoDisruptionBudget,
        ];
        for kind in ["Deployment", "StatefulSet"] {
            let rules = unread_rules(kind);
            assert!(replica.iter().all(|rule| rules.contains(rule)), "{kind}");
        }
        for kind in ["DaemonSet", "Job", "CronJob", POD] {
            let rules = unread_rules(kind);
            assert!(!replica.iter().any(|rule| rules.contains(rule)), "{kind}");
            assert!(rules.contains(&RuleId::PssPrivileged), "{kind}");
        }
    }

    /// A pod the cluster will not hand over is named not checked with its
    /// words, not read as "still being read" and fetched on every read.
    /// Fails if a refused GET reads as reading for good.
    #[tokio::test]
    async fn a_pod_the_cluster_will_not_hand_over_is_not_checked_not_reading() {
        let (client, hits) = crate::client::served::test_server::answering(|path, _| {
            if path.ends_with("/pods/lone") {
                crate::client::served::test_server::failure(403, "Forbidden")
            } else {
                (404, "{}".to_string())
            }
        })
        .await;
        let index = crate::audit::index::AuditIndex::holding(client.clone(), None);
        index.pod_reads.add_permits(1);
        let owners = ClusterIndex::holding(client, &[]);
        owners.hold(&pods(), "Pod", "lone", ("lone", Some("shop")), None);
        assert_eq!(world(&index, Ok(&owners), None).reading, 1);
        for _ in 0..200 {
            if matches!(
                index.pods.lock().get("pod/lone"),
                Some(PodRead::Unread { .. })
            ) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        let seen = world(&index, Ok(&owners), None);
        assert_eq!(seen.reading, 0, "a refused read is still being read");
        let refused = seen
            .not_checked
            .iter()
            .find(|unread| {
                unread.kind == POD
                    && unread.namespace.as_deref() == Some("shop")
                    && matches!(unread.why, Why::Refused { .. })
            })
            .expect("the pod named not checked");
        // A pod read whole is judged by the template rules, unanswered here.
        assert!(refused.rules.contains(&RuleId::PssPrivileged));
        assert!(refused.rules.contains(&RuleId::NoLivenessProbe));
        // A pod carries no replica count: those rules never judge one.
        for rule in [
            RuleId::SingleReplica,
            RuleId::NoSpread,
            RuleId::NoDisruptionBudget,
        ] {
            assert!(!refused.rules.contains(&rule), "{rule:?}");
        }
        assert_eq!(
            hits.lock()
                .unwrap()
                .get("/api/v1/namespaces/shop/pods/lone"),
            Some(&1)
        );
        index.stop_for_test();
    }

    /// Fails if a page past the first is lost or repeated.
    #[tokio::test]
    async fn pages_follow_one_another_to_the_end() {
        let index = crate::audit::index::AuditIndex::holding(client().await, None);
        for n in 0..5 {
            index.feed(
                &deployments(),
                deployment("shop", &format!("web-{n}"), "1", "web"),
            );
        }
        let missing = Why::Reading;
        let seen = world(&index, Err(&missing), None);
        let mut q = query();
        q.limit = Some(2);
        let mut names = Vec::new();
        loop {
            let answer = page(&seen, &q, 1, Vec::new());
            for row in &answer.rows {
                if let AuditRow::Object { subject, .. } = row {
                    names.push(subject.name.clone());
                }
            }
            match answer.next {
                Some(next) => q.offset = next,
                None => break,
            }
        }
        let total = page(&seen, &query(), 1, Vec::new()).total as usize;
        names.sort();
        names.dedup();
        assert_eq!(names.len(), total);
    }
}
