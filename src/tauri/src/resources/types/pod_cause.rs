//! Why a pod is red or amber, from the deepest evidence its own status
//! carries. The list, the page, the peek, Needs attention and Share read this
//! one answer; none of them works out its own.
//!
//! Evidence the pod does not carry, a run's log or the kubelet's events, is a
//! slot that says `notRead` until the reader that fetched it fills it in.

use chrono::{DateTime, Utc};
use k8s_openapi::api::core::v1::{ContainerStateTerminated, ContainerStatus, Event, Pod, Probe};
use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
use serde::{Deserialize, Serialize};

use super::pod_display::{
    blocking_init, condition_is_true, container_restarting_until, counted, last_terminated,
    pod_verdict,
};
use super::EventInfo;
use crate::utils::Moment;

/// The most of a termination message carried: its end is what says why.
const SAID_TAIL: usize = 1024;

/// The most warnings a pod the kubelet has not set up carries.
const MAX_WARNINGS: usize = 5;

/// The cause a pod's surfaces lead with, one variant per mechanism.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "says", rename_all = "camelCase")]
pub enum PodCause {
    /// A container's runs end, and how the last one did.
    Exits {
        container: String,
        restarts: i32,
        /// `None` where the kubelet restarted it and reported no exit.
        run: Option<EndedRun>,
        /// For a container up again since, when that exit stops being news;
        /// `None` while it is down. The reader compares it with its own clock.
        until: Option<DateTime<Utc>>,
    },
    /// No node takes the pod, in the scheduler's words and what they come to.
    Unplaced {
        said: Option<String>,
        since: Option<DateTime<Utc>>,
        /// How many nodes the scheduler weighed, where it said.
        nodes: Option<i32>,
        /// Why the nodes turned it down, one entry per reason it gave.
        why: Vec<Unfit>,
    },
    /// A container the kubelet cannot pull, build or start, in its words.
    Blocked {
        container: String,
        /// The kubelet's reason: `ErrImagePull`, `CreateContainerConfigError`, `RunContainerError`.
        reason: String,
        /// The kubelet's own sentence about it, as written.
        said: Option<String>,
        image: String,
        /// For a pull, what the registry's answer comes to.
        pull: Option<PullFailure>,
        /// The pull secrets the pod names, for a registry that refused it.
        secrets: Vec<String>,
    },
    /// Every container runs and the pod is still not Ready, so its Services
    /// leave it out: a readiness probe that fails, or one that has not passed yet.
    NotReady {
        /// The running containers that are not ready, in spec order.
        containers: Vec<String>,
        /// When the `Ready` condition last turned `False`.
        since: Option<DateTime<Utc>>,
        /// From when it counts as trouble, past the first passes a probe fails
        /// on every start; `None` where `since` is unknown, which counts now.
        #[serde(rename = "countsFrom")]
        counts_from: Option<DateTime<Utc>>,
        /// The first of them's readiness probe, as declared; `None` where it has none.
        probe: Option<ProbeCheck>,
    },
    /// Placed on a node whose kubelet has not started a container: its
    /// sandbox waits on the volumes it mounts and on the network plugin.
    Creating {
        /// The uid of the pod read, whose warnings say why; a workload's names one of its pods.
        uid: String,
        /// When the scheduler placed it.
        since: Option<DateTime<Utc>>,
        /// `PodReadyToStartContainers`, where the cluster reports it.
        sandbox: Option<bool>,
        kubelet: Warned,
    },
}

/// What the kubelet warned about a pod it has not set up, once a reader asks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "says", rename_all = "camelCase")]
pub enum Warned {
    NotRead,
    Reading,
    /// Newest first; none where it warned nothing or the warnings expired.
    Read {
        warnings: Vec<SetupWarning>,
    },
    Refused,
    Failed {
        said: String,
    },
}

/// One of the kubelet's warnings about a pod, and what it comes to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupWarning {
    /// `FailedMount`, `FailedAttachVolume`, `FailedCreatePodSandBox`.
    pub reason: String,
    pub said: String,
    pub count: i32,
    pub at: Option<DateTime<Utc>>,
    pub fault: SetupFault,
}

/// What a setup warning comes to, where this app knows the kubelet's words.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "says", rename_all = "camelCase")]
pub enum SetupFault {
    /// `configmap "web-config" not found`: the object a volume mounts does not exist.
    Missing {
        volume: Option<String>,
        kind: String,
        name: String,
    },
    /// A volume the kubelet cannot attach or mount for another reason.
    Volume {
        volume: Option<String>,
    },
    /// The sandbox, which the network plugin sets up.
    Sandbox,
    Other,
}

/// One reason the scheduler gave for a set of nodes, and how many it covers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "says", rename_all = "camelCase")]
pub enum Unfit {
    /// `Insufficient cpu`: the free amount is short of the pod's request.
    Short {
        resource: String,
        nodes: i32,
    },
    /// A taint the pod does not tolerate, as the scheduler printed it.
    Taint {
        taint: String,
        nodes: i32,
    },
    /// The pod's nodeSelector or required node affinity.
    Selector {
        nodes: i32,
    },
    /// Inter-pod affinity or anti-affinity.
    PodAffinity {
        nodes: i32,
    },
    /// Cordoned.
    Cordoned {
        nodes: i32,
    },
    TooManyPods {
        nodes: i32,
    },
    /// A bound volume pins the pod to nodes it cannot use.
    VolumeZone {
        nodes: i32,
    },
    Topology {
        nodes: i32,
    },
    /// Its claims are not bound, so the scheduler did not weigh nodes at all.
    ClaimsUnbound,
    /// A reason this app does not know yet, quoted.
    Other {
        text: String,
        nodes: Option<i32>,
    },
}

/// What a registry's refusal to hand over an image comes to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PullFailure {
    NotFound,
    Denied,
    RateLimited,
    Unreachable,
    /// `ImagePullBackOff`: the kubelet waits, and its message names no error.
    BackingOff,
    Other,
}

/// What a readiness probe asks, as its spec says.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "says", rename_all = "camelCase")]
pub enum ProbeCheck {
    Http {
        scheme: String,
        path: String,
        port: String,
    },
    Tcp {
        port: String,
    },
    Grpc {
        port: i32,
    },
    Exec {
        command: Vec<String>,
    },
}

/// One ended run of a container, as the kubelet recorded it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndedRun {
    pub code: i32,
    pub signal: Option<i32>,
    /// The kubelet's word: `Error`, `OOMKilled`, `Completed`, `StartError`.
    pub reason: Option<String>,
    pub started: Option<DateTime<Utc>>,
    pub ended: Option<DateTime<Utc>>,
    /// The run before the one the container is in, which `--previous` reads.
    pub previous: bool,
    /// The tail of the container's termination message, as it wrote it.
    pub said: Option<String>,
    /// What the run printed before it ended.
    pub log: Evidence,
    /// The container's memory limit as declared, which an OOM kill is measured against.
    pub limit: Option<String>,
}

/// What a reader found where the pod's own status stops.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "says", rename_all = "camelCase")]
pub enum Evidence {
    /// A line of a log, and whether it is the last one.
    Line {
        text: String,
        last: bool,
    },
    /// Nobody asked for it yet.
    NotRead,
    Reading,
    /// Asked, and there was none: the run printed nothing, or no event is kept.
    Nothing,
    /// The node no longer holds that run's log.
    Gone,
    Refused,
    Failed {
        said: String,
    },
}

/// The cause most of a workload's pods share, how many share it, and how many it runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedCause {
    pub cause: PodCause,
    pub pods: i32,
    pub of: i32,
}

/// How long a running pod may stay not Ready before it counts as trouble:
/// longer than a readiness probe's usual first passes.
pub const NOT_READY_GRACE: chrono::Duration = chrono::Duration::minutes(2);

/// Read once here for the Overview's rows and a workload's own page alike.
#[must_use]
pub fn shared_cause<'a>(pods: impl IntoIterator<Item = &'a Pod>) -> Option<SharedCause> {
    shared_cause_by(pods, pod_cause)
}

/// [`shared_cause`] over the cause each pod counts by, as `cause_of` reads it.
pub fn shared_cause_by<'a>(
    pods: impl IntoIterator<Item = &'a Pod>,
    cause_of: impl Fn(&Pod) -> Option<PodCause>,
) -> Option<SharedCause> {
    share(
        pods.into_iter()
            .map(|pod| (pod.metadata.deletion_timestamp.is_some(), cause_of(pod))),
    )
}

/// The rule `shared_cause` applies, over each pod's deletion and cause.
///
/// `src/contracts/shared-cause-conformance.json` holds the answers, and
/// `sharedCause` in `src/ui/lib/pod-cause.ts` owes the same ones.
fn share(pods: impl IntoIterator<Item = (bool, Option<PodCause>)>) -> Option<SharedCause> {
    let mut of = 0;
    let mut groups: Vec<(String, PodCause, i32)> = Vec::new();
    for (deleting, cause) in pods {
        if deleting {
            continue;
        }
        of += 1;
        let Some(cause) = cause else {
            continue;
        };
        let key = cause_key(&cause);
        match groups.iter_mut().find(|(k, _, _)| *k == key) {
            Some((_, _, n)) => *n += 1,
            None => groups.push((key, cause, 1)),
        }
    }
    let (_, cause, pods) = groups.into_iter().max_by_key(|(_, _, n)| *n)?;
    Some(SharedCause { cause, pods, of })
}

/// Two pods share a cause when it is the same mechanism in the same container.
fn cause_key(cause: &PodCause) -> String {
    match cause {
        PodCause::Exits { container, run, .. } => format!(
            "exits/{container}/{:?}",
            run.as_ref().map(|r| (r.code, r.reason.clone()))
        ),
        PodCause::Blocked {
            container,
            reason,
            pull,
            ..
        } => format!("blocked/{container}/{reason}/{pull:?}"),
        PodCause::NotReady { containers, .. } => format!("notReady/{containers:?}"),
        PodCause::Unplaced { why, .. } => format!("unplaced/{why:?}"),
        PodCause::Creating { .. } => "creating".to_string(),
    }
}

impl PodCause {
    /// The cause with the kubelet's warnings a reader fetched beside it.
    #[must_use]
    pub fn warned(self, warned: Warned) -> Self {
        match self {
            Self::Creating {
                uid,
                since,
                sandbox,
                ..
            } => Self::Creating {
                uid,
                since,
                sandbox,
                kubelet: warned,
            },
            other => other,
        }
    }
}

/// The kubelet's warnings about the pod with this uid, newest first. The
/// scheduler's are left out: they are from before the pod had a node.
#[must_use]
pub fn setup_warnings<'a>(
    uid: &str,
    events: impl IntoIterator<Item = &'a Event>,
) -> Vec<SetupWarning> {
    let mut warnings: Vec<SetupWarning> = events
        .into_iter()
        .filter(|event| {
            event.type_.as_deref() == Some("Warning")
                && event.involved_object.uid.as_deref() == Some(uid)
        })
        .filter_map(|event| {
            let info = EventInfo::from(event);
            let reason = info.reason.filter(|r| r != "FailedScheduling")?;
            let said = info.message.unwrap_or_default();
            Some(SetupWarning {
                fault: setup_fault(&reason, &said),
                said: tail(said.trim()),
                reason,
                count: info.count.unwrap_or(1),
                at: info.last_timestamp,
            })
        })
        .collect();
    warnings.sort_by(|a, b| b.at.cmp(&a.at));
    warnings.truncate(MAX_WARNINGS);
    warnings
}

/// The volume sources a mount names when it is missing, by the kubelet's word for each.
const SOURCES: &[(&str, &str)] = &[
    ("configmap", "ConfigMap"),
    ("secret", "Secret"),
    ("persistentvolumeclaim", "PersistentVolumeClaim"),
];

fn setup_fault(reason: &str, said: &str) -> SetupFault {
    if matches!(reason, "FailedCreatePodSandBox" | "NetworkNotReady") {
        return SetupFault::Sandbox;
    }
    if !matches!(
        reason,
        "FailedMount" | "FailedAttachVolume" | "FailedMapVolume"
    ) {
        return SetupFault::Other;
    }
    let volume = quoted_after(said, "for volume ");
    let missing = SOURCES.iter().find_map(|(word, kind)| {
        let name = quoted_after(said, &format!("{word} "))?;
        said.contains(&format!("{word} \"{name}\" not found"))
            .then(|| (kind.to_string(), name))
    });
    match missing {
        Some((kind, name)) => SetupFault::Missing { volume, kind, name },
        None => SetupFault::Volume { volume },
    }
}

/// The `"..."` right after `prefix`: `for volume "cfg"` gives `cfg`.
fn quoted_after(text: &str, prefix: &str) -> Option<String> {
    let rest = &text[text.find(prefix)? + prefix.len()..];
    let rest = rest.strip_prefix('"')?;
    Some(rest[..rest.find('"')?].to_string())
}

/// What is wrong with this pod and why, or `None` where nothing this reads is.
///
/// Read without a clock, so a watched row stays true: a container down now
/// comes before one up since its last exit, which carries when it stops
/// counting. A pod being deleted, or one with the kubelet's own verdict on it
/// as a whole, is not explained by its containers.
#[must_use]
pub fn pod_cause(pod: &Pod) -> Option<PodCause> {
    if pod.metadata.deletion_timestamp.is_some() || pod_verdict(pod).is_some() {
        return None;
    }
    let status = pod.status.as_ref()?;
    if let Some(unplaced) = unplaced(pod) {
        return Some(unplaced);
    }
    let initializing = status.phase.as_deref().is_none_or(|p| p == "Pending")
        && !condition_is_true(Some(status), "Initialized");
    let candidates = match blocking_init(pod).filter(|_| initializing) {
        Some((_, held)) => vec![held],
        None => counted(pod),
    };
    let running = status.phase.as_deref() == Some("Running");
    candidates
        .iter()
        .find_map(|cs| down(cs))
        .or_else(|| candidates.iter().find_map(|cs| up_again(cs, running)))
        .map(|cause| with_limit(cause, pod))
        .or_else(|| candidates.iter().find_map(|cs| blocked(cs, pod)))
        .or_else(|| creating(pod))
        .or_else(|| not_ready(pod))
}

/// What the kubelet calls a sandbox that is up, by the name each release gave it.
const SANDBOX_CONDITIONS: &[&str] = &["PodReadyToStartContainers", "PodHasNetwork"];

/// The waits a container is in before the kubelet has created it.
const NOT_CREATED: &[&str] = &["ContainerCreating", "PodInitializing"];

/// Placed and not started, with no sandbox, or no word on one and every
/// container still waiting to be created. A sandbox that is up is a pull or a
/// start the kubelet is still doing, which `blocked` reads once it fails.
fn creating(pod: &Pod) -> Option<PodCause> {
    let status = pod.status.as_ref()?;
    if status.phase.as_deref() != Some("Pending") {
        return None;
    }
    let conditions = status.conditions.as_deref().unwrap_or_default();
    let placed = conditions
        .iter()
        .find(|c| c.type_ == "PodScheduled" && c.status == "True")?;
    let sandbox = conditions
        .iter()
        .find(|c| SANDBOX_CONDITIONS.contains(&c.type_.as_str()))
        .map(|c| c.status == "True");
    if sandbox == Some(true) {
        return None;
    }
    let states: Vec<_> = status
        .init_container_statuses
        .iter()
        .chain(status.container_statuses.iter())
        .flatten()
        .filter_map(|cs| cs.state.as_ref())
        .collect();
    let started = states
        .iter()
        .any(|s| s.running.is_some() || s.terminated.is_some());
    let waiting = states.iter().any(|s| {
        s.waiting
            .as_ref()
            .and_then(|w| w.reason.as_deref())
            .is_some_and(|r| NOT_CREATED.contains(&r))
    });
    if started || (sandbox.is_none() && !waiting) {
        return None;
    }
    Some(PodCause::Creating {
        uid: pod.metadata.uid.clone()?,
        since: placed.last_transition_time.as_ref().map(Moment::moment),
        sandbox,
        kubelet: Warned::NotRead,
    })
}

fn unplaced(pod: &Pod) -> Option<PodCause> {
    let status = pod.status.as_ref()?;
    if status.phase.as_deref() != Some("Pending") {
        return None;
    }
    let scheduled = status
        .conditions
        .as_deref()?
        .iter()
        .find(|c| c.type_ == "PodScheduled" && c.status == "False")?;
    let said = scheduled.message.clone().filter(|m| !m.is_empty());
    let (nodes, why) = said.as_deref().map(scheduler_reasons).unwrap_or_default();
    Some(PodCause::Unplaced {
        said,
        since: scheduled.last_transition_time.as_ref().map(Moment::moment),
        nodes,
        why,
    })
}

/// `0/3 nodes are available: 1 node(s) had untolerated taint {x: }, 2 Insufficient cpu. preemption: ...`
fn scheduler_reasons(said: &str) -> (Option<i32>, Vec<Unfit>) {
    if said.contains("unbound immediate PersistentVolumeClaims") {
        return (None, vec![Unfit::ClaimsUnbound]);
    }
    let Some((head, rest)) = said.split_once(" nodes are available: ") else {
        return (None, vec![]);
    };
    let nodes = head.rsplit('/').next().and_then(|n| n.trim().parse().ok());
    // The reasons end with the first sentence; newer schedulers add more after it.
    let body = rest
        .split(". ")
        .next()
        .unwrap_or(rest)
        .trim_end_matches('.');
    let why = split_outside_braces(body)
        .into_iter()
        .filter_map(|part| {
            let (count, text) = part.trim().split_once(' ')?;
            let n: i32 = count.parse().ok()?;
            Some(unfit(text.trim(), n))
        })
        .collect();
    (nodes, why)
}

fn split_outside_braces(text: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let (mut depth, mut start) = (0i32, 0usize);
    for (at, ch) in text.char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => depth -= 1,
            ',' if depth == 0 => {
                parts.push(&text[start..at]);
                start = at + 1;
            }
            _ => {}
        }
    }
    parts.push(&text[start..]);
    parts
}

fn unfit(text: &str, nodes: i32) -> Unfit {
    if let Some(resource) = text.strip_prefix("Insufficient ") {
        return Unfit::Short {
            resource: resource.to_string(),
            nodes,
        };
    }
    if let Some(taint) = text
        .split_once("untolerated taint")
        .or_else(|| text.split_once("had taint"))
        .map(|(_, taint)| {
            taint
                .trim()
                .trim_end_matches(", that the pod didn't tolerate")
        })
    {
        return Unfit::Taint {
            taint: taint.to_string(),
            nodes,
        };
    }
    let has = |words: &str| text.contains(words);
    if has("node affinity/selector") || has("node selector") {
        Unfit::Selector { nodes }
    } else if has("pod affinity") || has("pod anti-affinity") {
        Unfit::PodAffinity { nodes }
    } else if has("unschedulable") {
        Unfit::Cordoned { nodes }
    } else if has("Too many pods") {
        Unfit::TooManyPods { nodes }
    } else if has("volume node affinity conflict") {
        Unfit::VolumeZone { nodes }
    } else if has("topology spread constraints") {
        Unfit::Topology { nodes }
    } else {
        Unfit::Other {
            text: text.to_string(),
            nodes: Some(nodes),
        }
    }
}

const BLOCKED: &[&str] = &[
    "ErrImagePull",
    "ImagePullBackOff",
    "InvalidImageName",
    "CreateContainerConfigError",
    "CreateContainerError",
    "RunContainerError",
];

fn blocked(cs: &ContainerStatus, pod: &Pod) -> Option<PodCause> {
    let waiting = cs.state.as_ref()?.waiting.as_ref()?;
    let reason = waiting.reason.as_deref().filter(|r| BLOCKED.contains(r))?;
    let said = waiting
        .message
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map(tail);
    let pull = matches!(reason, "ErrImagePull" | "ImagePullBackOff")
        .then(|| pull_failure(reason, said.as_deref().unwrap_or_default()));
    let secrets = pod
        .spec
        .as_ref()
        .and_then(|s| s.image_pull_secrets.as_ref())
        .map(|refs| refs.iter().map(|r| r.name.clone()).collect())
        .unwrap_or_default();
    Some(PodCause::Blocked {
        container: cs.name.clone(),
        reason: reason.to_string(),
        said,
        image: cs.image.clone(),
        pull,
        secrets,
    })
}

/// The registry's answer, by the words containerd, CRI-O and Docker use for it.
fn pull_failure(reason: &str, said: &str) -> PullFailure {
    let said = said.to_ascii_lowercase();
    let any = |words: &[&str]| words.iter().any(|w| said.contains(w));
    if any(&["toomanyrequests", "429", "rate limit"]) {
        PullFailure::RateLimited
    } else if any(&[
        "unauthorized",
        "pull access denied",
        "authentication required",
        "403 forbidden",
        "denied",
    ]) {
        PullFailure::Denied
    } else if any(&["not found", "manifest unknown", "no such image"]) {
        PullFailure::NotFound
    } else if any(&[
        "no such host",
        "i/o timeout",
        "connection refused",
        "network is unreachable",
        "tls handshake timeout",
    ]) {
        PullFailure::Unreachable
    } else if reason == "ImagePullBackOff" {
        PullFailure::BackingOff
    } else {
        PullFailure::Other
    }
}

fn not_ready(pod: &Pod) -> Option<PodCause> {
    let status = pod.status.as_ref()?;
    if status.phase.as_deref() != Some("Running") || condition_is_true(Some(status), "Ready") {
        return None;
    }
    let statuses = status.container_statuses.as_deref().unwrap_or_default();
    let all_running = !statuses.is_empty()
        && statuses
            .iter()
            .all(|cs| cs.state.as_ref().is_some_and(|s| s.running.is_some()));
    let containers: Vec<String> = statuses
        .iter()
        .filter(|cs| !cs.ready)
        .map(|cs| cs.name.clone())
        .collect();
    if !all_running || containers.is_empty() {
        return None;
    }
    let since = status
        .conditions
        .as_deref()
        .unwrap_or_default()
        .iter()
        .find(|c| c.type_ == "Ready")
        .and_then(|c| c.last_transition_time.as_ref())
        .map(Moment::moment);
    let probe = pod
        .spec
        .as_ref()?
        .containers
        .iter()
        .find(|c| c.name == containers[0])
        .and_then(|c| c.readiness_probe.as_ref())
        .and_then(probe_check);
    Some(PodCause::NotReady {
        containers,
        since,
        counts_from: since.map(|at| at + NOT_READY_GRACE),
        probe,
    })
}

fn port_text(port: &IntOrString) -> String {
    match port {
        IntOrString::Int(n) => n.to_string(),
        IntOrString::String(name) => name.clone(),
    }
}

fn probe_check(probe: &Probe) -> Option<ProbeCheck> {
    if let Some(http) = &probe.http_get {
        return Some(ProbeCheck::Http {
            scheme: http.scheme.clone().unwrap_or_else(|| "HTTP".to_string()),
            path: http.path.clone().unwrap_or_else(|| "/".to_string()),
            port: port_text(&http.port),
        });
    }
    if let Some(tcp) = &probe.tcp_socket {
        return Some(ProbeCheck::Tcp {
            port: port_text(&tcp.port),
        });
    }
    if let Some(grpc) = &probe.grpc {
        return Some(ProbeCheck::Grpc { port: grpc.port });
    }
    let command = probe.exec.as_ref()?.command.clone().unwrap_or_default();
    Some(ProbeCheck::Exec { command })
}

fn with_limit(mut cause: PodCause, pod: &Pod) -> PodCause {
    let PodCause::Exits {
        container,
        run: Some(run),
        ..
    } = &mut cause
    else {
        return cause;
    };
    run.limit = pod.spec.as_ref().and_then(|spec| {
        spec.containers
            .iter()
            .chain(spec.init_containers.iter().flatten())
            .find(|c| &c.name == container)?
            .resources
            .as_ref()?
            .limits
            .as_ref()?
            .get("memory")
            .map(|q| q.0.clone())
    });
    cause
}

/// A container down after a run that ended badly, or backing off from one.
fn down(cs: &ContainerStatus) -> Option<PodCause> {
    let state = cs.state.as_ref()?;
    if let Some(ended) = state
        .terminated
        .as_ref()
        .filter(|t| t.exit_code != 0 || t.signal.unwrap_or(0) != 0)
    {
        return Some(exits(cs, Some(ended_run(ended, false)), None));
    }
    let waiting = state.waiting.as_ref()?.reason.as_deref()?;
    (waiting == "CrashLoopBackOff")
        .then(|| exits(cs, last_terminated(cs).map(|t| ended_run(t, true)), None))
}

/// A container up again after exits that are still news, or after restarts
/// the kubelet reported no exit for.
fn up_again(cs: &ContainerStatus, running: bool) -> Option<PodCause> {
    if let Some(until) = container_restarting_until(cs) {
        let run = last_terminated(cs).map(|t| ended_run(t, true));
        return Some(exits(cs, run, Some(until)));
    }
    let unreported = running
        && cs.restart_count > 0
        && last_terminated(cs).is_none()
        && cs
            .state
            .as_ref()
            .and_then(|s| s.terminated.as_ref())
            .is_none();
    unreported.then(|| exits(cs, None, None))
}

fn exits(cs: &ContainerStatus, run: Option<EndedRun>, until: Option<DateTime<Utc>>) -> PodCause {
    PodCause::Exits {
        container: cs.name.clone(),
        restarts: cs.restart_count,
        run,
        until,
    }
}

fn ended_run(t: &ContainerStateTerminated, previous: bool) -> EndedRun {
    EndedRun {
        code: t.exit_code,
        signal: t.signal.filter(|s| *s != 0),
        reason: t.reason.clone().filter(|r| !r.is_empty()),
        // The kubelet writes the epoch as the start of a run that never began.
        started: t
            .started_at
            .as_ref()
            .map(Moment::moment)
            .filter(|at| at.timestamp() > 0),
        ended: t.finished_at.as_ref().map(Moment::moment),
        previous,
        said: t
            .message
            .as_deref()
            .map(str::trim)
            .filter(|m| !m.is_empty())
            .map(tail),
        log: Evidence::NotRead,
        limit: None,
    }
}

fn tail(message: &str) -> String {
    let mut start = message.len().saturating_sub(SAID_TAIL);
    while !message.is_char_boundary(start) {
        start += 1;
    }
    message[start..].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pod(json: serde_json::Value) -> Pod {
        serde_json::from_value(json).expect("a pod this test wrote itself")
    }

    /// `shop/checkout` as the kubelet reports it between two runs: backing
    /// off, its last exit 1 with the app's own message kept.
    fn backing_off() -> Pod {
        pod(serde_json::json!({
            "metadata": {"name": "checkout-7c9", "namespace": "shop"},
            "spec": {"containers": [{"name": "api", "image": "shop/checkout:1"}]},
            "status": {
                "phase": "Running",
                "containerStatuses": [{
                    "name": "api", "image": "shop/checkout:1", "imageID": "", "ready": false,
                    "restartCount": 7,
                    "state": {"waiting": {"reason": "CrashLoopBackOff", "message": "back-off 5m0s restarting failed container=api"}},
                    "lastState": {"terminated": {
                        "exitCode": 1, "reason": "Error",
                        "message": "starting\nError: couldn't find key DB_PASSWORD in Secret checkout-db\n",
                        "startedAt": "2026-10-12T10:00:00Z", "finishedAt": "2026-10-12T10:00:03Z"
                    }}
                }]
            }
        }))
    }

    /// The headline every surface used to print for a loop was the restart
    /// count. Fails if the loop stops carrying the exit it backs off from.
    #[test]
    fn a_container_backing_off_is_explained_by_the_run_it_backs_off_from() {
        let Some(PodCause::Exits {
            container,
            restarts,
            run: Some(run),
            until,
        }) = pod_cause(&backing_off())
        else {
            panic!("a crash loop has a cause");
        };
        assert_eq!(container, "api");
        assert_eq!(restarts, 7);
        assert_eq!(until, None, "down now, so news until it is up again");
        assert_eq!(run.code, 1);
        assert_eq!(run.reason.as_deref(), Some("Error"));
        assert!(
            run.previous,
            "the run it backs off from is the previous one"
        );
        assert_eq!(
            run.ended.map(|at| at.to_rfc3339()),
            Some("2026-10-12T10:00:03+00:00".to_string())
        );
        assert_eq!(
            run.said.as_deref(),
            Some("starting\nError: couldn't find key DB_PASSWORD in Secret checkout-db")
        );
        assert_eq!(run.log, Evidence::NotRead);
    }

    /// A loop the kubelet reports no exit for is still a loop, and says so
    /// rather than inventing one. Fails if it is dropped as having no cause.
    #[test]
    fn a_loop_with_no_exit_reported_still_has_a_cause_and_no_run() {
        let mut pod = backing_off();
        pod.status
            .as_mut()
            .unwrap()
            .container_statuses
            .as_mut()
            .unwrap()[0]
            .last_state = None;
        assert!(matches!(
            pod_cause(&pod),
            Some(PodCause::Exits {
                run: None,
                until: None,
                ..
            })
        ));
    }

    /// A container sitting in a failed exit is the current run, which the
    /// log reads without `--previous`.
    #[test]
    fn a_container_that_just_exited_is_its_current_run() {
        let mut pod = backing_off();
        let cs = &mut pod
            .status
            .as_mut()
            .unwrap()
            .container_statuses
            .as_mut()
            .unwrap()[0];
        cs.state = cs.last_state.take();
        let Some(PodCause::Exits { run: Some(run), .. }) = pod_cause(&pod) else {
            panic!("a failed exit has a cause");
        };
        assert!(!run.previous);
    }

    /// Up again after short exits: the cause is the last exit, and it says
    /// when it stops being news. Fails if a running container's recent exits
    /// are dropped, or carried as though it were still down.
    #[test]
    fn a_container_up_again_after_short_exits_carries_until_when() {
        let mut pod = backing_off();
        let cs = &mut pod
            .status
            .as_mut()
            .unwrap()
            .container_statuses
            .as_mut()
            .unwrap()[0];
        cs.state = serde_json::from_value(
            serde_json::json!({"running": {"startedAt": "2026-10-12T10:00:30Z"}}),
        )
        .unwrap();
        let Some(PodCause::Exits {
            until: Some(until),
            run: Some(run),
            ..
        }) = pod_cause(&pod)
        else {
            panic!("recent exits are a cause");
        };
        assert!(run.previous);
        assert_eq!(until.to_rfc3339(), "2026-10-12T11:00:03+00:00");
    }

    /// A pod held on its init container is explained by that container,
    /// not by app containers that never started.
    #[test]
    fn a_pod_held_in_init_is_explained_by_the_init_container() {
        let pod = pod(serde_json::json!({
            "metadata": {"name": "init-demo"},
            "spec": {
                "initContainers": [{"name": "migrate"}],
                "containers": [{"name": "app"}]
            },
            "status": {
                "phase": "Pending",
                "conditions": [{"type": "Initialized", "status": "False"}],
                "initContainerStatuses": [{
                    "name": "migrate", "image": "", "imageID": "", "ready": false, "restartCount": 4,
                    "state": {"waiting": {"reason": "CrashLoopBackOff"}},
                    "lastState": {"terminated": {"exitCode": 2, "reason": "Error"}}
                }],
                "containerStatuses": [{
                    "name": "app", "image": "", "imageID": "", "ready": false, "restartCount": 0,
                    "state": {"waiting": {"reason": "PodInitializing"}}
                }]
            }
        }));
        assert!(matches!(
            pod_cause(&pod),
            Some(PodCause::Exits { container, .. }) if container == "migrate"
        ));
    }

    /// The kubelet's verdict on the whole pod outranks its containers: an
    /// evicted pod's container reads exit 137 because the node stopped it.
    #[test]
    fn an_evicted_pod_is_not_explained_by_its_containers() {
        let mut pod = backing_off();
        let status = pod.status.as_mut().unwrap();
        status.phase = Some("Failed".to_string());
        status.reason = Some("Evicted".to_string());
        assert_eq!(pod_cause(&pod), None);
    }

    /// An OOM kill is measured against the limit the container declared.
    /// Fails if the cause stops carrying it, or carries another container's.
    #[test]
    fn an_exit_carries_its_containers_memory_limit() {
        let mut pod = backing_off();
        pod.spec = serde_json::from_value(serde_json::json!({"containers": [
            {"name": "sidecar", "resources": {"limits": {"memory": "64Mi"}}},
            {"name": "api", "resources": {"limits": {"memory": "256Mi"}}}
        ]}))
        .ok();
        let Some(PodCause::Exits { run: Some(run), .. }) = pod_cause(&pod) else {
            panic!("a crash loop has a cause");
        };
        assert_eq!(run.limit.as_deref(), Some("256Mi"));
    }

    fn not_ready_pod() -> Pod {
        pod(serde_json::json!({
            "metadata": {"name": "web-1", "namespace": "shop"},
            "spec": {"containers": [{"name": "web", "readinessProbe": {
                "httpGet": {"path": "/ready", "port": 8080}
            }}]},
            "status": {
                "phase": "Running",
                "conditions": [{"type": "Ready", "status": "False",
                    "lastTransitionTime": "2026-10-12T10:00:00Z"}],
                "containerStatuses": [{
                    "name": "web", "image": "", "imageID": "", "ready": false, "restartCount": 0,
                    "state": {"running": {"startedAt": "2026-10-12T09:59:50Z"}}
                }]
            }
        }))
    }

    /// Running and left out of its Services: the cause names the probe that
    /// keeps it out and since when. Fails if the branch is dropped.
    #[test]
    fn a_running_pod_that_is_not_ready_names_its_readiness_probe() {
        assert_eq!(
            pod_cause(&not_ready_pod()),
            Some(PodCause::NotReady {
                containers: vec!["web".to_string()],
                since: Some("2026-10-12T10:00:00Z".parse().unwrap()),
                counts_from: Some("2026-10-12T10:02:00Z".parse().unwrap()),
                probe: Some(ProbeCheck::Http {
                    scheme: "HTTP".to_string(),
                    path: "/ready".to_string(),
                    port: "8080".to_string(),
                }),
            })
        );
    }

    /// The Overview reads pods its cache stripped: a probe dropped there read
    /// as none declared on every not-Ready row. Fails if the strip loses it.
    #[test]
    fn a_stripped_pod_still_names_its_readiness_probe() {
        let mut pod = not_ready_pod();
        crate::overview::strip_pod(&mut pod);
        assert!(matches!(
            pod_cause(&pod),
            Some(PodCause::NotReady {
                probe: Some(ProbeCheck::Http { .. }),
                ..
            })
        ));
    }

    /// A container still starting is not "running and not ready"; its own
    /// state is the story. Fails if a waiting container is called not ready.
    #[test]
    fn a_pod_with_a_container_not_running_is_not_called_not_ready() {
        let mut pod = not_ready_pod();
        pod.status
            .as_mut()
            .unwrap()
            .container_statuses
            .as_mut()
            .unwrap()[0]
            .state =
            serde_json::from_value(serde_json::json!({"waiting": {"reason": "ContainerCreating"}}))
                .unwrap();
        assert_eq!(pod_cause(&pod), None);
    }

    /// No probe declared is said as none, not as a probe that fails.
    #[test]
    fn a_container_with_no_readiness_probe_carries_none() {
        let mut pod = not_ready_pod();
        pod.spec.as_mut().unwrap().containers[0].readiness_probe = None;
        assert!(matches!(
            pod_cause(&pod),
            Some(PodCause::NotReady { probe: None, .. })
        ));
    }

    fn pending_with(message: &str) -> Pod {
        pod(serde_json::json!({
            "metadata": {"name": "big-1", "namespace": "shop"},
            "spec": {"containers": [{"name": "big"}]},
            "status": {
                "phase": "Pending",
                "conditions": [{"type": "PodScheduled", "status": "False", "reason": "Unschedulable",
                    "message": message, "lastTransitionTime": "2026-10-12T10:00:00Z"}]
            }
        }))
    }

    /// The scheduler's one line is several reasons over several nodes.
    /// Fails if a reason is lost, miscounted, or a taint is split at its comma.
    #[test]
    fn a_pod_no_node_takes_carries_each_reason_with_its_nodes() {
        let Some(PodCause::Unplaced { nodes, why, .. }) = pod_cause(&pending_with(
            "0/4 nodes are available: 1 node(s) had untolerated taint {node-role.kubernetes.io/control-plane: }, \
             2 Insufficient cpu, 1 node(s) didn't match Pod's node affinity/selector. \
             preemption: 0/4 nodes are available: 4 Preemption is not helpful for scheduling.",
        )) else {
            panic!("an unplaced pod has a cause");
        };
        assert_eq!(nodes, Some(4));
        assert_eq!(
            why,
            vec![
                Unfit::Taint {
                    taint: "{node-role.kubernetes.io/control-plane: }".to_string(),
                    nodes: 1
                },
                Unfit::Short {
                    resource: "cpu".to_string(),
                    nodes: 2
                },
                Unfit::Selector { nodes: 1 },
            ]
        );
    }

    /// k3s 1.31 writes ". no new claims to deallocate, preemption: ..." after
    /// the reasons; read as one of them it named the resource "cpu. no new
    /// claims to deallocate". Fails if anything past the first sentence is read.
    #[test]
    fn only_the_first_sentence_of_the_schedulers_line_is_reasons() {
        let Some(PodCause::Unplaced { why, .. }) = pod_cause(&pending_with(
            "0/2 nodes are available: 2 Insufficient cpu. no new claims to deallocate, preemption: 0/2 nodes are available: 2 Preemption is not helpful for scheduling.",
        )) else {
            panic!("an unplaced pod has a cause");
        };
        assert_eq!(
            why,
            vec![Unfit::Short {
                resource: "cpu".to_string(),
                nodes: 2
            }]
        );
    }

    /// Unbound claims stop the scheduler before it weighs a node; calling
    /// that "no node fits" sent readers to node capacity. Fails if it does.
    #[test]
    fn unbound_claims_are_their_own_reason_and_weigh_no_nodes() {
        assert!(matches!(
            pod_cause(&pending_with("0/3 nodes are available: pod has unbound immediate PersistentVolumeClaims. preemption: 0/3 nodes are available: 3 Preemption is not helpful for scheduling.")),
            Some(PodCause::Unplaced { nodes: None, why, .. }) if why == vec![Unfit::ClaimsUnbound]
        ));
    }

    /// A reason this app has no word for is quoted, never dropped.
    #[test]
    fn an_unknown_scheduler_reason_is_kept_as_written() {
        assert!(matches!(
            pod_cause(&pending_with("0/1 nodes are available: 1 node(s) had volume limit exceeded.")),
            Some(PodCause::Unplaced { why, .. })
                if why == vec![Unfit::Other { text: "node(s) had volume limit exceeded".to_string(), nodes: Some(1) }]
        ));
    }

    fn waiting_pod(reason: &str, message: &str) -> Pod {
        pod(serde_json::json!({
            "metadata": {"name": "api-1", "namespace": "shop"},
            "spec": {"containers": [{"name": "api"}], "imagePullSecrets": [{"name": "regcred"}]},
            "status": {
                "phase": "Pending",
                "containerStatuses": [{
                    "name": "api", "image": "registry.example/shop/api:9", "imageID": "",
                    "ready": false, "restartCount": 0,
                    "state": {"waiting": {"reason": reason, "message": message}}
                }]
            }
        }))
    }

    /// Each registry answer is its own cause. Fails if one is read as another.
    #[test]
    fn a_pull_is_explained_by_what_the_registry_answered() {
        for (message, want) in [
            (
                "failed to resolve reference \"x\": registry.example/shop/api:9: not found",
                PullFailure::NotFound,
            ),
            (
                "pull access denied, repository does not exist or may require authorization",
                PullFailure::Denied,
            ),
            ("failed to authorize: 401 Unauthorized", PullFailure::Denied),
            (
                "toomanyrequests: You have reached your pull rate limit",
                PullFailure::RateLimited,
            ),
            (
                "dial tcp: lookup registry.example: no such host",
                PullFailure::Unreachable,
            ),
            ("something new", PullFailure::Other),
        ] {
            let Some(PodCause::Blocked { pull, secrets, .. }) =
                pod_cause(&waiting_pod("ErrImagePull", message))
            else {
                panic!("{message}");
            };
            assert_eq!(pull, Some(want), "{message}");
            assert_eq!(secrets, vec!["regcred".to_string()]);
        }
        assert!(matches!(
            pod_cause(&waiting_pod(
                "ImagePullBackOff",
                "Back-off pulling image \"x\""
            )),
            Some(PodCause::Blocked {
                pull: Some(PullFailure::BackingOff),
                ..
            })
        ));
    }

    /// A missing key is the kubelet's sentence, kept whole. Fails if it is dropped.
    #[test]
    fn a_config_error_carries_the_kubelets_sentence() {
        let message = "couldn't find key DB_PASSWORD in Secret team-checkout/checkout-db";
        assert_eq!(
            pod_cause(&waiting_pod("CreateContainerConfigError", message)),
            Some(PodCause::Blocked {
                container: "api".to_string(),
                reason: "CreateContainerConfigError".to_string(),
                said: Some(message.to_string()),
                image: "registry.example/shop/api:9".to_string(),
                pull: None,
                secrets: vec!["regcred".to_string()],
            })
        );
    }

    /// A container still being created has no cause yet. Fails if it is called blocked.
    #[test]
    fn a_container_still_creating_is_not_blocked() {
        assert_eq!(pod_cause(&waiting_pod("ContainerCreating", "")), None);
    }

    /// A healthy pod has no cause, a restart long ago included.
    #[test]
    fn a_running_pod_with_old_or_no_exits_has_no_cause() {
        let healthy = pod(serde_json::json!({
            "metadata": {"name": "web"},
            "spec": {"containers": [{"name": "web"}]},
            "status": {
                "phase": "Running",
                "containerStatuses": [{
                    "name": "web", "image": "", "imageID": "", "ready": true, "restartCount": 1,
                    "state": {"running": {"startedAt": "2026-10-12T10:00:30Z"}},
                    "lastState": {"terminated": {"exitCode": 0, "reason": "Completed"}}
                }]
            }
        }));
        assert_eq!(pod_cause(&healthy), None);
    }

    /// The corpus both halves answer. Fails if this side tells another pod's
    /// cause, another share or another whole than the frontend's lists do.
    #[test]
    fn answers_every_case_in_the_shared_corpus_as_the_frontend_does() {
        #[derive(Deserialize)]
        struct Read {
            deleting: bool,
            cause: Option<PodCause>,
        }
        #[derive(Deserialize)]
        struct Is {
            from: usize,
            pods: i32,
            of: i32,
        }
        #[derive(Deserialize)]
        struct Case {
            name: String,
            pods: Vec<Read>,
            is: Option<Is>,
        }
        #[derive(Deserialize)]
        struct Corpus {
            cases: Vec<Case>,
        }
        let corpus: Corpus = serde_json::from_str(include_str!(
            "../../../../contracts/shared-cause-conformance.json"
        ))
        .expect("the corpus parses");
        for case in corpus.cases {
            let want = case.is.map(|is| SharedCause {
                cause: case.pods[is.from].cause.clone().expect("a told cause"),
                pods: is.pods,
                of: is.of,
            });
            let read = share(case.pods.into_iter().map(|p| (p.deleting, p.cause)));
            assert_eq!(read, want, "{}", case.name);
        }
    }

    fn placed(sandbox: Option<&str>, waiting: &str) -> Pod {
        let mut conditions = vec![serde_json::json!({
            "type": "PodScheduled", "status": "True",
            "lastTransitionTime": "2026-10-14T22:58:15Z"
        })];
        if let Some(status) = sandbox {
            conditions
                .push(serde_json::json!({"type": "PodReadyToStartContainers", "status": status}));
        }
        pod(serde_json::json!({
            "metadata": {"name": "init-no-secret", "uid": "u1"},
            "spec": {"initContainers": [{"name": "migrate"}], "containers": [{"name": "app"}]},
            "status": {
                "phase": "Pending",
                "conditions": conditions,
                "initContainerStatuses": [{
                    "name": "migrate", "image": "", "imageID": "", "ready": false, "restartCount": 0,
                    "state": {"waiting": {"reason": waiting}}
                }],
                "containerStatuses": [{
                    "name": "app", "image": "", "imageID": "", "ready": false, "restartCount": 0,
                    "state": {"waiting": {"reason": waiting}}
                }]
            }
        }))
    }

    /// A pod as k3s left it with a Secret volume that does not exist: placed,
    /// no sandbox, every container waiting. Fails if it has no cause, or one
    /// that is not the kubelet's setup.
    #[test]
    fn a_placed_pod_with_no_sandbox_is_creating() {
        assert_eq!(
            pod_cause(&placed(Some("False"), "PodInitializing")),
            Some(PodCause::Creating {
                uid: "u1".into(),
                since: Some("2026-10-14T22:58:15Z".parse().unwrap()),
                sandbox: Some(false),
                kubelet: Warned::NotRead,
            })
        );
    }

    /// Sam's big pull: the sandbox is up and the kubelet is pulling. Fails if
    /// a pull still in progress reads as a pod the kubelet cannot set up.
    #[test]
    fn a_pod_with_its_sandbox_up_is_not_creating() {
        assert_eq!(pod_cause(&placed(Some("True"), "ContainerCreating")), None);
    }

    /// A cluster that does not report the sandbox: the containers' own wait
    /// is the only word, and with none of it there is no cause to tell.
    #[test]
    fn with_no_word_on_the_sandbox_the_containers_wait_decides() {
        let unsaid = pod_cause(&placed(None, "ContainerCreating"));
        assert!(matches!(
            unsaid,
            Some(PodCause::Creating { sandbox: None, .. })
        ));
        assert_eq!(pod_cause(&placed(None, "Unknown")), None);
    }

    fn warning(uid: &str, reason: &str, message: &str, last: &str) -> Event {
        serde_json::from_value(serde_json::json!({
            "metadata": {"name": format!("{reason}.{last}"), "namespace": "create-demo"},
            "involvedObject": {"kind": "Pod", "name": "web", "uid": uid},
            "type": "Warning", "reason": reason, "message": message, "count": 7,
            "lastTimestamp": last
        }))
        .expect("an event this test wrote itself")
    }

    /// The kubelet's words as k3s wrote them. Fails if a missing ConfigMap or
    /// Secret is not named with its kind, if the scheduler's or another pod's
    /// warning is taken, or if the newest stops coming first.
    #[test]
    fn reads_the_kubelets_warnings_for_one_pod_newest_first() {
        let events = [
            warning(
                "u1",
                "FailedMount",
                r#"MountVolume.SetUp failed for volume "cfg" : configmap "web-config" not found"#,
                "2026-10-14T22:59:00Z",
            ),
            warning(
                "u1",
                "FailedMount",
                r#"MountVolume.SetUp failed for volume "creds" : secret "web-creds" not found"#,
                "2026-10-14T22:59:19Z",
            ),
            warning(
                "u1",
                "FailedScheduling",
                "0/2 nodes are available",
                "2026-10-14T22:59:30Z",
            ),
            warning(
                "u0",
                "FailedMount",
                r#"MountVolume.SetUp failed for volume "old" : secret "gone" not found"#,
                "2026-10-14T23:00:00Z",
            ),
        ];
        let read = setup_warnings("u1", &events);
        let faults: Vec<_> = read.iter().map(|w| w.fault.clone()).collect();
        assert_eq!(
            faults,
            vec![
                SetupFault::Missing {
                    volume: Some("creds".into()),
                    kind: "Secret".into(),
                    name: "web-creds".into()
                },
                SetupFault::Missing {
                    volume: Some("cfg".into()),
                    kind: "ConfigMap".into(),
                    name: "web-config".into()
                },
            ]
        );
        assert_eq!(read[0].count, 7);
    }

    /// Fails if a mount that names no missing object claims one, or a
    /// sandbox the network plugin failed reads as a volume.
    #[test]
    fn a_warning_that_names_no_missing_object_says_only_what_it_is() {
        let fault = |reason, said| setup_fault(reason, said);
        assert_eq!(
            fault("FailedMount", "Unable to attach or mount volumes: unmounted volumes=[cfg], unattached volumes=[]: timed out waiting for the condition"),
            SetupFault::Volume { volume: None }
        );
        assert_eq!(
            fault(
                "FailedMount",
                r#"MountVolume.SetUp failed for volume "cfg" : object "shop"/"cfg" not registered"#
            ),
            SetupFault::Volume {
                volume: Some("cfg".into())
            }
        );
        assert_eq!(
            fault(
                "FailedCreatePodSandBox",
                r#"Failed to create pod sandbox: rpc error: plugin type="calico" failed (add): stat /var/lib/calico/nodename: no such file or directory"#
            ),
            SetupFault::Sandbox
        );
        assert_eq!(
            fault("BackOff", "Back-off pulling image"),
            SetupFault::Other
        );
    }

    /// A termination message is the kubelet's to cap; the end is what says
    /// why, and a cut never splits a character.
    #[test]
    fn a_long_termination_message_keeps_its_end_whole() {
        let message = format!("{}é{}", "x".repeat(2000), "Error: the end");
        let kept = tail(&message);
        assert!(kept.ends_with("Error: the end"));
        assert!(kept.len() <= SAID_TAIL);
    }
}
