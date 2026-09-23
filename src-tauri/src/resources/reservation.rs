//! What the scheduler holds for a pod: one rule, read by every screen that
//! sizes a pod.

use std::collections::BTreeMap;

use k8s_openapi::api::core::v1::{Container, PodSpec, ResourceRequirements};
use k8s_openapi::apimachinery::pkg::api::resource::Quantity;

use super::node_budget::parse;

/// Per resource name: millicores for CPU, bytes for memory and storage,
/// a count for anything else.
pub type Sums = BTreeMap<String, f64>;

type Declared = BTreeMap<String, Quantity>;

fn read(from: Option<&Declared>, ok: &mut bool) -> Sums {
    let mut sums = Sums::new();
    for (key, q) in from.into_iter().flatten() {
        match parse(key, &q.0) {
            Some(value) => {
                sums.insert(key.clone(), value);
            }
            // A summed value we could not read makes the total a lie; the
            // caller turns `!ok` into an unknown column, not a smaller number.
            None => *ok = false,
        }
    }
    sums
}

fn add(into: &mut Sums, from: &Sums) {
    for (key, value) in from {
        *into.entry(key.clone()).or_insert(0.0) += value;
    }
}

fn raise(into: &mut Sums, from: &Sums) {
    for (key, value) in from {
        let slot = into.entry(key.clone()).or_insert(0.0);
        if *value > *slot {
            *slot = *value;
        }
    }
}

fn is_sidecar(container: &Container) -> bool {
    container.restart_policy.as_deref() == Some("Always")
}

/// Requests and limits per resource. `known` is false when a quantity would
/// not parse: an unreadable value makes the total a smaller number presented
/// as the whole.
#[derive(Debug, Clone, PartialEq)]
pub struct Reservation {
    /// `PodRequests`: what the scheduler holds.
    pub requests: Sums,
    /// `PodLimits`, as `kubectl describe node` adds them up.
    pub limits: Sums,
    /// The most the running containers may take, which is what usage is
    /// measured against: app containers and sidecars, or the pod-level
    /// limit. A plain init container's limit held only before any sample,
    /// and overhead is the sandbox's. A resource that a running container
    /// leaves unlimited is absent.
    pub ceiling: Sums,
    pub known: bool,
}

impl Reservation {
    /// A pod with no spec reserves nothing, and that is known.
    #[must_use]
    pub fn nothing() -> Self {
        Self {
            requests: Sums::new(),
            limits: Sums::new(),
            ceiling: Sums::new(),
            known: true,
        }
    }
}

/// KEP-753: the larger of Σ(containers and sidecars) and each plain init
/// container plus the sidecars declared before it, which are already
/// running while it does.
fn containers_sum(
    spec: &PodSpec,
    pick: fn(&ResourceRequirements) -> Option<&Declared>,
    ok: &mut bool,
) -> Sums {
    let mut own = |c: &Container| read(c.resources.as_ref().and_then(pick), ok);
    let mut sums = Sums::new();
    for container in &spec.containers {
        add(&mut sums, &own(container));
    }
    let mut sidecars = Sums::new();
    let mut init = Sums::new();
    for container in spec.init_containers.as_deref().unwrap_or_default() {
        let its = own(container);
        if is_sidecar(container) {
            add(&mut sums, &its);
            add(&mut sidecars, &its);
        } else {
            let mut while_it_runs = sidecars.clone();
            add(&mut while_it_runs, &its);
            raise(&mut init, &while_it_runs);
        }
    }
    raise(&mut sums, &init);
    sums
}

fn running_ceiling(spec: &PodSpec, ok: &mut bool) -> Sums {
    let sidecars = spec
        .init_containers
        .iter()
        .flatten()
        .filter(|c| is_sidecar(c));
    let running: Vec<Sums> = spec
        .containers
        .iter()
        .chain(sidecars)
        .map(|c| read(c.resources.as_ref().and_then(|r| r.limits.as_ref()), ok))
        .collect();
    let mut ceiling = Sums::new();
    for limits in &running {
        add(&mut ceiling, limits);
    }
    ceiling.retain(|key, _| running.iter().all(|limits| limits.contains_key(key)));
    ceiling
}

/// The scheduler's reservation for one pod — or one replica of a template —
/// per resource, as `resource.PodRequests` and `PodLimits` compute it:
/// sidecars counted, init containers by KEP-753, a pod-level request or
/// limit (KEP-2837) replacing the container arithmetic for its resource,
/// then overhead on every request and on the limits that exist.
///
/// The one rule. The pods column, the node budget and the overview's
/// headroom each had their own, and three of them left sidecars, init
/// containers or overhead out — an Istio pod read a different size on every
/// screen.
#[must_use]
pub fn pod_reservation(spec: &PodSpec) -> Reservation {
    let mut ok = true;
    let mut requests = containers_sum(spec, |r| r.requests.as_ref(), &mut ok);
    let mut limits = containers_sum(spec, |r| r.limits.as_ref(), &mut ok);
    let mut ceiling = running_ceiling(spec, &mut ok);

    let pod_level = spec.resources.as_ref();
    requests.extend(read(pod_level.and_then(|r| r.requests.as_ref()), &mut ok));
    let pod_limits = read(pod_level.and_then(|r| r.limits.as_ref()), &mut ok);
    limits.extend(pod_limits.clone());
    ceiling.extend(pod_limits);

    let overhead = read(spec.overhead.as_ref(), &mut ok);
    add(&mut requests, &overhead);
    for (key, value) in &overhead {
        if let Some(slot) = limits.get_mut(key) {
            *slot += value;
        }
    }
    Reservation {
        requests,
        limits,
        ceiling,
        known: ok,
    }
}

#[cfg(test)]
#[allow(clippy::float_cmp)]
mod tests {
    use super::*;
    use k8s_openapi::api::core::v1::{Node, NodeStatus, Pod};

    const MIB: f64 = 1024.0 * 1024.0;

    fn quantities(pairs: &[(&str, &str)]) -> Option<Declared> {
        (!pairs.is_empty()).then(|| {
            pairs
                .iter()
                .map(|(k, v)| ((*k).to_string(), Quantity((*v).to_string())))
                .collect()
        })
    }

    fn sized(
        name: &str,
        always: bool,
        requests: &[(&str, &str)],
        limits: &[(&str, &str)],
    ) -> Container {
        Container {
            name: name.to_string(),
            restart_policy: always.then(|| "Always".to_string()),
            resources: Some(ResourceRequirements {
                requests: quantities(requests),
                limits: quantities(limits),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    fn container(name: &str, cpu: &str, memory: &str, always: bool) -> Container {
        sized(name, always, &[("cpu", cpu), ("memory", memory)], &[])
    }

    /// An Istio-shaped pod: an app, a native sidecar, a large init container
    /// that has to fit beside it, and a `RuntimeClass` overhead.
    fn meshed() -> Pod {
        Pod {
            spec: Some(PodSpec {
                containers: vec![container("app", "100m", "64Mi", false)],
                init_containers: Some(vec![
                    container("istio-proxy", "50m", "32Mi", true),
                    container("migrate", "500m", "256Mi", false),
                ]),
                overhead: quantities(&[("cpu", "10m"), ("memory", "8Mi")]),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    /// Would break the promise every screen makes about one pod: the pods
    /// column, the node budget and the overview each counted it their own way,
    /// and on a pod with a sidecar, a big init container and an overhead all
    /// three disagreed. `max(migrate + proxy, app + proxy) + overhead` =
    /// 560m, 296Mi.
    #[test]
    fn every_reader_sizes_one_pod_the_same() {
        let pod = meshed();
        let spec = pod.spec.as_ref().unwrap();

        let held = pod_reservation(spec);
        assert!(held.known);
        assert_eq!(held.requests["cpu"], 560.0);
        assert_eq!(held.requests["memory"], 296.0 * MIB);

        let totals = super::super::types::pod::resource_totals(spec);
        assert_eq!(totals.cpu_requests.as_deref(), Some("560m"));
        assert_eq!(
            totals.memory_requests,
            Some(format!("{}", (296.0 * MIB) as u64))
        );

        assert_eq!(
            crate::commands::overview::pod_requests(&pod),
            (560.0, (296.0 * MIB) as u64)
        );

        let node = Node {
            status: Some(NodeStatus {
                allocatable: quantities(&[("cpu", "4")]),
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
        assert_eq!(cpu.requested, Some(560.0));
    }

    /// Would under-count an Istio or Linkerd pod, whose proxy is declared
    /// first so later init containers have a network: the scheduler charges
    /// each plain init container the sidecars already running beside it,
    /// and only those.
    #[test]
    fn a_plain_init_container_is_charged_the_sidecars_declared_before_it() {
        let proxy = || sized("proxy", true, &[("cpu", "50m")], &[("cpu", "50m")]);
        let migrate = || sized("migrate", false, &[("cpu", "500m")], &[("cpu", "500m")]);
        let app = sized("app", false, &[("cpu", "100m")], &[("cpu", "100m")]);
        let with = |init: Vec<Container>| PodSpec {
            containers: vec![app.clone()],
            init_containers: Some(init),
            ..Default::default()
        };

        let before = pod_reservation(&with(vec![proxy(), migrate()]));
        assert_eq!(
            (before.requests["cpu"], before.limits["cpu"]),
            (550.0, 550.0)
        );

        let after = pod_reservation(&with(vec![migrate(), proxy()]));
        assert_eq!((after.requests["cpu"], after.limits["cpu"]), (500.0, 500.0));
    }

    /// Would invent a limit on a Kata or gVisor pod that sets none: overhead
    /// is added to every request, but only to the limits that exist.
    #[test]
    fn overhead_joins_only_the_limits_that_exist() {
        let spec = PodSpec {
            containers: vec![sized(
                "app",
                false,
                &[("cpu", "100m"), ("memory", "64Mi")],
                &[("cpu", "200m")],
            )],
            overhead: quantities(&[("cpu", "250m"), ("memory", "160Mi")]),
            ..Default::default()
        };
        let held = pod_reservation(&spec);
        assert_eq!(held.requests["memory"], 224.0 * MIB);
        assert_eq!(held.limits.get("cpu"), Some(&450.0));
        assert_eq!(
            held.limits.get("memory"),
            None,
            "no container limits memory"
        );
        assert_eq!(held.ceiling.get("memory"), None);
    }

    /// Would draw a usage bar against a limit nothing running can reach: an
    /// init container's limit held before any sample, overhead is not a
    /// container's, and one unlimited running container leaves the pod
    /// without a ceiling for that resource.
    #[test]
    fn the_ceiling_is_what_the_running_containers_may_take() {
        let spec = PodSpec {
            init_containers: Some(vec![
                sized("migrate", false, &[], &[("cpu", "500m"), ("memory", "1Gi")]),
                sized("proxy", true, &[], &[("cpu", "50m")]),
            ]),
            containers: vec![sized(
                "app",
                false,
                &[],
                &[("cpu", "100m"), ("memory", "256Mi")],
            )],
            overhead: quantities(&[("cpu", "10m")]),
            ..Default::default()
        };
        let held = pod_reservation(&spec);
        assert_eq!(held.limits["cpu"], 510.0, "kubectl's figure is kept");
        assert_eq!(held.ceiling.get("cpu"), Some(&150.0));
        assert_eq!(
            held.ceiling.get("memory"),
            None,
            "the proxy may take any memory"
        );

        let mut bounded = spec.clone();
        bounded.resources = Some(ResourceRequirements {
            limits: quantities(&[("memory", "512Mi")]),
            ..Default::default()
        });
        assert_eq!(
            pod_reservation(&bounded).ceiling.get("memory"),
            Some(&(512.0 * MIB))
        );
    }

    /// A pod with no spec reserves nothing, and says it knows that.
    #[test]
    fn nothing_is_known_to_be_nothing() {
        assert!(Reservation::nothing().known);
    }
}
