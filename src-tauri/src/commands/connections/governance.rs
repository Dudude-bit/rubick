//! What acts on an object without being asked: autoscalers, disruption
//! budgets, network policies.

use super::*;

/// The autoscaler as the workload it scales needs to read it.
pub(super) fn autoscaler_ref(hpa: &HorizontalPodAutoscaler, ns: &str) -> ObjectRef {
    let spec = hpa.spec.as_ref();
    let status = hpa.status.as_ref();
    let readings: Vec<&MetricStatus> = status
        .and_then(|s| s.current_metrics.as_ref())
        .map(|m| m.iter().collect())
        .unwrap_or_default();

    ObjectRef::new(
        "HorizontalPodAutoscaler",
        &hpa.name_any(),
        Some(ns.to_string()),
        Existence::Present,
    )
    .with_facts(ObjectFacts::Autoscaler {
        // The API server defaults an absent `minReplicas` to 1, and the
        // reader is looking at a range: leaving it null would draw "— to 5".
        min_replicas: spec.and_then(|s| s.min_replicas).unwrap_or(1),
        max_replicas: spec.map_or(0, |s| s.max_replicas),
        current_replicas: status.and_then(|s| s.current_replicas).unwrap_or(0),
        desired_replicas: status.map_or(0, |s| s.desired_replicas),
        metrics: spec
            .and_then(|s| s.metrics.as_ref())
            .map(|metrics| {
                metrics
                    .iter()
                    .map(|metric| autoscaler_metric(metric, &readings))
                    .collect()
            })
            .unwrap_or_default(),
        conditions: status
            .and_then(|s| s.conditions.as_ref())
            .map(|conditions| {
                conditions
                    .iter()
                    .map(|c| ConditionInfo {
                        type_: c.type_.clone(),
                        status: c.status.clone(),
                        reason: c.reason.clone(),
                        message: c.message.clone(),
                        last_transition_time: c.last_transition_time.as_ref().map(Moment::moment),
                        observed_generation: None,
                    })
                    .collect()
            })
            .unwrap_or_default(),
        last_scale_time: status
            .and_then(|s| s.last_scale_time.as_ref())
            .map(Moment::moment),
    })
}

/// The name a metric spec is known by, which is also how its reading is found.
pub(super) fn metric_name(metric: &MetricSpec) -> (String, String) {
    if let Some(resource) = &metric.resource {
        return (resource.name.clone(), "resource".to_string());
    }
    if let Some(container) = &metric.container_resource {
        return (
            format!("{} in {}", container.name, container.container),
            "containerResource".to_string(),
        );
    }
    if let Some(pods) = &metric.pods {
        return (pods.metric.name.clone(), "pods".to_string());
    }
    if let Some(object) = &metric.object {
        return (object.metric.name.clone(), "object".to_string());
    }
    if let Some(external) = &metric.external {
        return (external.metric.name.clone(), "external".to_string());
    }
    (metric.type_.clone(), metric.type_.to_lowercase())
}

/// The reading published for one spec'd metric, matched by name and shape.
///
/// `None` rather than zero where nothing matched: an HPA that cannot reach
/// its metrics publishes no `currentMetrics` at all, and a zero there would
/// be a reading it never took.
pub(super) fn reading_for(
    metric: &MetricSpec,
    readings: &[&MetricStatus],
) -> Option<MetricValueStatus> {
    readings.iter().find_map(|status| {
        match (&metric.resource, &status.resource) {
            (Some(spec), Some(got)) if spec.name == got.name => {
                return Some(got.current.clone());
            }
            _ => {}
        }
        match (&metric.container_resource, &status.container_resource) {
            (Some(spec), Some(got)) if spec.name == got.name && spec.container == got.container => {
                return Some(got.current.clone());
            }
            _ => {}
        }
        match (&metric.pods, &status.pods) {
            (Some(spec), Some(got)) if spec.metric.name == got.metric.name => {
                return Some(got.current.clone());
            }
            _ => {}
        }
        match (&metric.object, &status.object) {
            (Some(spec), Some(got)) if spec.metric.name == got.metric.name => {
                return Some(got.current.clone());
            }
            _ => {}
        }
        match (&metric.external, &status.external) {
            (Some(spec), Some(got)) if spec.metric.name == got.metric.name => {
                Some(got.current.clone())
            }
            _ => None,
        }
    })
}

pub(super) fn autoscaler_metric(
    metric: &MetricSpec,
    readings: &[&MetricStatus],
) -> AutoscalerMetric {
    let (name, source) = metric_name(metric);
    let target = metric
        .resource
        .as_ref()
        .map(|m| &m.target)
        .or_else(|| metric.container_resource.as_ref().map(|m| &m.target))
        .or_else(|| metric.pods.as_ref().map(|m| &m.target))
        .or_else(|| metric.object.as_ref().map(|m| &m.target))
        .or_else(|| metric.external.as_ref().map(|m| &m.target));

    AutoscalerMetric {
        name,
        source,
        target: target.map(target_text).unwrap_or_default(),
        current: reading_for(metric, readings).as_ref().map(reading_text),
    }
}

/// A target in the unit the reader compares against — a percentage for a
/// utilisation target, the bare quantity for the other two.
pub(super) fn target_text(target: &MetricTarget) -> String {
    if let Some(utilisation) = target.average_utilization {
        return format!("{utilisation}%");
    }
    if let Some(average) = &target.average_value {
        return average.0.clone();
    }
    target
        .value
        .as_ref()
        .map(|v| v.0.clone())
        .unwrap_or_default()
}

pub(super) fn reading_text(reading: &MetricValueStatus) -> String {
    if let Some(utilisation) = reading.average_utilization {
        return format!("{utilisation}%");
    }
    if let Some(average) = &reading.average_value {
        return average.0.clone();
    }
    reading
        .value
        .as_ref()
        .map(|v| v.0.clone())
        .unwrap_or_default()
}

pub(super) fn budget_ref(pdb: &PodDisruptionBudget, ns: &str) -> ObjectRef {
    let spec = pdb.spec.as_ref();
    let status = pdb.status.as_ref();
    let text = |value: &IntOrString| match value {
        IntOrString::Int(n) => n.to_string(),
        IntOrString::String(s) => s.clone(),
    };

    ObjectRef::new(
        "PodDisruptionBudget",
        &pdb.name_any(),
        Some(ns.to_string()),
        Existence::Present,
    )
    .with_facts(ObjectFacts::Budget {
        min_available: spec.and_then(|s| s.min_available.as_ref()).map(text),
        max_unavailable: spec.and_then(|s| s.max_unavailable.as_ref()).map(text),
        disruptions_allowed: status.map_or(0, |s| s.disruptions_allowed),
        current_healthy: status.map_or(0, |s| s.current_healthy),
        desired_healthy: status.map_or(0, |s| s.desired_healthy),
        expected_pods: status.map_or(0, |s| s.expected_pods),
        conditions: status
            .and_then(|s| s.conditions.as_ref())
            .map(|conditions| {
                conditions
                    .iter()
                    .map(|c| ConditionInfo {
                        type_: c.type_.clone(),
                        status: c.status.clone(),
                        reason: Some(c.reason.clone()).filter(|r| !r.is_empty()),
                        message: Some(c.message.clone()).filter(|m| !m.is_empty()),
                        last_transition_time: Some(c.last_transition_time.moment()),
                        observed_generation: None,
                    })
                    .collect()
            })
            .unwrap_or_default(),
    })
}

/// Whether an autoscaler's `scaleTargetRef` names this object.
///
/// Group, kind and name — not the version. The API server resolves the
/// reference through the scale subresource, which is addressed by
/// group-resource, so an `apps/v1` and an `apps/v1beta2` reference to the
/// same Deployment are the same reference. The group is not optional
/// though: a `Deployment` in some other group is a different object, and
/// matching on the bare kind would draw an edge Kubernetes does not make.
pub(super) fn scale_target_matches(hpa: &HorizontalPodAutoscaler, target: &ObjectRef) -> bool {
    let Some(reference) = hpa.spec.as_ref().map(|s| &s.scale_target_ref) else {
        return false;
    };
    if reference.kind != target.kind || reference.name != target.name {
        return false;
    }
    let Some(group) = target_group(&target.kind) else {
        return true;
    };
    match &reference.api_version {
        // `apiVersion` is optional in the type and required by validation;
        // an object that somehow has none states no group to disagree with.
        None => true,
        Some(version) => version.split_once('/').map_or("", |(g, _)| g) == group,
    }
}

/// The API group of a kind an autoscaler can plausibly point at.
pub(super) fn target_group(kind: &str) -> Option<&'static str> {
    match kind {
        "Deployment" | "StatefulSet" | "ReplicaSet" | "DaemonSet" => Some("apps"),
        "ReplicationController" => Some(""),
        _ => None,
    }
}

/// The autoscalers that name any of `scalable`, and the budgets that match
/// `labels`.
///
/// Both lists were taken once with the rest of the namespace, so this is a
/// pass over memory whatever the answer is — the same contract the Services
/// and the Ingresses are read under.
pub(super) fn governed_by(
    ns: &str,
    scalable: &[ObjectRef],
    target: &ObjectRef,
    labels: &BTreeMap<String, String>,
    snapshot: &Snapshot,
    out: &mut Neighbourhood,
) {
    for hpa in snapshot.autoscalers.as_deref().unwrap_or_default() {
        for object in scalable {
            if scale_target_matches(hpa, object) {
                out.edge(
                    autoscaler_ref(hpa, ns),
                    object.clone(),
                    Relation::Governs { selector: None },
                );
            }
        }
    }
    budgets_over(ns, target, labels, &snapshot.budgets, out);
}

/// The `PodDisruptionBudgets` whose selector matches these pod labels.
pub(super) fn budgets_over(
    ns: &str,
    target: &ObjectRef,
    labels: &BTreeMap<String, String>,
    budgets: &Read<PodDisruptionBudget>,
    out: &mut Neighbourhood,
) {
    for pdb in budgets.as_deref().unwrap_or_default() {
        // A budget only ever covers pods in its own namespace. The check is
        // free where the list was namespace-scoped and load-bearing where it
        // was not — a node's is taken across the whole cluster.
        if pdb.namespace().as_deref() != Some(ns) {
            continue;
        }
        // `policy/v1`, and it is the reverse of a Service's rule: a null
        // selector matches no pods, an empty `{}` one covers every pod in
        // the namespace. The API server refuses one that cannot be built,
        // so `None` is a budget that cannot exist and draws no edge.
        let selector = Selector::Query(pdb.spec.as_ref().and_then(|s| s.selector.as_ref()));
        if selector.matches(labels) != Some(true) {
            continue;
        }
        out.edge(
            budget_ref(pdb, ns),
            target.clone(),
            Relation::Governs {
                selector: selector.says(),
            },
        );
    }
}

/// What the reads that failed leave the answer unable to say.
pub(super) fn unanswered(snapshot: &Snapshot) -> Vec<UnexploredKind> {
    let mut unread = UnexploredKind::governance(
        snapshot
            .autoscalers
            .as_ref()
            .err()
            .map(std::string::String::as_str),
        snapshot
            .budgets
            .as_ref()
            .err()
            .map(std::string::String::as_str),
    );
    // Named here as well as left `notChecked` on the reference: the row goes
    // quiet either way, and a reader owed an explanation for a volume the
    // page will not talk about gets it in the one place the page collects
    // them.
    for (kind, version, why) in [
        (
            "PersistentVolumeClaim",
            "v1",
            snapshot.claims.as_ref().err(),
        ),
        ("Pod", "v1", snapshot.pods.as_ref().err()),
        ("Service", "v1", snapshot.services.as_ref().err()),
        (
            "Ingress",
            "networking.k8s.io/v1",
            snapshot.ingresses.as_ref().err(),
        ),
    ] {
        if let Some(why) = why {
            unread.push(UnexploredKind::unanswered(kind, version, why));
        }
    }
    unread
}

#[cfg(test)]
mod refused_claim_tests {
    use super::*;

    /// What a v1.36 apiserver said to a token without
    /// `persistentvolumeclaims`, recorded through the live harness.
    const REFUSED: &str = "ApiError: persistentvolumeclaims is forbidden: User \
         \"system:serviceaccount:k8s-gui-test:narrow\" cannot list resource \
         \"persistentvolumeclaims\" in API group \"\" in the namespace \
         \"k8s-gui-test\": Forbidden";

    /// The defect this file's own doc comment describes, found in it: a
    /// refused list read as "no claims came back", so every claim a pod
    /// mounts resolved to `Missing` and the page said, in red, that a
    /// volume that is mounted and healthy does not exist.
    ///
    /// Deleting the `Err` arm of `named_object` puts that back, and this
    /// fails.
    #[test]
    fn a_claim_list_the_cluster_refused_leaves_the_claim_unchecked() {
        let refused: Read<PersistentVolumeClaim> = Err(REFUSED.to_string());
        let object = named_object("shop", "PersistentVolumeClaim", "data", &refused);

        assert_eq!(object.existence, Existence::NotChecked);
        assert!(
            object.facts.is_none(),
            "a claim nobody read has no phase or size to state"
        );
    }

    /// The other half, and the reason the first is not simply "always say
    /// notChecked": a list that really came back and really does not hold
    /// the claim is the app finding a broken pod, which is worth saying.
    #[test]
    fn a_claim_absent_from_a_list_that_answered_is_still_missing() {
        let answered: Read<PersistentVolumeClaim> = Ok(Vec::new());
        let object = named_object("shop", "PersistentVolumeClaim", "data", &answered);

        assert_eq!(object.existence, Existence::Missing);
    }

    /// A refusal the reader is owed an explanation for reaches the one
    /// place the page collects them, beside the governance kinds that have
    /// carried theirs all along.
    #[test]
    fn the_refusal_is_named_among_the_kinds_nobody_looked_at() {
        let snapshot = Snapshot {
            pods: Ok(Vec::new()),
            services: Ok(Vec::new()),
            ingresses: Ok(Vec::new()),
            claims: Err(REFUSED.to_string()),
            autoscalers: Ok(Vec::new()),
            budgets: Ok(Vec::new()),
            slices: Ok(Vec::new()),
            legacy: Err("the slices answered".to_string()),
            gateway_routes: Vec::new(),
            gateways: None,
        };

        let unread = unanswered(&snapshot);
        let claim = unread
            .iter()
            .find(|entry| entry.kind == "PersistentVolumeClaim")
            .expect("the refused claim list is named");
        match &claim.why {
            crate::resources::Unread::Unanswered { said, .. } => {
                assert!(said.contains("is forbidden"));
            }
            other => panic!("the cluster's own words, not {other:?}"),
        }

        // The version travels inside `why` and the frontend keys on both.
        // Checking only that the name appears let any kind↔version pairing
        // through, so a claim named with the wrong group would read as a
        // kind the app does not know.
        match &claim.why {
            crate::resources::Unread::Unanswered { version, .. } => {
                assert_eq!(version, "v1", "the version the kind belongs to");
            }
            other => panic!("a refusal is Unanswered, not {other:?}"),
        }
        // And nothing else is named: a list that answered is not unread,
        // however empty it came back.
        assert_eq!(
            unread
                .iter()
                .map(|entry| entry.kind.as_str())
                .collect::<Vec<_>>(),
            ["PersistentVolumeClaim"],
            "only the list that was actually refused: {unread:?}"
        );
    }

    /// Every list refused, so every kind has to be named, each with the
    /// version it belongs to. The single-kind test above passes whether or
    /// not the other arms exist at all.
    #[test]
    fn each_refused_list_is_named_with_the_version_it_belongs_to() {
        let snapshot = Snapshot {
            pods: Err(REFUSED.to_string()),
            services: Err(REFUSED.to_string()),
            ingresses: Err(REFUSED.to_string()),
            claims: Err(REFUSED.to_string()),
            autoscalers: Ok(Vec::new()),
            budgets: Ok(Vec::new()),
            slices: Ok(Vec::new()),
            legacy: Ok(Vec::new()),
            gateway_routes: Vec::new(),
            gateways: None,
        };
        let unread = unanswered(&snapshot);
        let named: std::collections::BTreeMap<_, _> = unread
            .iter()
            .filter_map(|entry| match &entry.why {
                crate::resources::Unread::Unanswered { version, .. } => {
                    Some((entry.kind.as_str(), version.as_str()))
                }
                _ => None,
            })
            .collect();

        assert_eq!(named.get("Pod"), Some(&"v1"));
        assert_eq!(named.get("Service"), Some(&"v1"));
        assert_eq!(named.get("Ingress"), Some(&"networking.k8s.io/v1"));
        assert_eq!(named.get("PersistentVolumeClaim"), Some(&"v1"));
    }
}
