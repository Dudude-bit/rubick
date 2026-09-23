//! What the scheduler holds for a pod: one rule, read by every screen that
//! sizes a pod.

use std::collections::BTreeMap;

use k8s_openapi::api::core::v1::PodSpec;

use super::node_budget::parse;

/// Per resource name: millicores for CPU, bytes for memory and storage,
/// a count for anything else.
pub type Sums = BTreeMap<String, f64>;

fn add_all(
    into: &mut Sums,
    from: Option<&BTreeMap<String, k8s_openapi::apimachinery::pkg::api::resource::Quantity>>,
    ok: &mut bool,
) {
    let Some(map) = from else { return };
    for (key, q) in map {
        match parse(key, &q.0) {
            Some(value) => *into.entry(key.clone()).or_insert(0.0) += value,
            // A summed value we could not read makes the total a lie; the
            // caller turns `!ok` into an unknown column, not a smaller number.
            None => *ok = false,
        }
    }
}

fn max_all(
    into: &mut Sums,
    from: Option<&BTreeMap<String, k8s_openapi::apimachinery::pkg::api::resource::Quantity>>,
    ok: &mut bool,
) {
    let Some(map) = from else { return };
    for (key, q) in map {
        let Some(value) = parse(key, &q.0) else {
            *ok = false;
            continue;
        };
        let slot = into.entry(key.clone()).or_insert(0.0);
        if value > *slot {
            *slot = value;
        }
    }
}

/// Requests and limits per resource. `known` is false when a quantity would
/// not parse: an unreadable value makes the total a smaller number presented
/// as the whole.
#[derive(Debug, Clone, PartialEq)]
pub struct Reservation {
    pub requests: Sums,
    pub limits: Sums,
    pub known: bool,
}

impl Reservation {
    /// A pod with no spec reserves nothing, and that is known.
    #[must_use]
    pub fn nothing() -> Self {
        Self {
            requests: Sums::new(),
            limits: Sums::new(),
            known: true,
        }
    }
}

/// The scheduler's reservation for one pod — or one replica of a template —
/// per resource: `max(init) + Σ containers and sidecars + overhead`, with a
/// pod-level request or limit (KEP-2837) replacing the container arithmetic
/// for its resource.
///
/// The one rule. The pods column, the node budget and the overview's
/// headroom each had their own, and three of them left sidecars, init
/// containers or overhead out — an Istio pod read a different size on every
/// screen.
#[must_use]
pub fn pod_reservation(spec: &PodSpec) -> Reservation {
    let mut requests = Sums::new();
    let mut limits = Sums::new();
    let mut init_requests = Sums::new();
    let mut init_limits = Sums::new();
    let mut ok = true;

    for container in &spec.containers {
        let resources = container.resources.as_ref();
        add_all(
            &mut requests,
            resources.and_then(|r| r.requests.as_ref()),
            &mut ok,
        );
        add_all(
            &mut limits,
            resources.and_then(|r| r.limits.as_ref()),
            &mut ok,
        );
    }
    for init in spec.init_containers.as_deref().unwrap_or_default() {
        let resources = init.resources.as_ref();
        // A sidecar (restartPolicy: Always) runs for the pod's whole life
        // and counts with the app containers; a plain init container only
        // has to fit before them, so the largest one is what is reserved.
        if init.restart_policy.as_deref() == Some("Always") {
            add_all(
                &mut requests,
                resources.and_then(|r| r.requests.as_ref()),
                &mut ok,
            );
            add_all(
                &mut limits,
                resources.and_then(|r| r.limits.as_ref()),
                &mut ok,
            );
        } else {
            max_all(
                &mut init_requests,
                resources.and_then(|r| r.requests.as_ref()),
                &mut ok,
            );
            max_all(
                &mut init_limits,
                resources.and_then(|r| r.limits.as_ref()),
                &mut ok,
            );
        }
    }
    for (key, value) in init_requests {
        let slot = requests.entry(key).or_insert(0.0);
        if value > *slot {
            *slot = value;
        }
    }
    for (key, value) in init_limits {
        let slot = limits.entry(key).or_insert(0.0);
        if value > *slot {
            *slot = value;
        }
    }
    // KEP-2837: a pod-level figure replaces the container arithmetic for
    // that resource; the overview and the pod page apply the same rule.
    if let Some(pod_level) = spec.resources.as_ref() {
        for (key, q) in pod_level.requests.iter().flatten() {
            match parse(key, &q.0) {
                Some(v) => {
                    requests.insert(key.clone(), v);
                }
                None => ok = false,
            }
        }
        for (key, q) in pod_level.limits.iter().flatten() {
            match parse(key, &q.0) {
                Some(v) => {
                    limits.insert(key.clone(), v);
                }
                None => ok = false,
            }
        }
    }
    add_all(&mut requests, spec.overhead.as_ref(), &mut ok);
    add_all(&mut limits, spec.overhead.as_ref(), &mut ok);
    Reservation {
        requests,
        limits,
        known: ok,
    }
}

#[cfg(test)]
#[allow(clippy::float_cmp)]
mod tests {
    use super::*;
    use k8s_openapi::api::core::v1::{Container, Node, NodeStatus, Pod, ResourceRequirements};
    use k8s_openapi::apimachinery::pkg::api::resource::Quantity;

    fn container(name: &str, cpu: &str, memory: &str, always: bool) -> Container {
        Container {
            name: name.to_string(),
            restart_policy: always.then(|| "Always".to_string()),
            resources: Some(ResourceRequirements {
                requests: Some(BTreeMap::from([
                    ("cpu".to_string(), Quantity(cpu.to_string())),
                    ("memory".to_string(), Quantity(memory.to_string())),
                ])),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    /// An Istio-shaped pod: an app, a native sidecar, a large init container
    /// that has to fit before them, and a `RuntimeClass` overhead.
    fn meshed() -> Pod {
        Pod {
            spec: Some(PodSpec {
                containers: vec![container("app", "100m", "64Mi", false)],
                init_containers: Some(vec![
                    container("istio-proxy", "50m", "32Mi", true),
                    container("migrate", "500m", "256Mi", false),
                ]),
                overhead: Some(BTreeMap::from([
                    ("cpu".to_string(), Quantity("10m".to_string())),
                    ("memory".to_string(), Quantity("8Mi".to_string())),
                ])),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    /// Would break the promise every screen makes about one pod: the pods
    /// column, the node budget and the overview each counted it their own way,
    /// and on a pod with a sidecar, a big init container and an overhead all
    /// three disagreed. `max(init, app + sidecar) + overhead` = 510m, 264Mi.
    #[test]
    fn every_reader_sizes_one_pod_the_same() {
        let pod = meshed();
        let spec = pod.spec.as_ref().unwrap();
        let mib = 1024.0 * 1024.0;

        let held = pod_reservation(spec);
        assert!(held.known);
        assert_eq!(held.requests["cpu"], 510.0);
        assert_eq!(held.requests["memory"], 264.0 * mib);

        let totals = super::super::types::pod::resource_totals(spec);
        assert_eq!(totals.cpu_requests.as_deref(), Some("510m"));
        assert_eq!(
            totals.memory_requests,
            Some(format!("{}", (264.0 * mib) as u64))
        );

        assert_eq!(
            crate::commands::overview::pod_requests(&pod),
            (510.0, (264.0 * mib) as u64)
        );

        let node = Node {
            status: Some(NodeStatus {
                allocatable: Some(BTreeMap::from([(
                    "cpu".to_string(),
                    Quantity("4".to_string()),
                )])),
                ..Default::default()
            }),
            ..Default::default()
        };
        let budget = super::super::node_budget::budget(
            &node,
            Some(std::slice::from_ref(&pod)),
            vec![],
            None,
        );
        let cpu = budget.resources.iter().find(|r| r.name == "cpu").unwrap();
        assert_eq!(cpu.requested, Some(510.0));
    }

    /// A pod with no spec reserves nothing, and says it knows that.
    #[test]
    fn nothing_is_known_to_be_nothing() {
        assert!(Reservation::nothing().known);
    }
}
