//! What a node has, what the scheduler has already promised of it, and
//! what the pods may burst to: one table, every resource the kubelet
//! reports, extended ones included.
//!
//! The sums are the scheduler's own rule (`max(init) + Σ containers +
//! overhead`, pod-level resources overriding), over the pods on the node
//! that still hold a reservation. They are numbers or they are nothing:
//! a namespace whose pods could not be listed makes the whole column
//! unknown, because a total over the readable namespaces is a smaller
//! number presented as the whole.

use std::collections::BTreeMap;

use k8s_openapi::api::core::v1::{Node, Pod};
use serde::{Deserialize, Serialize};

use crate::utils::quantities::{parse_cpu_checked, parse_memory_checked};

/// How a resource's numbers are read and formatted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BudgetUnit {
    /// Millicores.
    Cpu,
    /// Bytes.
    Memory,
    /// A plain count: pods, GPUs, whatever a device plugin advertises.
    Count,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceBudget {
    /// The key as the kubelet reports it: `cpu`, `nvidia.com/gpu`, …
    pub name: String,
    pub unit: BudgetUnit,
    pub capacity: Option<f64>,
    pub allocatable: Option<f64>,
    /// `None` when the pods could not all be read, never a partial sum.
    pub requested: Option<f64>,
    /// `None` when unknown, and always for `pods`, which has no limit.
    pub limited: Option<f64>,
    /// Not one of the four the kubelet always reports.
    pub extended: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeBudget {
    /// Pods holding a reservation here; `None` when they could not all be read.
    pub pods: Option<usize>,
    /// Whether `requested` and `limited` are numbers.
    pub known: bool,
    /// Namespaces whose pods the cluster refused to list.
    pub refused: Vec<String>,
    /// Why nothing could be read, where the failure was not a refusal.
    pub error: Option<String>,
    pub resources: Vec<ResourceBudget>,
}

const CORE: [&str; 4] = ["cpu", "memory", "pods", "ephemeral-storage"];

fn unit_of(name: &str) -> BudgetUnit {
    match name {
        "cpu" => BudgetUnit::Cpu,
        "memory" | "ephemeral-storage" => BudgetUnit::Memory,
        _ if name.starts_with("hugepages-") => BudgetUnit::Memory,
        _ => BudgetUnit::Count,
    }
}

/// `None` when the quantity will not parse: an unreadable value is unknown,
/// never a confident zero. A present-but-unparseable capacity is `Some(None)`
/// to the caller — a resource the node has, in an amount we could not read.
fn parse(name: &str, quantity: &str) -> Option<f64> {
    match unit_of(name) {
        BudgetUnit::Cpu => parse_cpu_checked(quantity),
        // A device count is an integer, but a vendor may still write `1k`.
        BudgetUnit::Memory | BudgetUnit::Count => parse_memory_checked(quantity).map(|b| b as f64),
    }
}

/// Pods in these phases hold no reservation and are not counted.
fn holds_reservation(pod: &Pod) -> bool {
    !pod.status
        .as_ref()
        .and_then(|s| s.phase.as_deref())
        .is_some_and(|p| p == "Succeeded" || p == "Failed")
}

type Sums = BTreeMap<String, f64>;

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

/// The scheduler's reservation for one pod, per resource: requests and limits.
fn pod_reservation(pod: &Pod) -> (Sums, Sums, bool) {
    let Some(spec) = pod.spec.as_ref() else {
        return (Sums::new(), Sums::new(), true);
    };
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
    (requests, limits, ok)
}

/// The table, from the node and the pods on it. `pods` is `None` when they
/// could not all be read, and then no sum is shown for any resource.
#[must_use]
pub fn budget(
    node: &Node,
    pods: Option<&[Pod]>,
    refused: Vec<String>,
    error: Option<String>,
) -> NodeBudget {
    let status = node.status.as_ref();
    let capacity = status.and_then(|s| s.capacity.as_ref());
    let allocatable = status.and_then(|s| s.allocatable.as_ref());

    let counted: Option<Vec<&Pod>> =
        pods.map(|all| all.iter().filter(|p| holds_reservation(p)).collect());
    let (requested, limited) = match &counted {
        Some(list) => {
            let mut requested = Sums::new();
            let mut limited = Sums::new();
            let mut ok = true;
            for pod in list {
                let (r, l, pod_ok) = pod_reservation(pod);
                ok &= pod_ok;
                for (k, v) in r {
                    *requested.entry(k).or_insert(0.0) += v;
                }
                for (k, v) in l {
                    *limited.entry(k).or_insert(0.0) += v;
                }
            }
            // A reservation we could not read makes every sum a smaller number
            // than the truth, so the whole column is unknown — the same answer
            // a refused namespace gives.
            if ok {
                requested.insert("pods".into(), list.len() as f64);
                (Some(requested), Some(limited))
            } else {
                (None, None)
            }
        }
        None => (None, None),
    };

    let mut names: Vec<String> = CORE.iter().map(|s| (*s).to_string()).collect();
    let mut extended: Vec<String> = capacity
        .into_iter()
        .chain(allocatable)
        .flat_map(|m| m.keys().cloned())
        .filter(|k| !CORE.contains(&k.as_str()))
        .collect();
    extended.sort();
    extended.dedup();
    names.extend(extended);

    let resources = names
        .into_iter()
        .map(|name| {
            let read = |m: Option<&BTreeMap<String, _>>| {
                m.and_then(|m| m.get(&name)).and_then(
                    |q: &k8s_openapi::apimachinery::pkg::api::resource::Quantity| {
                        parse(&name, &q.0)
                    },
                )
            };
            ResourceBudget {
                unit: unit_of(&name),
                capacity: read(capacity),
                allocatable: read(allocatable),
                requested: requested
                    .as_ref()
                    .map(|r| r.get(&name).copied().unwrap_or(0.0)),
                limited: if name == "pods" {
                    None
                } else {
                    limited
                        .as_ref()
                        .map(|l| l.get(&name).copied().unwrap_or(0.0))
                },
                extended: !CORE.contains(&name.as_str()),
                name,
            }
        })
        .collect();

    NodeBudget {
        pods: counted.as_ref().map(Vec::len),
        // The sums are numbers only when every counted pod's reservation
        // parsed; an unreadable one makes them unknown even though the pods
        // themselves were all listed.
        known: requested.is_some(),
        refused,
        error,
        resources,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::api::core::v1::{Container, PodSpec, PodStatus, ResourceRequirements};
    use k8s_openapi::apimachinery::pkg::api::resource::Quantity;

    fn q(map: &[(&str, &str)]) -> BTreeMap<String, Quantity> {
        map.iter()
            .map(|(k, v)| ((*k).to_string(), Quantity((*v).to_string())))
            .collect()
    }

    fn node() -> Node {
        Node {
            status: Some(k8s_openapi::api::core::v1::NodeStatus {
                capacity: Some(q(&[
                    ("cpu", "4"),
                    ("memory", "16Gi"),
                    ("pods", "110"),
                    ("ephemeral-storage", "100Gi"),
                    ("nvidia.com/gpu", "1"),
                ])),
                allocatable: Some(q(&[
                    ("cpu", "3800m"),
                    ("memory", "14Gi"),
                    ("pods", "110"),
                    ("ephemeral-storage", "90Gi"),
                    ("nvidia.com/gpu", "1"),
                ])),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    fn container(requests: &[(&str, &str)], limits: &[(&str, &str)]) -> Container {
        Container {
            resources: Some(ResourceRequirements {
                requests: Some(q(requests)),
                limits: Some(q(limits)),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    fn pod(phase: &str, containers: Vec<Container>, init: Vec<Container>) -> Pod {
        Pod {
            spec: Some(PodSpec {
                containers,
                init_containers: Some(init),
                ..Default::default()
            }),
            status: Some(PodStatus {
                phase: Some(phase.into()),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    fn row<'a>(b: &'a NodeBudget, name: &str) -> &'a ResourceBudget {
        b.resources.iter().find(|r| r.name == name).expect(name)
    }

    /// Summing the init container with the app containers would reserve
    /// CPU the scheduler never does; ignoring it would under-reserve when
    /// it is the largest.
    #[test]
    fn requested_is_the_schedulers_rule_over_pods_that_still_hold_a_place() {
        let pods = vec![
            pod(
                "Running",
                vec![
                    container(&[("cpu", "500m"), ("memory", "1Gi")], &[("cpu", "1")]),
                    container(&[("cpu", "500m")], &[("cpu", "1")]),
                ],
                vec![container(&[("cpu", "2")], &[("cpu", "2")])],
            ),
            pod("Succeeded", vec![container(&[("cpu", "3")], &[])], vec![]),
            pod(
                "Running",
                vec![container(
                    &[("nvidia.com/gpu", "1")],
                    &[("nvidia.com/gpu", "1")],
                )],
                vec![],
            ),
        ];
        let b = budget(&node(), Some(&pods), Vec::new(), None);
        assert!(b.known);
        assert_eq!(b.pods, Some(2));
        assert_eq!(row(&b, "cpu").requested, Some(2000.0));
        assert_eq!(row(&b, "cpu").limited, Some(2000.0));
        assert_eq!(row(&b, "memory").requested, Some(1024.0 * 1024.0 * 1024.0));
        assert_eq!(row(&b, "pods").requested, Some(2.0));
        assert_eq!(row(&b, "pods").limited, None);
        let gpu = row(&b, "nvidia.com/gpu");
        assert!(gpu.extended);
        assert_eq!(gpu.unit, BudgetUnit::Count);
        assert_eq!(gpu.capacity, Some(1.0));
        assert_eq!(gpu.requested, Some(1.0));
    }

    /// A partial sum over the readable namespaces is a smaller number
    /// presented as the whole, which is worse than no number.
    #[test]
    fn a_refused_namespace_makes_every_sum_unknown_not_smaller() {
        let b = budget(&node(), None, vec!["kube-system".into()], None);
        assert!(!b.known);
        assert_eq!(b.pods, None);
        assert_eq!(b.refused, vec!["kube-system".to_string()]);
        for r in &b.resources {
            assert_eq!(r.requested, None, "{}", r.name);
            assert_eq!(r.limited, None, "{}", r.name);
        }
        assert_eq!(
            row(&b, "cpu").capacity,
            Some(4000.0),
            "the node itself was read"
        );
    }

    #[test]
    fn a_pod_level_request_replaces_the_container_arithmetic() {
        let mut p = pod(
            "Running",
            vec![
                container(&[("cpu", "1")], &[]),
                container(&[("cpu", "1")], &[]),
            ],
            vec![],
        );
        p.spec.as_mut().unwrap().resources = Some(ResourceRequirements {
            requests: Some(q(&[("cpu", "300m")])),
            ..Default::default()
        });
        let b = budget(&node(), Some(&[p]), Vec::new(), None);
        assert_eq!(row(&b, "cpu").requested, Some(300.0));
    }

    /// A reservation whose quantity will not parse makes the sums smaller than
    /// the truth. The whole column is then unknown — the same answer a refused
    /// namespace gives — not a confident undercount, though the pod is still
    /// counted. Deleting the parse-failure branch collapses this to Some(0).
    #[test]
    fn an_unreadable_reservation_makes_the_sums_unknown_not_smaller() {
        let pods = vec![pod(
            "Running",
            vec![container(&[("cpu", "wat")], &[])],
            vec![],
        )];
        let b = budget(&node(), Some(&pods), Vec::new(), None);
        assert!(!b.known);
        assert_eq!(b.pods, Some(1), "the pod was still counted");
        for r in &b.resources {
            assert_eq!(r.requested, None, "{}", r.name);
            assert_eq!(r.limited, None, "{}", r.name);
        }
    }

    /// A capacity value the parser cannot read is unknown, not a node that has
    /// zero of that resource. `Some(0.0)` here would be the third-state
    /// collapse; the honest answer is `None`.
    #[test]
    fn an_unreadable_capacity_reads_as_unknown_not_zero() {
        let mut n = node();
        n.status.as_mut().unwrap().capacity = Some(q(&[
            ("cpu", "4"),
            ("memory", "16Gi"),
            ("pods", "110"),
            ("hugepages-2Mi", "wat"),
        ]));
        let b = budget(&n, Some(&[]), Vec::new(), None);
        assert_eq!(row(&b, "hugepages-2Mi").capacity, None);
        assert_eq!(row(&b, "cpu").capacity, Some(4000.0));
    }
}
