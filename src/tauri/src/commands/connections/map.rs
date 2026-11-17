//! One namespace as the cluster map draws it, read by the helpers the
//! Connections tab reads every object by: the map is another reader of the
//! same facts, fed from held lists instead of one object's reads.

use std::collections::{BTreeMap, HashMap};

use k8s_openapi::api::core::v1::Event;
use k8s_openapi::api::networking::v1::NetworkPolicy;

use super::*;
use crate::resources::topology::{
    app_of, node_id, verb_of, MapKindCount, NamespaceRead, NodeVerdict, PodStatusTally, PodTally,
    PolicyCover, TopologyEdge, TopologyNode,
};

/// A `ConfigMap`, Secret or `ServiceAccount`, as far as the map reads one:
/// its name and labels, never its data.
#[derive(Debug, Clone)]
pub struct Named {
    pub namespace: String,
    pub name: String,
    pub labels: BTreeMap<String, String>,
}

/// One namespace's held lists. `Err` carries why a kind was not read here.
pub struct Held {
    pub namespace: String,
    pub pods: Read<Pod>,
    pub services: Read<Service>,
    pub ingresses: Read<Ingress>,
    pub claims: Read<PersistentVolumeClaim>,
    pub autoscalers: Read<HorizontalPodAutoscaler>,
    pub budgets: Read<PodDisruptionBudget>,
    pub deployments: Read<Deployment>,
    pub stateful_sets: Read<StatefulSet>,
    pub daemon_sets: Read<DaemonSet>,
    pub replica_sets: Read<ReplicaSet>,
    pub jobs: Read<Job>,
    pub cron_jobs: Read<CronJob>,
    /// The namespace's Warning events.
    pub warnings: Read<Event>,
    pub policies: CodedRead<NetworkPolicy>,
    pub others: crate::resources::OtherPolicies,
    pub slices: Read<EndpointSlice>,
    pub config_maps: Read<Named>,
    pub secrets: Read<Named>,
    pub accounts: Read<Named>,
    pub gateway_routes: Vec<crate::resources::RouteInfo>,
    /// Every Gateway in the cluster, or `None` where not all were read.
    pub gateways: Option<Vec<crate::resources::GatewayInfo>>,
    /// This namespace's own Gateways, drawn as its nodes.
    pub gateways_here: Option<Vec<crate::resources::GatewayInfo>>,
    /// The route kinds read here; any other was refused, failed, is still
    /// listing or is not served, and counts nothing.
    pub routes_read: Vec<&'static str>,
    pub gateway_unread: Vec<UnexploredKind>,
    pub taken_at: chrono::DateTime<chrono::Utc>,
}

/// What the map reads beside the lists a [`Snapshot`] holds.
pub struct Beside {
    pub namespace: String,
    pub daemon_sets: Read<DaemonSet>,
    pub jobs: Read<Job>,
    pub cron_jobs: Read<CronJob>,
    pub warnings: Read<Event>,
    pub config_maps: Read<Named>,
    pub secrets: Read<Named>,
    pub accounts: Read<Named>,
    pub gateways_here: Option<Vec<crate::resources::GatewayInfo>>,
    pub routes_read: Vec<&'static str>,
}

/// One namespace drawn: its nodes and edges by id, and how it was read.
#[derive(Debug, Clone)]
pub struct Slice {
    pub nodes: BTreeMap<String, TopologyNode>,
    pub edges: BTreeMap<String, TopologyEdge>,
    pub read: NamespaceRead,
}

/// The kinds drawn only where something on the map uses them.
const USED_ONLY: [&str; 3] = ["ConfigMap", "Secret", "ServiceAccount"];

/// The id of the node every pod nobody owns is folded into.
pub(crate) const OWNERLESS: &str = "*";

struct Workload {
    subject: ObjectRef,
    labels: BTreeMap<String, String>,
    template_labels: BTreeMap<String, String>,
    /// Its metadata, for what it says to a delivery tool.
    meta: kube::core::ObjectMeta,
    /// The template as its pods run it, by [`as_run`].
    spec: Option<PodSpec>,
    owners: Vec<OwnerReference>,
    verdict: NodeVerdict,
    /// Its own pods, as indices into the namespace's pod list.
    own: Vec<usize>,
}

/// The namespace, drawn.
pub fn slice_of(held: Held, now: chrono::DateTime<chrono::Utc>) -> Slice {
    let (snapshot, held) = Snapshot::from_stores(held);
    let ns = held.namespace.as_str();
    let mut out = Neighbourhood::new();
    let mut nodes: BTreeMap<String, TopologyNode> = BTreeMap::new();
    let pods_read = snapshot.pods.is_ok();
    let warnings: Vec<&Event> = held.warnings.iter().flatten().collect();
    let policies = snapshot
        .policies
        .as_ref()
        .ok()
        .map(|list| crate::resources::joined_to_pods(list, snapshot.pods.as_deref().ok()));

    let mut claimed: HashMap<String, String> = HashMap::new();
    let workloads = workloads_of(&held, &snapshot, &warnings, now, &mut claimed);
    for workload in &workloads {
        let template = &workload.template_labels;
        let own: Vec<&Pod> = workload
            .own
            .iter()
            .map(|&at| &snapshot.pods()[at])
            .collect();
        if let Some(spec) = &workload.spec {
            uses_from_spec(ns, &workload.subject, spec, &snapshot.claims, &mut out);
        }
        owned_by(&workload.owners, &workload.subject, ns, &mut out);
        traffic_into(ns, &workload.subject, template, &own, &snapshot, &mut out);
        // A Service that picks one pod by a label only the pod carries, a
        // StatefulSet's per-pod Service, is the template's no more.
        selected_pods(
            ns,
            &workload.subject,
            &own,
            Some(template),
            &snapshot,
            &mut out,
        );
        governed_by(
            ns,
            std::slice::from_ref(&workload.subject),
            &workload.subject,
            template,
            &snapshot,
            &mut out,
        );
        if let Ok(policies) = snapshot.policies.as_ref() {
            for policy in policies {
                let selector = policy.spec.as_ref().and_then(|s| s.pod_selector.as_ref());
                if Selector::Query(selector).matches(template) == Some(true) {
                    out.edge(
                        policy_ref(policy, ns),
                        workload.subject.clone(),
                        Relation::Selects {
                            selector: Selector::Query(selector).says().unwrap_or_default(),
                        },
                    );
                }
            }
        }
        let id = node_id(&workload.subject);
        nodes.insert(
            id.clone(),
            TopologyNode {
                id,
                object: workload.subject.clone(),
                home: Some(ns.to_string()),
                verdict: workload.verdict.clone(),
                app: app_of(&workload.labels).or_else(|| app_of(template)),
                pods: pods_read.then(|| tally(&own)),
                cover: Some(cover_of(template, &snapshot, ns)),
                labels: workload.labels.clone(),
                annotations: crate::resources::annotations_of(&workload.meta),
            },
        );
    }

    for svc in snapshot.services() {
        let svc_ref = service_ref(svc, ns);
        owned_by(svc.owner_references(), &svc_ref, ns, &mut out);
        note_reach(svc, &svc_ref, &snapshot, &mut out, Carry::Named(&[]));
        routes_into(ns, &svc_ref, &snapshot, &mut out);
        gateway_traffic_into(
            ns,
            &svc_ref,
            &snapshot.gateway_routes,
            snapshot.gateways.as_deref(),
            None,
            &mut out,
        );
        let published = out
            .published
            .iter()
            .find(|entry| entry.service.same_object(&svc_ref))
            .cloned()
            .map(|entry| Box::new(entry.summary_keeping(|_| false)));
        let id = node_id(&svc_ref);
        nodes.insert(
            id.clone(),
            TopologyNode {
                id,
                object: svc_ref,
                home: Some(ns.to_string()),
                verdict: NodeVerdict::Service {
                    unread: published
                        .is_none()
                        .then(|| snapshot.published_unread().map(str::to_string))
                        .flatten(),
                    published,
                },
                app: app_of(svc.labels()),
                pods: None,
                cover: None,
                labels: svc.labels().clone(),
                annotations: crate::resources::annotations_of(&svc.metadata),
            },
        );
    }

    for ing in snapshot.ingresses() {
        ingress_edges(ing, ns, &snapshot, &mut out);
        let ing_ref = ingress_ref(ing, ns);
        owned_by(ing.owner_references(), &ing_ref, ns, &mut out);
        let id = node_id(&ing_ref);
        nodes.insert(
            id.clone(),
            TopologyNode {
                id,
                object: ing_ref,
                home: Some(ns.to_string()),
                verdict: NodeVerdict::Ingress {
                    row: Box::new(crate::resources::IngressInfo::from(ing)),
                },
                app: app_of(ing.labels()),
                pods: None,
                cover: None,
                labels: ing.labels().clone(),
                annotations: crate::resources::annotations_of(&ing.metadata),
            },
        );
    }

    for route in snapshot
        .gateway_routes
        .iter()
        .filter(|route| route.namespace == ns)
    {
        let route_ref = ObjectRef::new(
            &route.kind,
            &route.name,
            Some(ns.to_string()),
            Existence::Present,
        )
        .with_group_of(&route.api_version);
        // The map's route takes its verdict from the Routes page's board, class
        // included; its backend reads no classes.
        route_parents(
            route,
            &route_ref,
            snapshot.gateways.as_deref(),
            None,
            &mut out,
        );
        let id = node_id(&route_ref);
        nodes.insert(
            id.clone(),
            TopologyNode {
                id,
                verdict: NodeVerdict::Route {
                    stops: stops_naming(&out.stops, &route_ref),
                    accepted: accepted(route),
                },
                object: route_ref,
                home: Some(ns.to_string()),
                app: app_of(&route.labels),
                pods: None,
                cover: None,
                labels: BTreeMap::new(),
                annotations: BTreeMap::new(),
            },
        );
    }
    for gateway in held.gateways_here.iter().flatten() {
        let gw_ref = gateway_ref(gateway).with_group_of(&gateway.api_version);
        let id = node_id(&gw_ref);
        nodes.insert(
            id.clone(),
            TopologyNode {
                id,
                object: gw_ref,
                home: Some(ns.to_string()),
                verdict: NodeVerdict::Gateway {
                    row: Box::new(gateway.clone()),
                },
                app: None,
                pods: None,
                cover: None,
                labels: BTreeMap::new(),
                annotations: BTreeMap::new(),
            },
        );
    }

    let mut also: Vec<(ObjectRef, NodeVerdict, &kube::core::ObjectMeta)> = Vec::new();
    for claim in snapshot.claims.iter().flatten() {
        also.push((
            claim_ref(claim, ns),
            NodeVerdict::Claim {
                phase: crate::resources::PersistentVolumeClaimInfo::from(claim).status,
            },
            &claim.metadata,
        ));
    }
    for hpa in snapshot.autoscalers.iter().flatten() {
        also.push((
            autoscaler_ref(hpa, ns),
            NodeVerdict::Autoscaler,
            &hpa.metadata,
        ));
    }
    for pdb in snapshot.budgets.iter().flatten() {
        also.push((budget_ref(pdb, ns), NodeVerdict::Budget, &pdb.metadata));
    }
    for (policy, info) in snapshot
        .policies
        .iter()
        .flatten()
        .zip(policies.iter().flatten())
    {
        also.push((
            policy_ref(policy, ns),
            NodeVerdict::Policy {
                selected: info.selected,
            },
            &policy.metadata,
        ));
    }
    for (object, verdict, meta) in also {
        owned_by(
            meta.owner_references.as_deref().unwrap_or_default(),
            &object,
            ns,
            &mut out,
        );
        let app = meta.labels.as_ref().and_then(app_of);
        let id = node_id(&object);
        nodes.insert(
            id.clone(),
            TopologyNode {
                id,
                object,
                home: Some(ns.to_string()),
                verdict,
                app,
                pods: None,
                cover: None,
                labels: meta.labels.clone().unwrap_or_default(),
                annotations: crate::resources::annotations_of(meta),
            },
        );
    }

    folded_owners(&held, &snapshot, &claimed, &mut nodes, &mut out);
    resolve_named(&mut out.edges, &held);
    let edges = edges_of(&out.edges);
    named_nodes(&edges, &out.edges, &held, &mut nodes);
    borrow_apps(&edges, &mut nodes);

    Slice {
        read: NamespaceRead {
            namespace: ns.to_string(),
            counts: counts_of(&snapshot, &held, &nodes),
            not_looked_at: not_looked_at(&held, &snapshot),
        },
        nodes,
        edges,
    }
}

/// Every workload in the namespace with its own pods claimed by uid, as its
/// page claims them. A Job a listed `CronJob` controls is folded into it.
fn workloads_of(
    held: &Beside,
    snapshot: &Snapshot,
    warnings: &[&Event],
    now: chrono::DateTime<chrono::Utc>,
    claimed: &mut HashMap<String, String>,
) -> Vec<Workload> {
    let ns = held.namespace.as_str();
    let mut found = Vec::new();
    let pods_read = snapshot.pods.is_ok();
    // Each workload's candidates by the uids it owns through, not the whole
    // namespace each time: a namespace of thousands of pods and a hundred
    // workloads was a hundred passes over every pod.
    let mut by_owner: HashMap<&str, Vec<usize>> = HashMap::new();
    for (at, pod) in snapshot.pods().iter().enumerate() {
        for owner in pod.owner_references() {
            by_owner.entry(owner.uid.as_str()).or_default().push(at);
        }
    }
    let mut add = |kind: &str,
                   meta: &kube::core::ObjectMeta,
                   template: kinds::Template,
                   owners: crate::resources::Owners<'_>,
                   verdict: Option<NodeVerdict>,
                   claimed: &mut HashMap<String, String>| {
        let selector = Selector::Query(template.selector.as_ref());
        // A CronJob states no selector: its pods are its Jobs', by uid.
        let candidates: std::collections::BTreeSet<usize> = match &owners {
            crate::resources::Owners::Uids(uids) => uids
                .iter()
                .filter_map(|uid| by_owner.get(uid))
                .flatten()
                .copied()
                .collect(),
            crate::resources::Owners::Named(_) => (0..snapshot.pods().len()).collect(),
        };
        let own_at: Vec<usize> = candidates
            .into_iter()
            .filter(|&at| {
                let pod = &snapshot.pods()[at];
                (template.selector.is_none() || selector.matches(pod.labels()) == Some(true))
                    && crate::resources::runs_for(pod, &owners)
            })
            .collect();
        let own: Vec<&Pod> = own_at.iter().map(|&at| &snapshot.pods()[at]).collect();
        let uid = meta.uid.clone();
        for pod in &own {
            if let (Some(pod_uid), Some(uid)) = (&pod.metadata.uid, &uid) {
                claimed.insert(pod_uid.clone(), uid.clone());
            }
        }
        let rollout = template.rollout.clone().map(|rollout| {
            if !pods_read || selector.query_text().is_none() {
                return rollout.pods_unread();
            }
            let warned: std::collections::HashSet<&str> =
                crate::commands::overview::warned_pods(own.iter().copied(), warnings, now)
                    .into_iter()
                    .filter_map(|(pod, _)| pod.metadata.uid.as_deref())
                    .collect();
            crate::resources::with_pods_warned(rollout, own.iter().copied(), &warned, now)
        });
        let subject = ObjectRef::new(
            kind,
            meta.name.as_deref().unwrap_or_default(),
            Some(ns.to_string()),
            Existence::Present,
        )
        .with_facts(ObjectFacts::Workload {
            replicas: template.replicas,
            ready_replicas: template.ready_replicas,
            rollout: rollout.clone(),
            revision: None,
            current: None,
            pods_refused: None,
        });
        let verdict = verdict
            .or_else(|| rollout.map(|rollout| NodeVerdict::Rollout { rollout }))
            .unwrap_or(NodeVerdict::Replicas {
                ready: template.ready_replicas,
                desired: template.replicas,
            });
        found.push(Workload {
            subject,
            labels: meta.labels.clone().unwrap_or_default(),
            meta: meta.clone(),
            spec: template
                .spec
                .as_ref()
                .map(|spec| as_run(spec, &template.claims)),
            owners: template.owners.clone(),
            template_labels: template.labels,
            verdict,
            own: own_at,
        });
    };

    for d in snapshot.deployments.iter().flatten() {
        let owners = crate::resources::Owners::of_deployment(
            d.metadata.name.as_deref().unwrap_or_default(),
            d.metadata.uid.as_deref(),
            snapshot.replica_sets.as_deref().ok(),
        );
        add(
            "Deployment",
            &d.metadata,
            kinds::Template::of_deployment(d),
            owners,
            None,
            claimed,
        );
    }
    for set in snapshot.stateful_sets.iter().flatten() {
        let owners = crate::resources::Owners::of(set.metadata.uid.as_deref());
        add(
            "StatefulSet",
            &set.metadata,
            kinds::Template::of_stateful_set(set),
            owners,
            None,
            claimed,
        );
    }
    for set in held.daemon_sets.iter().flatten() {
        let owners = crate::resources::Owners::of(set.metadata.uid.as_deref());
        add(
            "DaemonSet",
            &set.metadata,
            kinds::Template::of_daemon_set(set),
            owners,
            None,
            claimed,
        );
    }
    let crons: HashMap<&str, &CronJob> = held
        .cron_jobs
        .iter()
        .flatten()
        .filter_map(|cron| Some((cron.metadata.uid.as_deref()?, cron)))
        .collect();
    let mut cron_jobs: HashMap<String, Vec<String>> = HashMap::new();
    for job in held.jobs.iter().flatten() {
        let cron =
            controller_of(&job.metadata).filter(|owner| crons.contains_key(owner.uid.as_str()));
        if let (Some(cron), Some(uid)) = (cron, &job.metadata.uid) {
            cron_jobs
                .entry(cron.uid.clone())
                .or_default()
                .push(uid.clone());
            continue;
        }
        let owners = crate::resources::Owners::of(job.metadata.uid.as_deref());
        let status = crate::resources::JobInfo::from(job).status;
        add(
            "Job",
            &job.metadata,
            kinds::Template::of_job(job),
            owners,
            Some(NodeVerdict::Job { status }),
            claimed,
        );
    }
    for cron in held.cron_jobs.iter().flatten() {
        let jobs: Vec<&str> = cron
            .metadata
            .uid
            .as_ref()
            .and_then(|uid| cron_jobs.get(uid))
            .map(|jobs| jobs.iter().map(String::as_str).collect())
            .unwrap_or_default();
        let suspend = cron.spec.as_ref().and_then(|s| s.suspend).unwrap_or(false);
        add(
            "CronJob",
            &cron.metadata,
            kinds::Template::of_cron_job(cron),
            crate::resources::Owners::Uids(jobs),
            Some(NodeVerdict::CronJob { suspend }),
            claimed,
        );
    }
    let deployments: Vec<&str> = snapshot
        .deployments
        .iter()
        .flatten()
        .filter_map(|d| d.metadata.uid.as_deref())
        .collect();
    for rs in snapshot.replica_sets.iter().flatten() {
        if controller_of(&rs.metadata)
            .is_some_and(|owner| deployments.contains(&owner.uid.as_str()))
        {
            continue;
        }
        let owners = crate::resources::Owners::of(rs.metadata.uid.as_deref());
        add(
            "ReplicaSet",
            &rs.metadata,
            kinds::Template::of_replica_set(rs),
            owners,
            None,
            claimed,
        );
    }
    found
}

/// Every owner an object names, as the first step of the Connections tab's walk.
fn owned_by(owners: &[OwnerReference], child: &ObjectRef, ns: &str, out: &mut Neighbourhood) {
    for owner in owners {
        out.edge(
            owner_ref(owner, ns),
            child.clone(),
            Relation::Owns {
                controller: owner.controller.unwrap_or(false),
            },
        );
    }
}

/// The owner reference marked controller.
fn controller_of(meta: &kube::core::ObjectMeta) -> Option<&OwnerReference> {
    meta.owner_references
        .iter()
        .flatten()
        .find(|owner| owner.controller.unwrap_or(false))
}

fn tally(pods: &[&Pod]) -> PodTally {
    PodTally {
        total: pods.len(),
        ready: pods
            .iter()
            .filter(|pod| crate::resources::counts_ready(pod))
            .count(),
    }
}

/// The pods counted by the status the Pods list prints for each.
fn statuses_of(pods: &[&Pod]) -> Vec<PodStatusTally> {
    let mut by: BTreeMap<String, PodTally> = BTreeMap::new();
    for pod in pods {
        let held = by
            .entry(crate::resources::display_status(pod))
            .or_insert(PodTally { total: 0, ready: 0 });
        held.total += 1;
        held.ready += usize::from(crate::resources::counts_ready(pod));
    }
    by.into_iter()
        .map(|(status, held)| PodStatusTally {
            status,
            total: held.total,
            ready: held.ready,
        })
        .collect()
}

/// The Services, budgets and policies that pick `target`'s pods by the pods'
/// own labels. With a `template`, only what it does not already match, and
/// only Services: the rest were drawn from it.
fn selected_pods(
    ns: &str,
    target: &ObjectRef,
    pods: &[&Pod],
    template: Option<&BTreeMap<String, String>>,
    snapshot: &Snapshot,
    out: &mut Neighbourhood,
) {
    let mut seen: Vec<&BTreeMap<String, String>> = Vec::new();
    for labels in pods.iter().map(|pod| pod.labels()) {
        if seen.contains(&labels) {
            continue;
        }
        seen.push(labels);
        for svc in snapshot.services() {
            let selector = service_selector(svc);
            let picks = |labels| Selector::Equality(&selector).matches(labels) == Some(true);
            let Some(text) = Selector::Equality(&selector).says() else {
                continue;
            };
            if picks(labels) && !template.is_some_and(picks) {
                out.edge(
                    service_ref(svc, ns),
                    target.clone(),
                    Relation::Selects { selector: text },
                );
            }
        }
        if template.is_some() {
            continue;
        }
        governed_by(
            ns,
            std::slice::from_ref(target),
            target,
            labels,
            snapshot,
            out,
        );
        for policy in snapshot.policies.as_deref().unwrap_or_default() {
            let selector = policy.spec.as_ref().and_then(|s| s.pod_selector.as_ref());
            if Selector::Query(selector).matches(labels) == Some(true) {
                out.edge(
                    policy_ref(policy, ns),
                    target.clone(),
                    Relation::Selects {
                        selector: Selector::Query(selector).says().unwrap_or_default(),
                    },
                );
            }
        }
    }
}

fn policy_ref(policy: &NetworkPolicy, ns: &str) -> ObjectRef {
    ObjectRef::new(
        "NetworkPolicy",
        &policy.name_any(),
        Some(ns.to_string()),
        Existence::Present,
    )
}

/// Which policies select pods carrying `labels`, by the matcher the
/// `NetworkPolicy` list counts with. "None selects it" only where every
/// engine that could was read.
fn cover_of(labels: &BTreeMap<String, String>, snapshot: &Snapshot, ns: &str) -> PolicyCover {
    let policies = match &snapshot.policies {
        Ok(policies) => policies,
        Err(unread) => {
            return PolicyCover::Unread {
                said: unread.said.clone(),
            }
        }
    };
    let mut covered = Vec::new();
    let mut unreadable = Vec::new();
    for policy in policies {
        let selector = policy.spec.as_ref().and_then(|s| s.pod_selector.as_ref());
        match Selector::Query(selector).matches(labels) {
            Some(true) => covered.push(policy.name_any()),
            Some(false) => {}
            None => unreadable.push(policy.name_any()),
        }
    }
    if !covered.is_empty() {
        return PolicyCover::Covered { policies: covered };
    }
    let kinds = snapshot.others.over(ns);
    if kinds.is_empty() && unreadable.is_empty() {
        PolicyCover::None
    } else {
        PolicyCover::Unknown { kinds, unreadable }
    }
}

/// What an Ingress names, as its own Connections tab draws it.
fn ingress_edges(ing: &Ingress, ns: &str, snapshot: &Snapshot, out: &mut Neighbourhood) {
    let subject = ingress_ref(ing, ns);
    for tls in ing.spec.iter().flat_map(|spec| spec.tls.iter().flatten()) {
        let Some(secret) = &tls.secret_name else {
            continue;
        };
        out.edge(
            subject.clone(),
            ObjectRef::unchecked("Secret", secret, Some(ns.to_string())),
            Relation::Uses {
                usages: vec![Usage::IngressTls {
                    hosts: tls.hosts.clone().unwrap_or_default(),
                }],
            },
        );
    }
    for (backend, relation) in ingress_backends(ing) {
        match backend {
            Backend::Service(service) => {
                let to = match snapshot.services().iter().find(|s| s.name_any() == service) {
                    Some(svc) => service_ref(svc, ns),
                    None => absent_backend(&service, ns, snapshot.services.is_ok()).0,
                };
                out.edge(subject.clone(), to, relation);
            }
            Backend::Resource { kind, name } => out.edge(
                subject.clone(),
                ObjectRef::unchecked(&kind, &name, Some(ns.to_string())),
                relation,
            ),
        }
    }
}

/// The stops a route's own status names.
fn stops_naming(stops: &[ChainStop], route: &ObjectRef) -> Vec<ChainStop> {
    let mut found: Vec<ChainStop> = Vec::new();
    for stop in stops {
        let about_it = match stop {
            ChainStop::RouteNotAccepted { route: of, .. }
            | ChainStop::RouteRefsUnresolved { route: of, .. }
            | ChainStop::GatewayMissing { route: of, .. }
            | ChainStop::GatewayNotProgrammed { route: of, .. } => of.same_object(route),
            _ => false,
        };
        let text = serde_json::to_string(stop).unwrap_or_default();
        if about_it
            && !found
                .iter()
                .any(|held| serde_json::to_string(held).unwrap_or_default() == text)
        {
            found.push(stop.clone());
        }
    }
    found
}

/// Whether every parent accepted the route: `None` where one has not said.
fn accepted(route: &crate::resources::RouteInfo) -> Option<bool> {
    use crate::resources::{verdict_of, Verdict};
    let mut all = Some(true);
    for parent in &route.parent_refs {
        match verdict_of(&route.statuses_for(parent), "Accepted") {
            Verdict::False(_) => return Some(false),
            Verdict::True(_) => {}
            Verdict::None | Verdict::Undecided | Verdict::Pending(_) => all = None,
        }
    }
    all
}

/// The pods no drawn workload claims, folded into what their controller
/// reference names, or into one node for those that name none.
fn folded_owners(
    held: &Beside,
    snapshot: &Snapshot,
    claimed: &HashMap<String, String>,
    nodes: &mut BTreeMap<String, TopologyNode>,
    out: &mut Neighbourhood,
) {
    if snapshot.pods.is_err() {
        return;
    }
    let ns = held.namespace.as_str();
    let mut owners: BTreeMap<String, (ObjectRef, Vec<&Pod>)> = BTreeMap::new();
    for pod in snapshot.pods() {
        if pod
            .metadata
            .uid
            .as_ref()
            .is_some_and(|uid| claimed.contains_key(uid))
        {
            continue;
        }
        let owner = match controller_of(&pod.metadata) {
            Some(owner) => owner_ref(owner, ns),
            None => ObjectRef::new("Pod", OWNERLESS, Some(ns.to_string()), Existence::Present),
        };
        let id = node_id(&owner);
        owners
            .entry(id)
            .or_insert_with(|| (owner, Vec::new()))
            .1
            .push(pod);
    }
    for (id, (owner, pods)) in owners {
        if let Some(node) = nodes.get_mut(&id) {
            node.pods = Some(tally(&pods));
            continue;
        }
        // No template states what these pods use, or what picks them; each
        // pod's own spec and labels do.
        for spec in pods.iter().filter_map(|pod| pod.spec.as_ref()) {
            uses_from_spec(ns, &owner, spec, &snapshot.claims, out);
        }
        selected_pods(ns, &owner, &pods, None, snapshot, out);
        // ponytail: the first pod's labels stand for an owner's pods, which
        // share them; per-pod covers if an owner's pods ever differ.
        let cover = pods.first().map(|pod| cover_of(pod.labels(), snapshot, ns));
        let verdict = if owner.name == OWNERLESS {
            NodeVerdict::Ownerless {
                statuses: statuses_of(&pods),
            }
        } else {
            NodeVerdict::Owner
        };
        nodes.insert(
            id.clone(),
            TopologyNode {
                id,
                object: owner,
                home: Some(ns.to_string()),
                verdict,
                app: None,
                pods: Some(tally(&pods)),
                cover,
                labels: BTreeMap::new(),
                annotations: BTreeMap::new(),
            },
        );
    }
}

/// The names a spec states, looked up in the held lists: a list that answered
/// says present or missing, one that did not leaves it not checked.
pub(crate) fn resolve_named(edges: &mut [ConnectionEdge], held: &Beside) {
    for edge in edges {
        let list = match edge.to.kind.as_str() {
            "ConfigMap" => &held.config_maps,
            "Secret" => &held.secrets,
            "ServiceAccount" => &held.accounts,
            _ => continue,
        };
        if edge.to.existence != Existence::NotChecked {
            continue;
        }
        edge.to.existence = match list {
            Ok(names) if names.iter().any(|named| named.name == edge.to.name) => Existence::Present,
            Ok(_) => Existence::Missing,
            Err(_) => Existence::NotChecked,
        };
    }
}

/// Edges by id, one per pair of objects and verb.
fn edges_of(edges: &[ConnectionEdge]) -> BTreeMap<String, TopologyEdge> {
    let mut out: BTreeMap<String, TopologyEdge> = BTreeMap::new();
    for edge in edges {
        let (from, to) = (node_id(&edge.from), node_id(&edge.to));
        let id = format!("{from}>{}>{to}", verb_of(&edge.relation));
        let entry = out.entry(id.clone()).or_insert_with(|| TopologyEdge {
            id,
            from,
            to,
            relations: Vec::new(),
        });
        let text = serde_json::to_string(&edge.relation).unwrap_or_default();
        if !entry
            .relations
            .iter()
            .any(|held| serde_json::to_string(held).unwrap_or_default() == text)
        {
            entry.relations.push(edge.relation.clone());
        }
    }
    out
}

/// A node for every end an edge names that no list drew: a named `ConfigMap`,
/// a missing backend, a Gateway in another namespace, an owner never read.
fn named_nodes(
    edges: &BTreeMap<String, TopologyEdge>,
    raw: &[ConnectionEdge],
    held: &Beside,
    nodes: &mut BTreeMap<String, TopologyNode>,
) {
    let _ = edges;
    for edge in raw {
        let owns = matches!(edge.relation, Relation::Owns { .. });
        for (end, owner) in [(&edge.from, owns), (&edge.to, false)] {
            let id = node_id(end);
            if nodes.contains_key(&id) {
                continue;
            }
            let labels = named_labels(held, &end.kind, &end.name);
            nodes.insert(
                id.clone(),
                TopologyNode {
                    id,
                    object: end.clone(),
                    home: Some(
                        end.namespace
                            .clone()
                            .unwrap_or_else(|| held.namespace.clone()),
                    ),
                    verdict: if owner {
                        NodeVerdict::Owner
                    } else {
                        NodeVerdict::Exists
                    },
                    app: labels.and_then(app_of),
                    pods: None,
                    cover: None,
                    labels: labels.cloned().unwrap_or_default(),
                    annotations: BTreeMap::new(),
                },
            );
        }
    }
}

fn named_labels<'a>(
    held: &'a Beside,
    kind: &str,
    name: &str,
) -> Option<&'a BTreeMap<String, String>> {
    let list = match kind {
        "ConfigMap" => &held.config_maps,
        "Secret" => &held.secrets,
        "ServiceAccount" => &held.accounts,
        _ => return None,
    };
    list.as_ref()
        .ok()?
        .iter()
        .find(|named| named.name == name)
        .map(|named| &named.labels)
}

/// An object with no app label of its own takes the one its neighbours agree on.
fn borrow_apps(edges: &BTreeMap<String, TopologyEdge>, nodes: &mut BTreeMap<String, TopologyNode>) {
    let mut borrowed: Vec<(String, String)> = Vec::new();
    for (id, node) in nodes.iter() {
        if node.app.is_some() {
            continue;
        }
        let apps: std::collections::BTreeSet<&String> = edges
            .values()
            .filter_map(|edge| {
                let other = if &edge.to == id {
                    &edge.from
                } else if &edge.from == id {
                    &edge.to
                } else {
                    return None;
                };
                nodes.get(other)?.app.as_ref()
            })
            .collect();
        if let [only] = apps.into_iter().collect::<Vec<_>>().as_slice() {
            borrowed.push((id.clone(), (*only).clone()));
        }
    }
    for (id, app) in borrowed {
        if let Some(node) = nodes.get_mut(&id) {
            node.app = Some(app);
        }
    }
}

fn counts_of(
    snapshot: &Snapshot,
    held: &Beside,
    nodes: &BTreeMap<String, TopologyNode>,
) -> Vec<MapKindCount> {
    fn listed<K>(list: &Read<K>) -> Option<usize> {
        list.as_ref().ok().map(Vec::len)
    }
    let drawn = |kind: &str| {
        nodes
            .values()
            .filter(|node| node.object.kind == kind && node.object.existence == Existence::Present)
            .count()
    };
    let count = |kind: &str, count: Option<usize>| MapKindCount {
        kind: kind.to_string(),
        used: USED_ONLY.contains(&kind).then(|| drawn(kind)),
        count,
    };
    let routes = |kind: &str| -> Option<usize> {
        held.routes_read.contains(&kind).then(|| {
            snapshot
                .gateway_routes
                .iter()
                .filter(|r| r.kind == kind && r.namespace == held.namespace)
                .count()
        })
    };
    vec![
        count("Ingress", listed(&snapshot.ingresses)),
        count("HTTPRoute", routes("HTTPRoute")),
        count("GRPCRoute", routes("GRPCRoute")),
        count("TLSRoute", routes("TLSRoute")),
        count("TCPRoute", routes("TCPRoute")),
        count("UDPRoute", routes("UDPRoute")),
        count("Service", listed(&snapshot.services)),
        count("Deployment", listed(&snapshot.deployments)),
        count("StatefulSet", listed(&snapshot.stateful_sets)),
        count("DaemonSet", listed(&held.daemon_sets)),
        count("Job", listed(&held.jobs)),
        count("CronJob", listed(&held.cron_jobs)),
        count("Pod", listed(&snapshot.pods)),
        count("PersistentVolumeClaim", listed(&snapshot.claims)),
        count("HorizontalPodAutoscaler", listed(&snapshot.autoscalers)),
        count("PodDisruptionBudget", listed(&snapshot.budgets)),
        count(
            "NetworkPolicy",
            snapshot.policies.as_ref().ok().map(Vec::len),
        ),
        count("ConfigMap", listed(&held.config_maps)),
        // Helm's release Secrets are left out of the read, so the whole is not known.
        MapKindCount {
            kind: "Secret".to_string(),
            count: None,
            used: held.secrets.is_ok().then(|| drawn("Secret")),
        },
        count("ServiceAccount", listed(&held.accounts)),
    ]
}

fn not_looked_at(held: &Beside, snapshot: &Snapshot) -> Vec<UnexploredKind> {
    let mut unread = unanswered(snapshot);
    for (kind, version, why) in [
        ("Deployment", "apps/v1", snapshot.deployments.as_ref().err()),
        (
            "StatefulSet",
            "apps/v1",
            snapshot.stateful_sets.as_ref().err(),
        ),
        ("DaemonSet", "apps/v1", held.daemon_sets.as_ref().err()),
        (
            "ReplicaSet",
            "apps/v1",
            snapshot.replica_sets.as_ref().err(),
        ),
        ("Job", "batch/v1", held.jobs.as_ref().err()),
        ("CronJob", "batch/v1", held.cron_jobs.as_ref().err()),
        ("Event", "v1", held.warnings.as_ref().err()),
        ("ConfigMap", "v1", held.config_maps.as_ref().err()),
        ("Secret", "v1", held.secrets.as_ref().err()),
        ("ServiceAccount", "v1", held.accounts.as_ref().err()),
    ] {
        if let Some(why) = why {
            unread.push(UnexploredKind::unanswered(kind, version, why));
        }
    }
    unread
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resources::Rollout;
    use serde_json::json;

    const REFUSED: &str = "secrets is forbidden: User \"narrow\" cannot list resource \"secrets\" in the namespace \"shop\"";

    fn of<K: serde::de::DeserializeOwned>(value: serde_json::Value) -> K {
        serde_json::from_value(value).expect("a valid object")
    }

    fn held() -> Held {
        Held {
            namespace: "shop".into(),
            pods: Ok(Vec::new()),
            services: Ok(Vec::new()),
            ingresses: Ok(Vec::new()),
            claims: Ok(Vec::new()),
            autoscalers: Ok(Vec::new()),
            budgets: Ok(Vec::new()),
            deployments: Ok(Vec::new()),
            stateful_sets: Ok(Vec::new()),
            daemon_sets: Ok(Vec::new()),
            replica_sets: Ok(Vec::new()),
            jobs: Ok(Vec::new()),
            cron_jobs: Ok(Vec::new()),
            warnings: Ok(Vec::new()),
            policies: Ok(Vec::new()),
            others: crate::resources::OtherPolicies::none(),
            slices: Ok(Vec::new()),
            config_maps: Ok(Vec::new()),
            secrets: Ok(Vec::new()),
            accounts: Ok(Vec::new()),
            gateway_routes: Vec::new(),
            gateways: None,
            gateways_here: None,
            routes_read: Vec::new(),
            gateway_unread: Vec::new(),
            taken_at: chrono::Utc::now(),
        }
    }

    fn named(name: &str) -> Named {
        Named {
            namespace: "shop".into(),
            name: name.into(),
            labels: BTreeMap::new(),
        }
    }

    /// `cart`: four asked for, three ready, its pods made by `rs`, reading a
    /// `ConfigMap` as a volume and a Secret through the environment.
    fn cart(replicas: i32) -> Deployment {
        of(json!({
            "metadata": { "name": "cart", "namespace": "shop", "uid": "cart", "generation": 3,
                          "labels": { "app.kubernetes.io/part-of": "shop" } },
            "spec": {
                "replicas": replicas,
                "selector": { "matchLabels": { "app": "web" } },
                "template": {
                    "metadata": { "labels": { "app": "web" } },
                    "spec": {
                        "serviceAccountName": "cart",
                        "volumes": [{ "name": "cfg", "configMap": { "name": "cart-config" } }],
                        "containers": [{
                            "name": "web",
                            "volumeMounts": [{ "name": "cfg", "mountPath": "/etc/cart" }],
                            "env": [{ "name": "TOKEN", "valueFrom": { "secretKeyRef": { "name": "cart-token", "key": "token" } } }],
                        }],
                    },
                },
            },
            "status": {
                "observedGeneration": 3, "replicas": replicas, "updatedReplicas": replicas,
                "readyReplicas": replicas.min(3), "availableReplicas": replicas.min(3),
                "conditions": [
                    { "type": "Available", "status": "True", "reason": "MinimumReplicasAvailable" },
                    { "type": "Progressing", "status": "True", "reason": "NewReplicaSetAvailable" },
                ],
            },
        }))
    }

    fn replica_set() -> ReplicaSet {
        of(json!({
            "metadata": { "name": "cart-9df89489c", "namespace": "shop", "uid": "rs",
                          "ownerReferences": [{ "apiVersion": "apps/v1", "kind": "Deployment",
                                                "name": "cart", "uid": "cart", "controller": true }] },
            "spec": { "selector": { "matchLabels": { "app": "web" } } },
        }))
    }

    fn pod(name: &str, ready: bool, waiting: &str, owner: Option<serde_json::Value>) -> Pod {
        let mut pod = json!({
            "metadata": {
                "name": name, "namespace": "shop", "uid": format!("uid-{name}"),
                "labels": { "app": "web" },
                "creationTimestamp": (chrono::Utc::now() - chrono::Duration::seconds(5)).to_rfc3339(),
            },
            "status": {
                "phase": if ready { "Running" } else { "Pending" },
                "conditions": [{ "type": "Ready", "status": if ready { "True" } else { "False" } }],
                "containerStatuses": [{
                    "name": "web", "image": "web", "imageID": "", "ready": ready, "restartCount": 0,
                    "state": if ready { json!({ "running": {} }) } else { json!({ "waiting": { "reason": waiting } }) },
                }],
            },
        });
        if let Some(owner) = owner {
            pod["metadata"]["ownerReferences"] = json!([owner]);
        }
        of(pod)
    }

    fn by_rs(name: &str, ready: bool, waiting: &str) -> Pod {
        pod(
            name,
            ready,
            waiting,
            Some(
                json!({ "apiVersion": "apps/v1", "kind": "ReplicaSet", "name": "cart-9df89489c", "uid": "rs", "controller": true }),
            ),
        )
    }

    fn service(name: &str) -> Service {
        of(json!({
            "metadata": { "name": name, "namespace": "shop" },
            "spec": { "selector": { "app": "web" }, "ports": [{ "port": 80 }] },
        }))
    }

    fn shop(waiting: &str) -> Held {
        Held {
            deployments: Ok(vec![cart(4)]),
            replica_sets: Ok(vec![replica_set()]),
            pods: Ok(vec![
                by_rs("cart-a", true, ""),
                by_rs("cart-b", true, ""),
                by_rs("cart-c", true, ""),
                by_rs("cart-d", false, waiting),
            ]),
            services: Ok(vec![service("web")]),
            config_maps: Ok(vec![named("cart-config")]),
            secrets: Ok(vec![named("cart-token")]),
            accounts: Ok(vec![named("cart")]),
            ..held()
        }
    }

    const CART: &str = "apps/Deployment/shop/cart";
    const WEB: &str = "/Service/shop/web";

    fn edge<'a>(slice: &'a Slice, from: &str, verb: &str, to: &str) -> Option<&'a TopologyEdge> {
        slice.edges.get(&format!("{from}>{verb}>{to}"))
    }

    fn rollout(slice: &Slice) -> Rollout {
        match &slice.nodes[CART].verdict {
            NodeVerdict::Rollout { rollout } => rollout.clone(),
            other => panic!("a rollout, not {other:?}"),
        }
    }

    /// The map's colour for a workload is its own page's verdict, its pods
    /// asked: a pod still being made reads "coming up" on the Deployment's
    /// page, and the controller's counts alone would say "short". Fails if
    /// the map reads the controller alone, or claims its pods differently
    /// from `with_pods_warned` given the same pods.
    #[test]
    fn a_workload_on_the_map_reads_the_verdict_its_page_reads_from_the_same_pods() {
        let now = chrono::Utc::now();
        let held = shop("ContainerCreating");
        let pods: Vec<Pod> = held.pods.clone().expect("pods");
        let page = crate::resources::with_pods_warned(
            crate::resources::deployment_rollout(&cart(4)),
            pods.iter(),
            &std::collections::HashSet::new(),
            now,
        );
        let map = rollout(&slice_of(held, now));
        assert_eq!(map, page);
        assert_eq!(
            map,
            Rollout::ComingUp {
                available: 3,
                desired: 4
            }
        );
        assert_ne!(map, crate::resources::deployment_rollout(&cart(4)));

        assert_eq!(
            rollout(&slice_of(shop("ImagePullBackOff"), now)),
            Rollout::Short {
                available: 3,
                desired: 4
            }
        );
    }

    /// A namespace whose pods nobody could list has no pod counts: a zero
    /// beside a workload reads as "it runs nothing". Fails if a refused pod
    /// list tallies, or if the verdict stops saying its pods went unread.
    #[test]
    fn a_namespace_whose_pods_were_refused_counts_no_pods_and_says_so_on_the_verdict() {
        let slice = slice_of(
            Held {
                pods: Err(REFUSED.into()),
                ..shop("")
            },
            chrono::Utc::now(),
        );
        assert_eq!(slice.nodes[CART].pods, None);
        assert!(matches!(rollout(&slice), Rollout::PodsUnread { .. }));
        assert!(slice
            .read
            .not_looked_at
            .iter()
            .any(|entry| entry.kind == "Pod"));
    }

    /// The pods are folded, never drawn: the Deployment carries its four, and
    /// no node is a pod.
    #[test]
    fn pods_fold_into_the_deployment_their_replica_set_belongs_to() {
        let slice = slice_of(shop("ContainerCreating"), chrono::Utc::now());
        assert_eq!(
            slice.nodes[CART].pods,
            Some(PodTally { total: 4, ready: 3 })
        );
        assert!(slice
            .nodes
            .values()
            .all(|node| node.object.kind != "Pod" && node.object.kind != "ReplicaSet"));
    }

    /// Pods a custom resource made are one node per owner, never read and
    /// said so; pods nothing owns are one node for the namespace.
    #[test]
    fn pods_no_drawn_workload_claims_are_one_node_per_owner() {
        let slice = slice_of(
            Held {
                pods: Ok(vec![
                    pod(
                        "db-1",
                        true,
                        "",
                        Some(
                            json!({ "apiVersion": "postgresql.cnpg.io/v1", "kind": "Cluster", "name": "db", "uid": "db", "controller": true }),
                        ),
                    ),
                    pod(
                        "db-2",
                        false,
                        "ContainerCreating",
                        Some(
                            json!({ "apiVersion": "postgresql.cnpg.io/v1", "kind": "Cluster", "name": "db", "uid": "db", "controller": true }),
                        ),
                    ),
                    pod("debug", true, "", None),
                    pod("shell", true, "", None),
                ]),
                ..held()
            },
            chrono::Utc::now(),
        );
        let cluster = &slice.nodes["postgresql.cnpg.io/Cluster/shop/db"];
        assert!(matches!(cluster.verdict, NodeVerdict::Owner));
        assert_eq!(cluster.object.existence, Existence::NotChecked);
        assert_eq!(cluster.pods, Some(PodTally { total: 2, ready: 1 }));
        let ownerless = &slice.nodes[&format!("/Pod/shop/{OWNERLESS}")];
        assert_eq!(ownerless.pods, Some(PodTally { total: 2, ready: 2 }));
        assert_eq!(slice.nodes.len(), 2);
    }

    /// A Service in front of pods a custom resource made, and the budget and
    /// policy over them, floated unattached: only a template's labels were
    /// matched, and a CNPG `Cluster` has none. Fails if what picks folded
    /// pods by their own labels draws no edge to their owner.
    #[test]
    fn what_picks_pods_a_custom_resource_made_is_drawn_to_their_owner() {
        let owner = json!({ "apiVersion": "postgresql.cnpg.io/v1", "kind": "Cluster", "name": "db", "uid": "db", "controller": true });
        let slice = slice_of(
            Held {
                pods: Ok(vec![pod("db-1", true, "", Some(owner))]),
                services: Ok(vec![service("web")]),
                budgets: Ok(vec![of(json!({
                    "metadata": { "name": "db", "namespace": "shop" },
                    "spec": { "selector": { "matchLabels": { "app": "web" } }, "minAvailable": 1 },
                }))]),
                policies: Ok(vec![of(json!({
                    "metadata": { "name": "only-web", "namespace": "shop" },
                    "spec": { "podSelector": { "matchLabels": { "app": "web" } } },
                }))]),
                ..held()
            },
            chrono::Utc::now(),
        );
        let db = "postgresql.cnpg.io/Cluster/shop/db";
        assert!(
            edge(&slice, WEB, "selects", db).is_some(),
            "{:?}",
            slice.edges.keys()
        );
        assert!(
            edge(&slice, "policy/PodDisruptionBudget/shop/db", "governs", db).is_some(),
            "{:?}",
            slice.edges.keys()
        );
        assert!(
            edge(
                &slice,
                "networking.k8s.io/NetworkPolicy/shop/only-web",
                "selects",
                db
            )
            .is_some(),
            "{:?}",
            slice.edges.keys()
        );
        assert!(matches!(
            slice.nodes[db].cover,
            Some(PolicyCover::Covered { .. })
        ));
    }

    /// A `StatefulSet`'s per-pod Service picks one pod by a label only that pod
    /// carries, and the map drew it selecting nothing. Fails if a Service
    /// that picks a workload's own pod, and not its template, draws no edge.
    #[test]
    fn a_service_that_picks_one_of_a_workload_s_pods_is_drawn_to_the_workload() {
        let mut first = by_rs("cart-a", true, "");
        first
            .metadata
            .labels
            .get_or_insert_with(BTreeMap::new)
            .insert("pod".into(), "cart-a".into());
        let one: Service = of(json!({
            "metadata": { "name": "cart-a", "namespace": "shop" },
            "spec": { "selector": { "pod": "cart-a" }, "ports": [{ "port": 80 }] },
        }));
        let slice = slice_of(
            Held {
                pods: Ok(vec![first, by_rs("cart-b", true, "")]),
                services: Ok(vec![service("web"), one]),
                ..shop("")
            },
            chrono::Utc::now(),
        );
        assert!(
            edge(&slice, "/Service/shop/cart-a", "selects", CART).is_some(),
            "{:?}",
            slice.edges.keys()
        );
        assert!(edge(&slice, WEB, "selects", CART).is_some());
    }

    /// "Pods with no owner" read "not read" with the not-checked ring, on a
    /// cluster whose pods were read. Fails if the node stops saying what the
    /// Pods list says of each pod, or claims it was not read.
    #[test]
    fn pods_no_controller_claims_say_their_statuses_and_readiness() {
        let slice = slice_of(
            Held {
                pods: Ok(vec![
                    pod("debug", true, "", None),
                    pod("shell", false, "CrashLoopBackOff", None),
                    pod("tool", true, "", None),
                ]),
                ..held()
            },
            chrono::Utc::now(),
        );
        let ownerless = &slice.nodes[&format!("/Pod/shop/{OWNERLESS}")];
        assert_eq!(ownerless.object.existence, Existence::Present);
        let NodeVerdict::Ownerless { statuses } = &ownerless.verdict else {
            panic!("{:?}", ownerless.verdict);
        };
        assert_eq!(
            statuses,
            &vec![
                PodStatusTally {
                    status: "CrashLoopBackOff".into(),
                    total: 1,
                    ready: 0
                },
                PodStatusTally {
                    status: "Running".into(),
                    total: 2,
                    ready: 2
                },
            ]
        );
    }

    /// The Service reaches `cart` by the labels its template gives its pods,
    /// as `cart`'s Connections tab reads it — scaled to zero included, where
    /// no pod is left to match.
    #[test]
    fn a_service_selects_the_workload_its_template_labels_match_even_at_zero() {
        for replicas in [4, 0] {
            let slice = slice_of(
                Held {
                    deployments: Ok(vec![cart(replicas)]),
                    pods: Ok(Vec::new()),
                    ..shop("")
                },
                chrono::Utc::now(),
            );
            assert!(
                edge(&slice, WEB, "selects", CART).is_some(),
                "at {replicas}: {:?}",
                slice.edges.keys()
            );
        }
    }

    /// A Service list the cluster refused draws no Service and names the
    /// kind, and no selection edge stands in for it. Fails if the refusal is
    /// read as an empty list: an empty map and a refused read look alike.
    #[test]
    fn a_refused_service_list_draws_no_service_and_names_services_unread() {
        let slice = slice_of(
            Held {
                services: Err(REFUSED.into()),
                ..shop("")
            },
            chrono::Utc::now(),
        );
        assert!(slice
            .nodes
            .values()
            .all(|node| node.object.kind != "Service"));
        assert!(slice
            .read
            .not_looked_at
            .iter()
            .any(|entry| entry.kind == "Service"));
        assert_eq!(
            slice
                .read
                .counts
                .iter()
                .find(|count| count.kind == "Service")
                .map(|count| count.count),
            Some(None)
        );
    }

    /// The names `cart`'s spec states are looked up in the held lists: a
    /// Secret list the cluster refused leaves the Secret not checked, never
    /// missing, and a list that answered without it makes it missing.
    #[test]
    fn a_named_secret_is_not_checked_under_a_refused_list_and_missing_from_one_that_answered() {
        let existence = |secrets: Read<Named>| {
            let slice = slice_of(
                Held {
                    secrets,
                    ..shop("")
                },
                chrono::Utc::now(),
            );
            let secret = &slice.nodes["/Secret/shop/cart-token"];
            assert!(matches!(secret.verdict, NodeVerdict::Exists));
            assert!(edge(&slice, CART, "uses", "/Secret/shop/cart-token").is_some());
            secret.object.existence
        };
        assert_eq!(existence(Err(REFUSED.into())), Existence::NotChecked);
        assert_eq!(existence(Ok(Vec::new())), Existence::Missing);
        assert_eq!(existence(Ok(vec![named("cart-token")])), Existence::Present);
    }

    /// A `ConfigMap` is drawn because `cart` mounts it, takes `cart`'s app,
    /// and is counted as used; Secrets get no whole count, because Helm's
    /// release Secrets are left out of what is read.
    #[test]
    fn config_is_drawn_where_used_and_counted_as_used() {
        let slice = slice_of(
            Held {
                config_maps: Ok(vec![named("cart-config"), named("kube-root-ca.crt")]),
                ..shop("")
            },
            chrono::Utc::now(),
        );
        assert!(slice.nodes.contains_key("/ConfigMap/shop/cart-config"));
        assert!(!slice.nodes.contains_key("/ConfigMap/shop/kube-root-ca.crt"));
        assert_eq!(
            slice.nodes["/ConfigMap/shop/cart-config"].app.as_deref(),
            Some("shop")
        );
        let count = |kind: &str| {
            slice
                .read
                .counts
                .iter()
                .find(|count| count.kind == kind)
                .map(|count| (count.count, count.used))
        };
        assert_eq!(count("ConfigMap"), Some((Some(2), Some(1))));
        assert_eq!(count("Secret"), Some((None, Some(1))));
    }

    /// An autoscaler names its target by group, kind and name: one naming a
    /// `Deployment` of another group scales something else.
    #[test]
    fn an_autoscaler_reaches_only_the_workload_its_group_kind_and_name_name() {
        let hpa = |api_version: &str| -> HorizontalPodAutoscaler {
            of(json!({
                "metadata": { "name": "cart", "namespace": "shop" },
                "spec": {
                    "scaleTargetRef": { "apiVersion": api_version, "kind": "Deployment", "name": "cart" },
                    "maxReplicas": 5,
                },
            }))
        };
        for (api_version, edged) in [("apps/v1", true), ("other.example.com/v1", false)] {
            let slice = slice_of(
                Held {
                    autoscalers: Ok(vec![hpa(api_version)]),
                    ..shop("")
                },
                chrono::Utc::now(),
            );
            assert_eq!(
                edge(
                    &slice,
                    "autoscaling/HorizontalPodAutoscaler/shop/cart",
                    "governs",
                    CART
                )
                .is_some(),
                edged,
                "{api_version}"
            );
        }
    }

    fn policy(selector: serde_json::Value) -> NetworkPolicy {
        of(json!({
            "metadata": { "name": "only-front", "namespace": "shop" },
            "spec": { "podSelector": selector, "policyTypes": ["Ingress"] },
        }))
    }

    fn cover(held: Held) -> PolicyCover {
        slice_of(held, chrono::Utc::now()).nodes[CART]
            .cover
            .clone()
            .expect("a workload's cover")
    }

    /// "No `NetworkPolicy` selects it" is said only where every engine that
    /// could was read: a refused policy list is unread, and another engine's
    /// policies in force here leave it unknown.
    #[test]
    fn a_workload_s_policy_cover_is_none_only_where_every_engine_was_read() {
        assert_eq!(
            cover(Held {
                policies: Ok(vec![policy(json!({ "matchLabels": { "app": "web" } }))]),
                ..shop("")
            }),
            PolicyCover::Covered {
                policies: vec!["only-front".into()]
            }
        );
        assert_eq!(
            cover(Held {
                policies: Ok(vec![policy(json!({ "matchLabels": { "app": "db" } }))]),
                ..shop("")
            }),
            PolicyCover::None
        );
        assert_eq!(
            cover(Held {
                policies: Err(crate::resources::ListUnread {
                    code: "PERMISSION_DENIED",
                    said: REFUSED.into()
                }),
                ..shop("")
            }),
            PolicyCover::Unread {
                said: REFUSED.into()
            }
        );
        let mut others = crate::resources::OtherPolicies::none();
        others.within("shop", "CiliumNetworkPolicy");
        assert_eq!(
            cover(Held { others, ..shop("") }),
            PolicyCover::Unknown {
                kinds: vec!["CiliumNetworkPolicy".into()],
                unreadable: Vec::new(),
            }
        );
    }

    /// The policy node counts the pods it picks by the `NetworkPolicy`
    /// list's own join, and a refused pod list leaves the count unknown
    /// rather than zero — zero is "this policy protects nothing".
    #[test]
    fn a_policy_counts_the_pods_it_picks_as_its_list_does() {
        let selected = |pods: Read<Pod>| {
            let slice = slice_of(
                Held {
                    pods,
                    policies: Ok(vec![policy(json!({ "matchLabels": { "app": "web" } }))]),
                    ..shop("")
                },
                chrono::Utc::now(),
            );
            match &slice.nodes["networking.k8s.io/NetworkPolicy/shop/only-front"].verdict {
                NodeVerdict::Policy { selected } => *selected,
                other => panic!("a policy, not {other:?}"),
            }
        };
        assert_eq!(selected(shop("").pods), Some(4));
        assert_eq!(selected(Err(REFUSED.into())), None);
    }

    /// What a Service publishes on the map is what its own page reads from
    /// the same lists: the same counts and the same stop.
    #[test]
    fn a_service_on_the_map_publishes_what_its_page_reads() {
        let now = chrono::Utc::now();
        let map = slice_of(shop("ContainerCreating"), now);
        let NodeVerdict::Service {
            published: Some(drawn),
            ..
        } = &map.nodes[WEB].verdict
        else {
            panic!("a Service's published endpoints");
        };
        let (snapshot, _) = Snapshot::from_stores(shop("ContainerCreating"));
        let svc = service("web");
        let mut out = Neighbourhood::new();
        note_reach(
            &svc,
            &service_ref(&svc, "shop"),
            &snapshot,
            &mut out,
            Carry::Whole,
        );
        let page = &out.published[0];
        assert_eq!(
            (drawn.ready, drawn.not_ready, drawn.draining, drawn.unrouted),
            (page.ready, page.not_ready, page.draining, page.unrouted)
        );
        assert_eq!(
            serde_json::to_value(&drawn.stop).expect("json"),
            serde_json::to_value(&page.stop).expect("json")
        );
    }

    /// An Ingress naming a Service the list does not hold routes to a missing
    /// one; under a refused Service list it is not checked, and no red is drawn.
    #[test]
    fn an_ingress_backend_is_missing_only_where_the_service_list_answered() {
        let ingress: Ingress = of(json!({
            "metadata": { "name": "front", "namespace": "shop" },
            "spec": { "rules": [{ "host": "shop.example.com", "http": { "paths": [{
                "path": "/", "pathType": "Prefix",
                "backend": { "service": { "name": "gone", "port": { "number": 80 } } },
            }] } }] },
        }));
        for (services, existence) in [
            (Ok(Vec::new()), Existence::Missing),
            (Err(REFUSED.to_string()), Existence::NotChecked),
        ] {
            let slice = slice_of(
                Held {
                    ingresses: Ok(vec![ingress.clone()]),
                    services,
                    ..held()
                },
                chrono::Utc::now(),
            );
            assert_eq!(
                slice.nodes["/Service/shop/gone"].object.existence,
                existence
            );
            assert!(edge(
                &slice,
                "networking.k8s.io/Ingress/shop/front",
                "routes",
                "/Service/shop/gone"
            )
            .is_some());
        }
    }
}
