//! What the Audit page and a detail page are told: everything the index
//! holds for a scope, counted whole, and a page of it at a time.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::context::{beside, Beside, Defaults};
use super::index::{audited, key_of, why_unread, AuditIndex, Body, Entry};
use super::rules::{AUTOSCALER, BUDGET, DEPLOYMENT, NETWORK_POLICY, POD, STATEFUL_SET};
use super::{
    is_system, AuditFinding, AuditSeverity, Category, RuleId, Subject, Unchecked, What, Why,
};
use crate::ownership::{ClusterIndex, KindKey, SlotKey, SlotState};

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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "row", rename_all = "camelCase")]
pub enum AuditRow {
    Rule {
        rule: RuleId,
        worst: AuditSeverity,
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
}

fn in_scope(namespace: Option<&str>, scope: Option<&[String]>) -> bool {
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

/// A namespace's neighbours, as its slots read them.
pub(super) fn beside_of(
    slots: &BTreeMap<SlotKey, SlotState>,
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
        Ok(owners) => why_unread(&owners.slot_states(), &pods_key(), Some(namespace)),
        Err(why) => Some(why.clone()),
    }
}

/// The ownership index pods are read from, or why there is none.
pub type Owners<'a> = Result<&'a ClusterIndex, &'a Why>;

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
        let (mut findings, unchecked) = namespace
            .and_then(|ns| store.beside.get(ns))
            .and_then(|found| found.get(uid))
            .cloned()
            .unwrap_or_default();
        findings.extend(entry.own.iter().cloned());
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
    network_policies(&mut world, owners, &slots, &namespaces, &policies);
    readings(&mut world, &slots, owners, scope);
    for object in &mut world.objects {
        object.findings.sort_by_key(|f| (f.severity, f.rule));
        object.unchecked.sort_by_key(|u| u.rule);
    }
    world
}

fn autoscaler_targets(
    world: &mut World,
    slots: &BTreeMap<SlotKey, SlotState>,
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
    slots: &BTreeMap<SlotKey, SlotState>,
    namespaces: &mut BTreeSet<String>,
) {
    let Ok(owners) = owners else { return };
    let owner_slots = owners.slot_states();
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
                Some(held)
                    if held.kind == "ReplicaSet"
                        && held
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
    let held = {
        let mut pods = index.pods.lock();
        pods.retain(|key, _| wanted.contains_key(key));
        pods.clone()
    };
    let mut seen: BTreeSet<Subject> = BTreeSet::new();
    for (key, (namespace, name)) in wanted {
        match held.get(&key) {
            None => {
                index.read_pod(key, namespace, name);
                world.reading += 1;
            }
            Some(None) => world.reading += 1,
            Some(Some(pod)) => {
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

/// One finding per namespace that runs pods and has no `NetworkPolicy`.
fn network_policies(
    world: &mut World,
    owners: Owners<'_>,
    slots: &BTreeMap<SlotKey, SlotState>,
    namespaces: &BTreeSet<String>,
    policies: &HashMap<&str, u32>,
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
        let blind = pods_unread(owners, namespace)
            .map(|why| (POD, why))
            .or_else(|| {
                why_unread(slots, &policy_kind, Some(namespace)).map(|why| (NETWORK_POLICY, why))
            });
        let mut audited = Audited {
            system: is_system(&subject, None),
            subject,
            findings: Vec::new(),
            unchecked: Vec::new(),
        };
        if let Some((kind, why)) = blind {
            audited.unchecked.push(Unchecked {
                rule: RuleId::NamespaceWithoutNetworkPolicy,
                kind: kind.to_string(),
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

/// Every kind not read somewhere in the scope, and every kind read late.
fn readings(
    world: &mut World,
    slots: &BTreeMap<SlotKey, SlotState>,
    owners: Owners<'_>,
    scope: Option<&[String]>,
) {
    let mut kinds: Vec<(String, KindKey, bool, BTreeMap<SlotKey, SlotState>)> = audited()
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
        Ok(owners) => kinds.push((POD.to_string(), pods_key(), true, owners.slot_states())),
        Err(why) => world.not_checked.push(NotChecked {
            kind: POD.to_string(),
            namespace: None,
            why: why.clone(),
            rules: blinded_by(POD),
        }),
    }
    for (kind, key, namespaced, states) in kinds {
        let mut rules = blinded_by(&kind);
        if counted(&kind) && kind != POD {
            rules.extend(
                super::rules::RULES
                    .iter()
                    .filter(|rule| judges(rule.id, &kind))
                    .map(|rule| rule.id),
            );
        }
        rules.sort();
        rules.dedup();
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
            if let (true, SlotState::Stale { since }) = (here, state) {
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
    let template = matches!(
        kind,
        "Deployment" | "StatefulSet" | "DaemonSet" | "Job" | "CronJob"
    );
    match rule {
        R::ConfigMapPrivateKey => kind == "ConfigMap",
        R::WildcardRole => matches!(kind, "Role" | "ClusterRole"),
        R::ClusterAdminBinding => matches!(kind, "RoleBinding" | "ClusterRoleBinding"),
        R::AutoscalerPinned | R::AutoscalerTargetMissing => kind == AUTOSCALER,
        R::BudgetBlocksDisruption => kind == BUDGET,
        R::NamespaceWithoutNetworkPolicy => false,
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
            let mut by_rule: BTreeMap<RuleId, (AuditSeverity, u32, u32)> = BTreeMap::new();
            for object in part {
                for finding in object.findings.iter().filter(|f| passes(f, query)) {
                    let entry = by_rule
                        .entry(finding.rule)
                        .or_insert((finding.severity, 0, 0));
                    entry.0 = entry.0.min(finding.severity);
                    entry.1 += 1;
                }
                for unchecked in object.unchecked.iter().filter(|u| blind_passes(u, query)) {
                    let entry = by_rule.entry(unchecked.rule).or_insert((
                        unchecked.rule.rule().severity,
                        0,
                        0,
                    ));
                    entry.2 += 1;
                }
            }
            let mut rows: Vec<(AuditSeverity, RuleId, u32, u32)> = by_rule
                .into_iter()
                .map(|(rule, (worst, objects, unchecked))| (worst, rule, objects, unchecked))
                .collect();
            rows.sort_by_key(|(worst, rule, objects, _)| {
                (*worst, std::cmp::Reverse(*objects), *rule)
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
    let end = start.saturating_add(limit).min(total);
    AuditPage {
        revision,
        summary: summary(world, enforced),
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

    fn refused() -> SlotState {
        SlotState::Refused {
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

        index.set(&policies(), None, SlotState::Live);
        let missing = Why::Failed {
            message: "discovery failed".to_string(),
        };
        let blind = shop(&world(&index, Err(&missing), Some(&["shop".to_string()])));
        assert!(blind.findings.is_empty());
        assert_eq!(blind.unchecked[0].kind, POD);
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
