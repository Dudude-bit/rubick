//! Per-kind answers: the neighbourhood as each kind of subject reads it.

use super::*;

pub(super) async fn pod_connections(
    source: Source<'_>,
    ctx: &ResourceContext,
    ns: &str,
    name: &str,
    gateway: Option<&crate::resources::GatewayApiDetection>,
    out: &mut Neighbourhood,
) -> Result<()> {
    let is_it = |pod: &Pod| pod.name_any() == name;
    let snapshot = source
        .subject_snapshot(ctx, gateway, |s| lacks(&s.pods, is_it))
        .await?;
    let pod = found(&snapshot.pods, "Pod", ns, name, is_it)?;

    let subject = pod_ref(pod, ns);
    out.subject = Some(subject.clone());

    if let Some(spec) = pod.spec.as_ref() {
        uses_from_spec(ns, &subject, spec, &snapshot.claims, out);
        if let Some(node) = &spec.node_name {
            out.edge(
                subject.clone(),
                ObjectRef::unchecked("Node", node, None),
                Relation::RunsOn,
            );
        }
    }

    traffic_into(ns, &subject, pod.labels(), &snapshot, out);
    owner_chain(
        ctx,
        ns,
        subject.clone(),
        pod.owner_references().to_vec(),
        &mut HashSet::new(),
        out,
    )
    .await?;

    // An autoscaler never names a pod; it names the workload above it, and
    // the chain that was just walked is where that workload's name is. A
    // reader on a pod page asking "why did this come back" is asking about
    // the same HPA, so the edge is drawn to the object it really scales.
    let scalable: Vec<ObjectRef> = out
        .edges
        .iter()
        .filter(|edge| matches!(edge.relation, Relation::Owns { .. }))
        .map(|edge| edge.from.clone())
        .collect();
    governed_by(ns, &scalable, &subject, pod.labels(), &snapshot, out);

    out.not_looked_at.extend(unanswered(&snapshot));
    Ok(())
}

/// The pod template of the kinds that carry one, and the selector that
/// claims its pods.
pub(super) struct Template {
    pub(super) labels: BTreeMap<String, String>,
    /// The whole `metav1.LabelSelector`, not its `matchLabels`: a workload
    /// selecting its pods by a set-based requirement claims exactly the pods
    /// the controller claims, and reading half of it drew a workload with no
    /// pods at all.
    pub(super) selector: Option<LabelSelector>,
    pub(super) spec: Option<PodSpec>,
    pub(super) owners: Vec<OwnerReference>,
    pub(super) replicas: i32,
    pub(super) ready_replicas: i32,
}

pub(super) async fn fetch_template(
    ctx: &ResourceContext,
    ns: &str,
    kind: &str,
    name: &str,
) -> Result<(Template, Option<String>)> {
    macro_rules! from_workload {
        ($ty:ty, $obj:ident, $labels:expr, $selector:expr, $spec:expr, $replicas:expr, $ready:expr) => {{
            let $obj: $ty = got(ctx.namespaced_api().get(name).await, kind, ns, name)?;
            let uid = $obj.uid();
            (
                Template {
                    labels: $labels,
                    selector: $selector,
                    spec: $spec,
                    owners: $obj.owner_references().to_vec(),
                    replicas: $replicas,
                    ready_replicas: $ready,
                },
                uid,
            )
        }};
    }

    Ok(match kind {
        "Deployment" => from_workload!(
            Deployment,
            obj,
            obj.spec
                .as_ref()
                .and_then(|s| s.template.metadata.as_ref())
                .and_then(|m| m.labels.clone())
                .unwrap_or_default(),
            obj.spec.as_ref().map(|s| s.selector.clone()),
            obj.spec.as_ref().and_then(|s| s.template.spec.clone()),
            obj.status.as_ref().and_then(|s| s.replicas).unwrap_or(0),
            obj.status
                .as_ref()
                .and_then(|s| s.ready_replicas)
                .unwrap_or(0)
        ),
        "StatefulSet" => from_workload!(
            StatefulSet,
            obj,
            obj.spec
                .as_ref()
                .and_then(|s| s.template.metadata.as_ref())
                .and_then(|m| m.labels.clone())
                .unwrap_or_default(),
            obj.spec.as_ref().map(|s| s.selector.clone()),
            obj.spec.as_ref().and_then(|s| s.template.spec.clone()),
            obj.status.as_ref().map_or(0, |s| s.replicas),
            obj.status
                .as_ref()
                .and_then(|s| s.ready_replicas)
                .unwrap_or(0)
        ),
        "DaemonSet" => from_workload!(
            DaemonSet,
            obj,
            obj.spec
                .as_ref()
                .and_then(|s| s.template.metadata.as_ref())
                .and_then(|m| m.labels.clone())
                .unwrap_or_default(),
            obj.spec.as_ref().map(|s| s.selector.clone()),
            obj.spec.as_ref().and_then(|s| s.template.spec.clone()),
            obj.status
                .as_ref()
                .map_or(0, |s| s.desired_number_scheduled),
            obj.status.as_ref().map_or(0, |s| s.number_ready)
        ),
        "ReplicaSet" => from_workload!(
            ReplicaSet,
            obj,
            obj.spec
                .as_ref()
                .and_then(|s| s.template.as_ref())
                .and_then(|t| t.metadata.as_ref())
                .and_then(|m| m.labels.clone())
                .unwrap_or_default(),
            obj.spec.as_ref().map(|s| s.selector.clone()),
            obj.spec
                .as_ref()
                .and_then(|s| s.template.as_ref())
                .and_then(|t| t.spec.clone()),
            obj.status.as_ref().map_or(0, |s| s.replicas),
            obj.status
                .as_ref()
                .and_then(|s| s.ready_replicas)
                .unwrap_or(0)
        ),
        "Job" => from_workload!(
            Job,
            obj,
            obj.spec
                .as_ref()
                .and_then(|s| s.template.metadata.as_ref())
                .and_then(|m| m.labels.clone())
                .unwrap_or_default(),
            obj.spec.as_ref().and_then(|s| s.selector.clone()),
            obj.spec.as_ref().and_then(|s| s.template.spec.clone()),
            obj.status.as_ref().and_then(|s| s.active).unwrap_or(0),
            obj.status.as_ref().and_then(|s| s.succeeded).unwrap_or(0)
        ),
        "CronJob" => from_workload!(
            CronJob,
            obj,
            obj.spec
                .as_ref()
                .and_then(|s| s.job_template.spec.as_ref())
                .and_then(|s| s.template.metadata.as_ref())
                .and_then(|m| m.labels.clone())
                .unwrap_or_default(),
            None,
            obj.spec
                .as_ref()
                .and_then(|s| s.job_template.spec.as_ref())
                .and_then(|s| s.template.spec.clone()),
            0,
            0
        ),
        _ => unreachable!("fetch_template is only called for workload kinds"),
    })
}

pub(super) async fn workload_connections(
    source: Source<'_>,
    ctx: &ResourceContext,
    ns: &str,
    kind: &str,
    name: &str,
    gateway: Option<&crate::resources::GatewayApiDetection>,
    out: &mut Neighbourhood,
) -> Result<()> {
    let (snapshot, template) = tokio::try_join!(
        source.snapshot(ctx, gateway),
        fetch_template(ctx, ns, kind, name)
    )?;
    let (template, uid) = template;

    let subject = ObjectRef::new(kind, name, Some(ns.to_string()), Existence::Present).with_facts(
        ObjectFacts::Workload {
            replicas: template.replicas,
            ready_replicas: template.ready_replicas,
            revision: None,
            current: None,
        },
    );
    out.subject = Some(subject.clone());

    if let Some(spec) = template.spec.as_ref() {
        uses_from_spec(ns, &subject, spec, &snapshot.claims, out);
    }

    let selector = Selector::Query(template.selector.as_ref());
    // As with a budget, the API server refuses a workload selector that
    // cannot be built.
    let mine: Vec<&Pod> = snapshot
        .pods()
        .iter()
        .filter(|pod| selector.matches(pod.labels()) == Some(true))
        .collect();
    let selector_text = selector.says().unwrap_or_default();
    let mut nodes = HashSet::new();
    for pod in &mine {
        let this = pod_ref(pod, ns);
        out.edge(
            subject.clone(),
            this.clone(),
            Relation::Selects {
                selector: selector_text.clone(),
            },
        );
        if let Some(node) = pod.spec.as_ref().and_then(|s| s.node_name.clone()) {
            if nodes.insert(node.clone()) {
                out.edge(
                    this,
                    ObjectRef::unchecked("Node", &node, None),
                    Relation::RunsOn,
                );
            }
        }
    }

    // The template's labels, not the selector: an Ingress reaches the pods
    // this workload creates, and it is their labels a Service tests.
    traffic_into(ns, &subject, &template.labels, &snapshot, out);
    owner_chain(
        ctx,
        ns,
        subject.clone(),
        template.owners.clone(),
        &mut HashSet::new(),
        out,
    )
    .await?;

    let revisions_unread = if kind == "Deployment" {
        revisions_of(
            ctx,
            ns,
            &subject,
            uid.as_deref(),
            template.selector.as_ref(),
            out,
        )
        .await?
    } else {
        None
    };

    // The template's labels again, and for the same reason a Service is
    // tested against them: a budget protects the pods, and the workload is
    // covered exactly when the pods it makes are.
    governed_by(
        ns,
        std::slice::from_ref(&subject),
        &subject,
        &template.labels,
        &snapshot,
        out,
    );

    out.not_looked_at.extend(unanswered(&snapshot));
    out.not_looked_at.extend(revisions_unread);
    Ok(())
}

/// The `ReplicaSets` a Deployment made, newest first.
///
/// Filtered by controller owner rather than by the selector alone: matching
/// the selector is what makes a `ReplicaSet` adoptable, and the ownership is
/// what says it was adopted.
///
/// A refused list comes back as the kind unread rather than as the error: the
/// rest of the Deployment's neighbourhood was read and still answers.
pub(super) async fn revisions_of(
    ctx: &ResourceContext,
    ns: &str,
    subject: &ObjectRef,
    uid: Option<&str>,
    selector: Option<&LabelSelector>,
    out: &mut Neighbourhood,
) -> Result<Option<UnexploredKind>> {
    let Some(uid) = uid else { return Ok(None) };
    let Some(text) = Selector::Query(selector).query_text() else {
        return Ok(None);
    };
    let params = ListParams::default().labels(&text);
    let sets = match read_live(ctx.namespaced_api::<ReplicaSet>().list(&params).await)? {
        Ok(sets) => sets,
        Err(why) => {
            return Ok(Some(UnexploredKind::unanswered(
                "ReplicaSet",
                "apps/v1",
                &why,
            )))
        }
    };

    let owned: Vec<&ReplicaSet> = sets
        .iter()
        .filter(|rs| {
            rs.owner_references()
                .iter()
                .any(|o| o.uid == uid && o.controller.unwrap_or(false))
        })
        .collect();

    let revision = |rs: &ReplicaSet| rs.annotations().get(REVISION_ANNOTATION).cloned();
    let newest = owned
        .iter()
        .filter_map(|rs| revision(rs))
        .filter_map(|r| r.parse::<u64>().ok())
        .max();

    for rs in owned {
        let this = revision(rs);
        out.edge(
            subject.clone(),
            ObjectRef::new(
                "ReplicaSet",
                &rs.name_any(),
                Some(ns.to_string()),
                Existence::Present,
            )
            .with_facts(ObjectFacts::Workload {
                replicas: rs.status.as_ref().map_or(0, |s| s.replicas),
                ready_replicas: rs
                    .status
                    .as_ref()
                    .and_then(|s| s.ready_replicas)
                    .unwrap_or(0),
                revision: this.clone(),
                current: Some(
                    this.and_then(|r| r.parse::<u64>().ok())
                        .is_some_and(|r| Some(r) == newest),
                ),
            }),
            Relation::Owns { controller: true },
        );
    }
    Ok(None)
}

pub(super) async fn service_connections(
    source: Source<'_>,
    ctx: &ResourceContext,
    ns: &str,
    name: &str,
    gateway: Option<&crate::resources::GatewayApiDetection>,
    out: &mut Neighbourhood,
) -> Result<()> {
    let is_it = |svc: &Service| svc.name_any() == name;
    let snapshot = source
        .subject_snapshot(ctx, gateway, |s| lacks(&s.services, is_it))
        .await?;
    let svc = found(&snapshot.services, "Service", ns, name, is_it)?;

    let subject = service_ref(svc, ns);
    out.subject = Some(subject.clone());

    note_reach(svc, &subject, &snapshot, out, true);
    routes_into(ns, &subject, &snapshot, out);
    gateway_traffic_into(
        ns,
        &subject,
        &snapshot.gateway_routes,
        snapshot.gateways.as_deref(),
        out,
    );
    workloads_behind(ctx, ns, &service_selector(svc), &snapshot, out).await?;
    // The same as the pod and workload pages. Without it a refusal on this
    // page is invisible: an empty `not_looked_at` is the wire contract for
    // "every kind was read", so the "Not looked at" group never renders and
    // the frontend's own guards have nothing to fire on.
    out.not_looked_at.extend(unanswered(&snapshot));

    Ok(())
}

/// What made the pods a Service reaches.
///
/// The Service states no workload; the pods it selects state their owners,
/// and that is the only stated route from an address to the thing that
/// answers it.
pub(super) async fn workloads_behind(
    ctx: &ResourceContext,
    ns: &str,
    selector: &BTreeMap<String, String>,
    snapshot: &Snapshot,
    out: &mut Neighbourhood,
) -> Result<()> {
    let query = Selector::Equality(selector);
    let mut walked = HashSet::new();
    for pod in snapshot
        .pods()
        .iter()
        .filter(|pod| query.matches(pod.labels()) == Some(true))
    {
        let owners = pod.owner_references().to_vec();
        owner_chain(ctx, ns, pod_ref(pod, ns), owners, &mut walked, out).await?;
    }
    Ok(())
}

pub(super) async fn ingress_connections(
    source: Source<'_>,
    ctx: &ResourceContext,
    ns: &str,
    name: &str,
    out: &mut Neighbourhood,
) -> Result<()> {
    let is_it = |ing: &Ingress| ing.name_any() == name;
    let snapshot = source
        .subject_snapshot(ctx, None, |s| lacks(&s.ingresses, is_it))
        .await?;
    let ing = found(&snapshot.ingresses, "Ingress", ns, name, is_it)?;

    let subject = ingress_ref(ing, ns);
    out.subject = Some(subject.clone());

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

    let mut reached = HashSet::new();
    for (backend, relation) in ingress_backends(ing) {
        match backend {
            Backend::Service(service) => {
                if let Some(svc) = snapshot.services().iter().find(|s| s.name_any() == service) {
                    let svc_ref = service_ref(svc, ns);
                    out.edge(subject.clone(), svc_ref.clone(), relation);
                    if !reached.insert(service.clone()) {
                        continue;
                    }
                    note_reach(svc, &svc_ref, &snapshot, out, false);
                    workloads_behind(ctx, ns, &service_selector(svc), &snapshot, out).await?;
                } else {
                    let (backend, stops) = absent_backend(&service, ns, snapshot.services.is_ok());
                    out.edge(subject.clone(), backend.clone(), relation);
                    if reached.insert(service.clone()) && stops {
                        out.stops.push(ChainStop::BackendMissing {
                            ingress: subject.clone(),
                            service: backend,
                        });
                    }
                }
            }
            // A resource backend names an object this app does not read.
            // Stating it unchecked keeps the path on the page instead of
            // dropping it and implying the Ingress routes nowhere.
            Backend::Resource { kind, name } => {
                out.edge(
                    subject.clone(),
                    ObjectRef::unchecked(&kind, &name, Some(ns.to_string())),
                    relation,
                );
            }
        }
    }
    // As on the pod and workload pages: a refusal here has to be named, or
    // it is a gap the wire contract reads as "every kind was read".
    out.not_looked_at = unanswered(&snapshot);

    Ok(())
}

/// The backend an Ingress names and no Service answers for.
///
/// A list nobody read holds nothing either, and the two are opposite
/// answers: `Missing` renders as "routes to a backend that was never
/// created" and earns a stop that paints the hop red, while a refused list
/// earns neither — it is named in `not_looked_at` instead. In the loop this
/// was two conditions nothing could reach without a cluster.
pub(super) fn absent_backend(service: &str, ns: &str, list_answered: bool) -> (ObjectRef, bool) {
    let existence = if list_answered {
        Existence::Missing
    } else {
        Existence::NotChecked
    };
    (
        ObjectRef::new("Service", service, Some(ns.to_string()), existence),
        list_answered,
    )
}

pub(super) async fn claim_connections(
    ctx: &ResourceContext,
    ns: &str,
    name: &str,
    out: &mut Neighbourhood,
) -> Result<()> {
    let claim: PersistentVolumeClaim = got(
        ctx.namespaced_api().get(name).await,
        "PersistentVolumeClaim",
        ns,
        name,
    )?;
    let subject = claim_ref(&claim, ns);
    out.subject = Some(subject.clone());

    let spec = claim.spec.as_ref();
    if let Some(volume) = spec.and_then(|s| s.volume_name.clone()) {
        out.edge(
            subject.clone(),
            ObjectRef::unchecked("PersistentVolume", &volume, None),
            Relation::Binds,
        );
    }
    if let Some(class) = spec.and_then(|s| s.storage_class_name.clone()) {
        out.edge(
            subject.clone(),
            ObjectRef::unchecked("StorageClass", &class, None),
            Relation::Binds,
        );
    }

    users_of(ctx, ns, &subject, out).await?;
    Ok(())
}

/// A `ConfigMap` or a Secret: the objects that draw on it, and nothing else.
/// Neither kind states an edge of its own — every edge it has was written
/// somewhere that names it.
pub(super) async fn config_connections(
    ctx: &ResourceContext,
    ns: &str,
    kind: &str,
    name: &str,
    out: &mut Neighbourhood,
) -> Result<()> {
    let subject = ObjectRef::new(kind, name, Some(ns.to_string()), Existence::NotChecked);
    out.subject = Some(subject.clone());
    users_of(ctx, ns, &subject, out).await
}

/// A node: what is running on it, what would refuse to move, and what the
/// scheduler will still hand out.
///
/// Both lists are cluster-wide rather than scoped to the caller's namespace,
/// and that is a correctness point rather than a widening: a Node is
/// cluster-scoped, and the pods a drain has to evict are in every namespace
/// there is. Answering with one namespace's worth would name a subset and
/// draw it as the whole.
///
/// The node itself is read too, so the subject is a fact rather than a name
/// this call took on trust — and so the pod list has a denominator.
pub(super) async fn node_connections(
    ctx: &ResourceContext,
    name: &str,
    out: &mut Neighbourhood,
) -> Result<()> {
    let params = ListParams::default().fields(&format!("spec.nodeName={name}"));
    let nodes_api: Api<Node> = Api::all(ctx.client.clone());
    let pods_api: Api<Pod> = Api::all(ctx.client.clone());
    let budgets_api: Api<PodDisruptionBudget> = Api::all(ctx.client.clone());
    let every = ListParams::default();
    let (node, pods, budgets) = tokio::join!(
        nodes_api.get(name),
        pods_api.list(&params),
        budgets_api.list(&every)
    );
    let node = got(node, "Node", "", name)?;
    let pods = pods?.items;
    let budgets = read(budgets);

    let subject = node_ref(&node);
    out.subject = Some(subject.clone());

    for pod in &pods {
        let ns = pod.namespace().unwrap_or_default();
        let this = pod_ref(pod, &ns);
        out.edge(this.clone(), subject.clone(), Relation::RunsOn);
        // Per pod and not per node: a budget only ever covers pods in its
        // own namespace, and which of them sit on this node is the whole
        // question a drain asks.
        budgets_over(&ns, &this, pod.labels(), &budgets, out);
    }

    out.not_looked_at =
        UnexploredKind::on_a_node(budgets.as_ref().err().map(std::string::String::as_str));
    Ok(())
}

/// The node, in the terms the pods placed on it are read against.
///
/// Allocatable rather than capacity, and the difference is the one the
/// scheduler uses: capacity is what the machine has, allocatable is what is
/// left once the kubelet has reserved its own, and a pod is placed against
/// the second.
pub(super) fn node_ref(node: &Node) -> ObjectRef {
    let info = crate::resources::NodeInfo::from(node);
    ObjectRef::new("Node", &node.name_any(), None, Existence::Present).with_facts(
        ObjectFacts::Node {
            schedulable: !node
                .spec
                .as_ref()
                .and_then(|s| s.unschedulable)
                .unwrap_or(false),
            pod_capacity: info.allocatable.pods.and_then(|pods| pods.parse().ok()),
            cpu: info.allocatable.cpu,
            memory: info.allocatable.memory,
        },
    )
}

/// A `PersistentVolume`: the claim it is bound to, and the class that made it.
///
/// The claim is the cluster-scoped case in miniature. `spec.claimRef` names
/// its namespace outright, and that namespace is neither the page the reader
/// came from nor `default` — reading it under either is how a bound volume
/// reports its claim missing.
pub(super) async fn volume_connections(
    ctx: &ResourceContext,
    name: &str,
    out: &mut Neighbourhood,
) -> Result<()> {
    let volumes: Api<PersistentVolume> = Api::all(ctx.client.clone());
    let volume = got(volumes.get(name).await, "PersistentVolume", "", name)?;
    let subject = ObjectRef::new("PersistentVolume", name, None, Existence::Present);
    out.subject = Some(subject.clone());

    let spec = volume.spec.as_ref();
    if let Some(claim) = spec.and_then(|s| s.claim_ref.as_ref()) {
        if let (Some(ns), Some(claim_name)) = (claim.namespace.clone(), claim.name.clone()) {
            let api: Api<PersistentVolumeClaim> = Api::namespaced(ctx.client.clone(), &ns);
            let to = match api.get(&claim_name).await {
                Ok(found) => claim_ref(&found, &ns),
                // A claim the API server does not have is a released volume
                // holding a reference to something deleted. Any other failure
                // is the app not having looked, and says so.
                Err(kube::Error::Api(err)) if err.code == 404 => ObjectRef::new(
                    "PersistentVolumeClaim",
                    &claim_name,
                    Some(ns),
                    Existence::Missing,
                ),
                Err(_) => ObjectRef::unchecked("PersistentVolumeClaim", &claim_name, Some(ns)),
            };
            out.edge(subject.clone(), to, Relation::Binds);
        }
    }
    if let Some(class) = spec.and_then(|s| s.storage_class_name.clone()) {
        out.edge(
            subject.clone(),
            ObjectRef::unchecked("StorageClass", &class, None),
            Relation::Binds,
        );
    }

    out.not_looked_at = UnexploredKind::on_a_volume();
    Ok(())
}

/// Everything in the namespace whose pod spec names this object.
///
/// Deployments, `StatefulSets`, `DaemonSets`, Jobs and `CronJobs`, plus the pods
/// themselves, and — for a Secret — the Ingresses that serve it as a
/// certificate. One list per kind, concurrently, whatever the answer turns out
/// to be.
pub(super) async fn users_of(
    ctx: &ResourceContext,
    ns: &str,
    target: &ObjectRef,
    out: &mut Neighbourhood,
) -> Result<()> {
    let params = ListParams::default();
    let pods_api = ctx.namespaced_api::<Pod>();
    let deploys_api = ctx.namespaced_api::<Deployment>();
    let sets_api = ctx.namespaced_api::<StatefulSet>();
    let daemons_api = ctx.namespaced_api::<DaemonSet>();
    let jobs_api = ctx.namespaced_api::<Job>();
    let crons_api = ctx.namespaced_api::<CronJob>();
    let ingresses_api = ctx.namespaced_api::<Ingress>();
    let serves_tls = target.kind == "Secret";
    let (pods, deploys, sets, daemons, jobs, crons, ingresses) = tokio::join!(
        pods_api.list(&params),
        deploys_api.list(&params),
        sets_api.list(&params),
        daemons_api.list(&params),
        jobs_api.list(&params),
        crons_api.list(&params),
        async {
            if serves_tls {
                Some(ingresses_api.list(&params).await)
            } else {
                None
            }
        },
    );
    note_users(
        ns,
        target,
        UserLists {
            pods: read_live(pods)?,
            deploys: read_live(deploys)?,
            sets: read_live(sets)?,
            daemons: read_live(daemons)?,
            jobs: read_live(jobs)?,
            crons: read_live(crons)?,
            ingresses: ingresses.map(read_live).transpose()?,
        },
        out,
    );
    Ok(())
}

/// The lists [`users_of`] reads, each answered or refused on its own.
pub(super) struct UserLists {
    pub(super) pods: Read<Pod>,
    pub(super) deploys: Read<Deployment>,
    pub(super) sets: Read<StatefulSet>,
    pub(super) daemons: Read<DaemonSet>,
    pub(super) jobs: Read<Job>,
    pub(super) crons: Read<CronJob>,
    /// Read only for a Secret, the one thing an Ingress can use.
    pub(super) ingresses: Option<Read<Ingress>>,
}

/// The items of a list that answered; a refusal is recorded as the kind unread.
pub(super) fn answered<K>(
    list: Read<K>,
    kind: &str,
    version: &str,
    unread: &mut Vec<UnexploredKind>,
) -> Vec<K> {
    list.unwrap_or_else(|why| {
        unread.push(UnexploredKind::unanswered(kind, version, &why));
        Vec::new()
    })
}

/// A refused list is one kind unread, named in `not_looked_at`, and the other
/// kinds still answer: a role without `list cronjobs` lost the whole panel.
pub(super) fn note_users(ns: &str, target: &ObjectRef, lists: UserLists, out: &mut Neighbourhood) {
    let mut unread = Vec::new();
    let pods = answered(lists.pods, "Pod", "v1", &mut unread);
    let deploys = answered(lists.deploys, "Deployment", "apps/v1", &mut unread);
    let sets = answered(lists.sets, "StatefulSet", "apps/v1", &mut unread);
    let daemons = answered(lists.daemons, "DaemonSet", "apps/v1", &mut unread);
    let jobs = answered(lists.jobs, "Job", "batch/v1", &mut unread);
    let crons = answered(lists.crons, "CronJob", "batch/v1", &mut unread);
    let ingresses = lists.ingresses.map_or_else(Vec::new, |list| {
        answered(list, "Ingress", "networking.k8s.io/v1", &mut unread)
    });

    let mut note = |kind: &str, name: String, spec: Option<&PodSpec>| {
        let Some(spec) = spec else { return };
        let usages = usages_in_pod_spec(spec, &target.kind, &target.name);
        if usages.is_empty() {
            return;
        }
        out.edge(
            ObjectRef::new(kind, &name, Some(ns.to_string()), Existence::Present),
            target.clone(),
            Relation::Uses { usages },
        );
    };

    for pod in pods {
        note("Pod", pod.name_any(), pod.spec.as_ref());
    }
    for obj in deploys {
        note(
            "Deployment",
            obj.name_any(),
            obj.spec.as_ref().and_then(|s| s.template.spec.as_ref()),
        );
    }
    for obj in sets {
        note(
            "StatefulSet",
            obj.name_any(),
            obj.spec.as_ref().and_then(|s| s.template.spec.as_ref()),
        );
    }
    for obj in daemons {
        note(
            "DaemonSet",
            obj.name_any(),
            obj.spec.as_ref().and_then(|s| s.template.spec.as_ref()),
        );
    }
    for obj in jobs {
        note(
            "Job",
            obj.name_any(),
            obj.spec.as_ref().and_then(|s| s.template.spec.as_ref()),
        );
    }
    for obj in crons {
        note(
            "CronJob",
            obj.name_any(),
            obj.spec
                .as_ref()
                .and_then(|s| s.job_template.spec.as_ref())
                .and_then(|s| s.template.spec.as_ref()),
        );
    }

    for ing in ingresses {
        for tls in ing.spec.iter().flat_map(|spec| spec.tls.iter().flatten()) {
            if tls.secret_name.as_deref() != Some(target.name.as_str()) {
                continue;
            }
            out.edge(
                ingress_ref(&ing, ns),
                target.clone(),
                Relation::Uses {
                    usages: vec![Usage::IngressTls {
                        hosts: tls.hosts.clone().unwrap_or_default(),
                    }],
                },
            );
        }
    }

    out.not_looked_at.extend(unread);
}

#[cfg(test)]
mod users_tests {
    use super::*;

    const REFUSED: &str = "cronjobs.batch is forbidden: User \"narrow\" cannot list \
         resource \"cronjobs\" in API group \"batch\" in the namespace \"shop\"";

    fn pod_reading(config_map: &str) -> Pod {
        serde_json::from_value(serde_json::json!({
            "metadata": { "name": "web-1", "namespace": "shop" },
            "spec": { "containers": [{
                "name": "web",
                "envFrom": [{ "configMapRef": { "name": config_map } }]
            }] }
        }))
        .unwrap()
    }

    fn lists(crons: Read<CronJob>) -> UserLists {
        UserLists {
            pods: Ok(vec![pod_reading("app-config")]),
            deploys: Ok(Vec::new()),
            sets: Ok(Vec::new()),
            daemons: Ok(Vec::new()),
            jobs: Ok(Vec::new()),
            crons,
            ingresses: None,
        }
    }

    /// A role without `list cronjobs` lost the whole "used by" panel of every
    /// `ConfigMap`, Secret and claim: one refusal ended the call. The pods that
    /// were read still use it, and the `CronJobs` are named as not looked at.
    #[test]
    fn one_refused_kind_leaves_the_others_answering() {
        let target = ObjectRef::new(
            "ConfigMap",
            "app-config",
            Some("shop".into()),
            Existence::NotChecked,
        );
        let mut out = Neighbourhood::new();
        note_users("shop", &target, lists(Err(REFUSED.to_string())), &mut out);

        assert_eq!(out.edges.len(), 1);
        assert_eq!(out.edges[0].from.kind, "Pod");
        assert_eq!(out.not_looked_at.len(), 1);
        assert_eq!(out.not_looked_at[0].kind, "CronJob");
        assert!(matches!(
            &out.not_looked_at[0].why,
            crate::resources::Unread::Unanswered { said, .. } if said.contains("forbidden")
        ));
    }

    /// Everything answered, so nothing may be named unread.
    #[test]
    fn a_full_answer_names_nothing_unread() {
        let target = ObjectRef::new(
            "ConfigMap",
            "app-config",
            Some("shop".into()),
            Existence::NotChecked,
        );
        let mut out = Neighbourhood::new();
        note_users("shop", &target, lists(Ok(Vec::new())), &mut out);
        assert!(out.not_looked_at.is_empty());
        assert_eq!(out.edges.len(), 1);
    }
}

#[cfg(test)]
mod subject_tests {
    use super::*;
    use crate::client::served::test_server::server;

    const PAYMENTS: &str = "/apis/apps/v1/namespaces/shop/deployments/payments";

    /// A pinned Deployment somebody deleted. Its GET 404s with the API's
    /// sentence, which named no kind and no name the card could match, so
    /// the card said "could not read" about a service that is gone.
    #[tokio::test]
    async fn a_deleted_workload_is_not_found_by_its_kind_and_name() {
        let gone = serde_json::json!({
            "kind": "Status", "apiVersion": "v1", "metadata": {}, "status": "Failure",
            "message": "deployments.apps \"payments\" not found", "reason": "NotFound",
            "details": { "name": "payments", "group": "apps", "kind": "deployments" },
            "code": 404,
        });
        let (client, _) = server(vec![(PAYMENTS, 404, gone.to_string())]).await;
        let ctx = ResourceContext::from_client(client, "shop".to_string());

        let Err(err) = fetch_template(&ctx, "shop", "Deployment", "payments").await else {
            panic!("a deleted Deployment has no template");
        };
        assert!(
            matches!(&err, Error::NotFound { kind, name, namespace }
                if kind == "Deployment" && name == "payments" && namespace == "shop"),
            "{err:?}"
        );
        assert!(err.to_string().contains("Deployment/payments"));
    }

    /// Would tell a CronJob page no Service selects its pods and no budget
    /// covers them: the labels its Jobs' pods carry were read as none.
    #[tokio::test]
    async fn a_cron_job_s_pods_carry_the_labels_its_job_template_gives_them() {
        let cron = serde_json::json!({
            "apiVersion": "batch/v1", "kind": "CronJob",
            "metadata": { "name": "backup", "namespace": "shop" },
            "spec": {
                "schedule": "0 * * * *",
                "jobTemplate": { "spec": { "template": {
                    "metadata": { "labels": { "app": "backup" } },
                    "spec": { "containers": [{ "name": "main" }] },
                } } },
            },
        });
        let (client, _) = server(vec![(
            "/apis/batch/v1/namespaces/shop/cronjobs/backup",
            200,
            cron.to_string(),
        )])
        .await;
        let ctx = ResourceContext::from_client(client, "shop".to_string());

        let (template, _) = fetch_template(&ctx, "shop", "CronJob", "backup")
            .await
            .expect("the CronJob is there");
        assert_eq!(
            template.labels.get("app").map(String::as_str),
            Some("backup")
        );
    }

    /// A 404 naming no object is a path the cluster does not serve, not the
    /// object gone: it keeps the cluster's words and is not about the subject.
    #[tokio::test]
    async fn a_404_that_names_no_object_is_not_the_subject_gone() {
        let (client, _) = server(vec![(PAYMENTS, 404, "404 page not found".to_string())]).await;
        let ctx = ResourceContext::from_client(client, "shop".to_string());

        let Err(err) = fetch_template(&ctx, "shop", "Deployment", "payments").await else {
            panic!("nothing served there");
        };
        assert!(matches!(err, Error::KubeApi(_)), "{err:?}");
        assert!(!err.to_string().contains("Deployment/payments"));
    }
}
