//! One pod template, judged against every control of the Pod Security
//! Standards and the container rules, once per workload.
//!
//! The controls, their fields and allowed values are those of
//! <https://kubernetes.io/docs/concepts/security/pod-security-standards/>
//! (kubernetes/website, read 2026-11-14).

use std::collections::BTreeMap;

use k8s_openapi::api::core::v1::{
    Container, ContainerPort, EnvVar, EphemeralContainer, Lifecycle, PodSpec, Probe,
    ResourceRequirements, SecurityContext,
};
use k8s_openapi::apimachinery::pkg::api::resource::Quantity;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;

use super::names::{floats, is_literal, reaches_socket, suggests_secret};
use super::{At, AuditFinding, AuditSeverity, ContainerList, RuleId, TokenBy, What};
use crate::resources::shown_text;

/// Capabilities the baseline profile lets a container add.
const BASELINE_CAPABILITIES: &[&str] = &[
    "AUDIT_WRITE",
    "CHOWN",
    "DAC_OVERRIDE",
    "FOWNER",
    "FSETID",
    "KILL",
    "MKNOD",
    "NET_BIND_SERVICE",
    "SETFCAP",
    "SETGID",
    "SETPCAP",
    "SETUID",
    "SYS_CHROOT",
];

/// The "safe" sysctls, each with the minor version that admits it.
const SAFE_SYSCTLS: &[(&str, u32)] = &[
    ("kernel.shm_rmid_forced", 0),
    ("net.ipv4.ip_local_port_range", 0),
    ("net.ipv4.ip_unprivileged_port_start", 0),
    ("net.ipv4.tcp_syncookies", 0),
    ("net.ipv4.ping_group_range", 0),
    ("net.ipv4.ip_local_reserved_ports", 27),
    ("net.ipv4.tcp_keepalive_time", 29),
    ("net.ipv4.tcp_fin_timeout", 29),
    ("net.ipv4.tcp_keepalive_intvl", 29),
    ("net.ipv4.tcp_keepalive_probes", 29),
    ("net.ipv4.tcp_rmem", 32),
    ("net.ipv4.tcp_wmem", 32),
    ("net.ipv4.tcp_slow_start_after_idle", 37),
    ("net.ipv4.tcp_notsent_lowat", 37),
];

/// `SELinux` types the baseline profile allows, each with the minor version
/// that admits it.
const SELINUX_TYPES: &[(&str, u32)] = &[
    ("container_t", 0),
    ("container_init_t", 0),
    ("container_kvm_t", 0),
    ("container_engine_t", 31),
];

/// Volume sources the restricted profile allows.
const RESTRICTED_VOLUMES: &[&str] = &[
    "configMap",
    "csi",
    "downwardAPI",
    "emptyDir",
    "ephemeral",
    "persistentVolumeClaim",
    "projected",
    "secret",
];

const APPARMOR_ANNOTATION: &str = "container.apparmor.security.beta.kubernetes.io/";

/// What the namespace's other kinds are asked about a template, kept with
/// its findings so a change beside it does not judge it again.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TemplateFacts {
    pub labels: BTreeMap<String, String>,
    /// `restartPolicy: Always`: a server, which probes and replicas are about.
    pub long_running: bool,
    /// Spread across nodes by a topology constraint or pod anti-affinity.
    pub spread: bool,
    /// Runs as the `default` `ServiceAccount`.
    pub default_account: bool,
    /// The pod spec's own `automountServiceAccountToken`.
    pub automount: Option<bool>,
    pub no_readiness: Vec<At>,
    pub no_cpu_request: Vec<At>,
    pub no_memory_request: Vec<At>,
    pub no_memory_limit: Vec<At>,
}

pub struct Judged {
    pub findings: Vec<AuditFinding>,
    pub facts: TemplateFacts,
}

/// One container of any of the three lists, read alike.
struct Seat<'a> {
    at: At,
    sc: Option<&'a SecurityContext>,
    ports: Option<&'a Vec<ContainerPort>>,
    probes: [(&'static str, Option<&'a Probe>); 3],
    lifecycle: Option<&'a Lifecycle>,
    env: Option<&'a Vec<EnvVar>>,
    image: Option<&'a str>,
    resources: Option<&'a ResourceRequirements>,
    /// Runs for the life of the pod: a container, or a sidecar init container.
    serves: bool,
}

fn seat(list: ContainerList, c: &Container) -> Seat<'_> {
    Seat {
        at: At {
            list,
            container: c.name.clone(),
        },
        sc: c.security_context.as_ref(),
        ports: c.ports.as_ref(),
        probes: [
            ("livenessProbe", c.liveness_probe.as_ref()),
            ("readinessProbe", c.readiness_probe.as_ref()),
            ("startupProbe", c.startup_probe.as_ref()),
        ],
        lifecycle: c.lifecycle.as_ref(),
        env: c.env.as_ref(),
        image: c.image.as_deref(),
        resources: c.resources.as_ref(),
        serves: list == ContainerList::Containers || c.restart_policy.as_deref() == Some("Always"),
    }
}

fn ephemeral(c: &EphemeralContainer) -> Seat<'_> {
    Seat {
        at: At {
            list: ContainerList::EphemeralContainers,
            container: c.name.clone(),
        },
        sc: c.security_context.as_ref(),
        ports: c.ports.as_ref(),
        probes: [
            ("livenessProbe", c.liveness_probe.as_ref()),
            ("readinessProbe", c.readiness_probe.as_ref()),
            ("startupProbe", c.startup_probe.as_ref()),
        ],
        lifecycle: c.lifecycle.as_ref(),
        env: c.env.as_ref(),
        image: c.image.as_deref(),
        resources: c.resources.as_ref(),
        serves: false,
    }
}

fn seats(spec: &PodSpec) -> Vec<Seat<'_>> {
    let mut all: Vec<Seat<'_>> = spec
        .containers
        .iter()
        .map(|c| seat(ContainerList::Containers, c))
        .collect();
    all.extend(
        spec.init_containers
            .iter()
            .flatten()
            .map(|c| seat(ContainerList::InitContainers, c)),
    );
    all.extend(spec.ephemeral_containers.iter().flatten().map(ephemeral));
    all
}

/// Findings for one rule, gathered across the pod and its containers.
#[derive(Default)]
struct Gathered(BTreeMap<RuleId, (AuditSeverity, Vec<What>)>);

impl Gathered {
    fn add(&mut self, rule: RuleId, what: What) {
        self.raise(rule, rule.rule().severity, what);
    }

    fn raise(&mut self, rule: RuleId, severity: AuditSeverity, what: What) {
        let entry = self.0.entry(rule).or_insert((severity, Vec::new()));
        entry.0 = entry.0.min(severity);
        entry.1.push(what);
    }

    /// One finding per rule, each value once: a pod-level value every
    /// container inherits is one value, not one per container.
    fn findings(self) -> Vec<AuditFinding> {
        self.0
            .into_iter()
            .map(|(rule, (severity, all))| {
                let mut what: Vec<What> = Vec::with_capacity(all.len());
                for each in all {
                    if !what.contains(&each) {
                        what.push(each);
                    }
                }
                AuditFinding {
                    rule,
                    severity,
                    what,
                }
            })
            .collect()
    }
}

fn set(at: Option<&At>, field: &str, value: impl AsRef<str>) -> What {
    What::Set {
        at: at.cloned(),
        field: field.to_string(),
        value: shown_text(value.as_ref()),
    }
}

fn unset(at: Option<&At>, field: &str) -> What {
    What::Unset {
        at: at.cloned(),
        field: field.to_string(),
    }
}

/// `minor` is the cluster's Kubernetes minor version, where it parsed: a
/// value the standard admits only from a later one is judged against it.
#[must_use]
pub fn judge(meta: Option<&ObjectMeta>, spec: &PodSpec, minor: Option<u32>) -> Judged {
    let mut found = Gathered::default();
    let seats = seats(spec);
    let pod = spec.security_context.as_ref();
    let linux = spec.os.as_ref().is_none_or(|os| os.name != "windows");
    let admitted = |since: u32| minor.unwrap_or(0) >= since;

    host_process(&mut found, spec, &seats);
    host_namespaces(&mut found, spec);
    for seat in &seats {
        let at = Some(&seat.at);
        let sc = seat.sc;
        if sc.and_then(|sc| sc.privileged) == Some(true) {
            found.add(
                RuleId::PssPrivileged,
                set(at, "securityContext.privileged", "true"),
            );
        }
        let added = sc
            .and_then(|sc| sc.capabilities.as_ref())
            .and_then(|caps| caps.add.as_ref());
        for cap in added.into_iter().flatten() {
            if !BASELINE_CAPABILITIES.contains(&cap.as_str()) {
                found.add(
                    RuleId::PssCapabilities,
                    set(at, "securityContext.capabilities.add", cap),
                );
            } else if linux && cap != "NET_BIND_SERVICE" {
                found.add(
                    RuleId::PssDropCapabilities,
                    set(at, "securityContext.capabilities.add", cap),
                );
            }
        }
        for port in seat.ports.into_iter().flatten() {
            if let Some(host) = port.host_port.filter(|port| *port != 0) {
                found.add(
                    RuleId::PssHostPorts,
                    set(at, "ports.hostPort", host.to_string()),
                );
            }
        }
        if seat.at.list != ContainerList::EphemeralContainers {
            host_probes(&mut found, seat);
        }
        if let Some(profile) = sc.and_then(|sc| sc.app_armor_profile.as_ref()) {
            if !matches!(profile.type_.as_str(), "RuntimeDefault" | "Localhost") {
                found.add(
                    RuleId::PssApparmor,
                    set(at, "securityContext.appArmorProfile.type", &profile.type_),
                );
            }
        }
        if let Some(options) = sc.and_then(|sc| sc.se_linux_options.as_ref()) {
            selinux(&mut found, at, options, &admitted);
        }
        if let Some(mount) = sc
            .and_then(|sc| sc.proc_mount.as_deref())
            .filter(|mount| *mount != "Default")
        {
            found.add(
                RuleId::PssProcMount,
                set(at, "securityContext.procMount", mount),
            );
        }
        let seccomp = sc
            .and_then(|sc| sc.seccomp_profile.as_ref())
            .map(|profile| profile.type_.as_str());
        if let Some(kind) = seccomp.filter(|kind| !matches!(*kind, "RuntimeDefault" | "Localhost"))
        {
            found.add(
                RuleId::PssSeccompUnconfined,
                set(at, "securityContext.seccompProfile.type", kind),
            );
        }
        if linux {
            let pod_seccomp = pod
                .and_then(|pod| pod.seccomp_profile.as_ref())
                .map(|profile| profile.type_.as_str());
            restricted_linux(&mut found, seat, pod_seccomp, seccomp);
        }
        run_as(&mut found, seat, pod.and_then(|pod| pod.run_as_non_root));
        if sc.and_then(|sc| sc.run_as_user) == Some(0) {
            found.add(
                RuleId::PssRunAsUserRoot,
                set(at, "securityContext.runAsUser", "0"),
            );
        }
        if seat.serves && sc.and_then(|sc| sc.read_only_root_filesystem) != Some(true) {
            found.add(
                RuleId::WritableRootFilesystem,
                unset(at, "securityContext.readOnlyRootFilesystem"),
            );
        }
        for var in seat.env.into_iter().flatten() {
            let literal = var.value_from.is_none() && var.value.as_deref().is_some_and(is_literal);
            if literal && suggests_secret(&var.name) {
                found.add(
                    RuleId::EnvSecretLiteral,
                    What::EnvLiteral {
                        at: seat.at.clone(),
                        variable: shown_text(&var.name),
                    },
                );
            }
        }
        if seat.at.list != ContainerList::EphemeralContainers {
            if let Some(image) = seat.image.filter(|image| floats(image)) {
                found.add(
                    RuleId::ImageTagLatest,
                    What::Image {
                        at: seat.at.clone(),
                        image: shown_text(image),
                    },
                );
            }
        }
    }
    pod_level(&mut found, spec, meta, &admitted);
    volumes(&mut found, spec);

    let long_running = spec
        .restart_policy
        .as_deref()
        .is_none_or(|policy| policy == "Always");
    let serving: Vec<&Seat<'_>> = seats.iter().filter(|seat| seat.serves).collect();
    if long_running {
        for seat in &serving {
            if seat.probes[0].1.is_none() {
                found.add(
                    RuleId::NoLivenessProbe,
                    unset(Some(&seat.at), "livenessProbe"),
                );
            }
        }
    }
    let lacking = |kind: &str, resource: &str| -> Vec<At> {
        serving
            .iter()
            .filter(|seat| {
                let resources = seat.resources;
                let has = |map: Option<&BTreeMap<String, Quantity>>| {
                    map.is_some_and(|map| map.contains_key(resource))
                };
                let limits = has(resources.and_then(|r| r.limits.as_ref()));
                let requests = has(resources.and_then(|r| r.requests.as_ref()));
                // A limit with no request is copied into the request
                // (concepts/configuration/manage-resources-containers).
                if kind == "request" {
                    !requests && !limits
                } else {
                    !limits
                }
            })
            .map(|seat| seat.at.clone())
            .collect()
    };
    let account = spec
        .service_account_name
        .as_deref()
        .or(spec.service_account.as_deref())
        .filter(|name| !name.is_empty())
        .unwrap_or("default");
    let affinity = spec
        .affinity
        .as_ref()
        .and_then(|affinity| affinity.pod_anti_affinity.as_ref())
        .is_some_and(|anti| {
            anti.required_during_scheduling_ignored_during_execution
                .as_ref()
                .is_some_and(|terms| !terms.is_empty())
                || anti
                    .preferred_during_scheduling_ignored_during_execution
                    .as_ref()
                    .is_some_and(|terms| !terms.is_empty())
        });
    let facts = TemplateFacts {
        labels: meta
            .and_then(|meta| meta.labels.clone())
            .unwrap_or_default(),
        long_running,
        spread: affinity
            || spec
                .topology_spread_constraints
                .as_ref()
                .is_some_and(|constraints| !constraints.is_empty()),
        default_account: account == "default",
        automount: spec.automount_service_account_token,
        no_readiness: if long_running {
            serving
                .iter()
                .filter(|seat| seat.probes[1].1.is_none())
                .map(|seat| seat.at.clone())
                .collect()
        } else {
            Vec::new()
        },
        no_cpu_request: lacking("request", "cpu"),
        no_memory_request: lacking("request", "memory"),
        no_memory_limit: lacking("limit", "memory"),
    };
    Judged {
        findings: found.findings(),
        facts,
    }
}

fn host_process(found: &mut Gathered, spec: &PodSpec, seats: &[Seat<'_>]) {
    let pod = spec
        .security_context
        .as_ref()
        .and_then(|sc| sc.windows_options.as_ref())
        .and_then(|options| options.host_process);
    if pod == Some(true) {
        found.add(
            RuleId::PssHostProcess,
            set(None, "securityContext.windowsOptions.hostProcess", "true"),
        );
    }
    for seat in seats {
        let own = seat
            .sc
            .and_then(|sc| sc.windows_options.as_ref())
            .and_then(|options| options.host_process);
        if own == Some(true) {
            found.add(
                RuleId::PssHostProcess,
                set(
                    Some(&seat.at),
                    "securityContext.windowsOptions.hostProcess",
                    "true",
                ),
            );
        }
    }
}

fn host_namespaces(found: &mut Gathered, spec: &PodSpec) {
    for (field, value) in [
        ("hostNetwork", spec.host_network),
        ("hostPID", spec.host_pid),
        ("hostIPC", spec.host_ipc),
    ] {
        if value == Some(true) {
            found.add(RuleId::PssHostNamespaces, set(None, field, "true"));
        }
    }
}

fn host_probes(found: &mut Gathered, seat: &Seat<'_>) {
    let mut hosts: Vec<(String, &str)> = Vec::new();
    for (name, probe) in seat.probes {
        let Some(probe) = probe else { continue };
        if let Some(host) = probe.http_get.as_ref().and_then(|get| get.host.as_deref()) {
            hosts.push((format!("{name}.httpGet.host"), host));
        }
        if let Some(host) = probe
            .tcp_socket
            .as_ref()
            .and_then(|tcp| tcp.host.as_deref())
        {
            hosts.push((format!("{name}.tcpSocket.host"), host));
        }
    }
    if let Some(lifecycle) = seat.lifecycle {
        for (name, handler) in [
            ("lifecycle.postStart", lifecycle.post_start.as_ref()),
            ("lifecycle.preStop", lifecycle.pre_stop.as_ref()),
        ] {
            let Some(handler) = handler else { continue };
            if let Some(host) = handler
                .http_get
                .as_ref()
                .and_then(|get| get.host.as_deref())
            {
                hosts.push((format!("{name}.httpGet.host"), host));
            }
            if let Some(host) = handler
                .tcp_socket
                .as_ref()
                .and_then(|tcp| tcp.host.as_deref())
            {
                hosts.push((format!("{name}.tcpSocket.host"), host));
            }
        }
    }
    for (field, host) in hosts.into_iter().filter(|(_, host)| !host.is_empty()) {
        found.add(RuleId::PssHostProbes, set(Some(&seat.at), &field, host));
    }
}

fn selinux(
    found: &mut Gathered,
    at: Option<&At>,
    options: &k8s_openapi::api::core::v1::SELinuxOptions,
    admitted: &impl Fn(u32) -> bool,
) {
    if let Some(kind) = options.type_.as_deref().filter(|kind| !kind.is_empty()) {
        let allowed = SELINUX_TYPES
            .iter()
            .any(|(name, since)| *name == kind && admitted(*since));
        if !allowed {
            found.add(
                RuleId::PssSelinux,
                set(at, "securityContext.seLinuxOptions.type", kind),
            );
        }
    }
    for (field, value) in [
        (
            "securityContext.seLinuxOptions.user",
            options.user.as_deref(),
        ),
        (
            "securityContext.seLinuxOptions.role",
            options.role.as_deref(),
        ),
    ] {
        if let Some(value) = value.filter(|value| !value.is_empty()) {
            found.add(RuleId::PssSelinux, set(at, field, value));
        }
    }
}

/// The three Linux-only restricted controls. An `Unconfined` profile is the
/// baseline control's finding already; this one says only that none is set.
fn restricted_linux(
    found: &mut Gathered,
    seat: &Seat<'_>,
    pod_seccomp: Option<&str>,
    seccomp: Option<&str>,
) {
    let at = Some(&seat.at);
    let sc = seat.sc;
    match sc.and_then(|sc| sc.allow_privilege_escalation) {
        Some(false) => {}
        Some(true) => found.add(
            RuleId::PssPrivilegeEscalation,
            set(at, "securityContext.allowPrivilegeEscalation", "true"),
        ),
        None => found.add(
            RuleId::PssPrivilegeEscalation,
            unset(at, "securityContext.allowPrivilegeEscalation"),
        ),
    }
    if seccomp.is_none() && pod_seccomp.is_none() {
        found.add(
            RuleId::PssSeccompRequired,
            unset(at, "securityContext.seccompProfile.type"),
        );
    }
    let drops_all = sc
        .and_then(|sc| sc.capabilities.as_ref())
        .and_then(|caps| caps.drop.as_ref())
        .is_some_and(|drop| drop.iter().any(|cap| cap == "ALL"));
    if !drops_all {
        found.add(
            RuleId::PssDropCapabilities,
            unset(at, "securityContext.capabilities.drop"),
        );
    }
}

/// Running as non-root: a container's own field, else the pod's. Stated
/// false is running as root on purpose, and costs more than leaving it unset.
fn run_as(found: &mut Gathered, seat: &Seat<'_>, pod: Option<bool>) {
    let own = seat.sc.and_then(|sc| sc.run_as_non_root);
    match own.or(pod) {
        Some(true) => {}
        Some(false) => found.raise(
            RuleId::PssRunAsNonRoot,
            AuditSeverity::Medium,
            set(
                own.map(|_| &seat.at),
                "securityContext.runAsNonRoot",
                "false",
            ),
        ),
        None => found.add(
            RuleId::PssRunAsNonRoot,
            unset(Some(&seat.at), "securityContext.runAsNonRoot"),
        ),
    }
}

fn pod_level(
    found: &mut Gathered,
    spec: &PodSpec,
    meta: Option<&ObjectMeta>,
    admitted: &impl Fn(u32) -> bool,
) {
    if let Some(pod) = spec.security_context.as_ref() {
        if let Some(profile) = pod.app_armor_profile.as_ref() {
            if !matches!(profile.type_.as_str(), "RuntimeDefault" | "Localhost") {
                found.add(
                    RuleId::PssApparmor,
                    set(None, "securityContext.appArmorProfile.type", &profile.type_),
                );
            }
        }
        if let Some(options) = pod.se_linux_options.as_ref() {
            selinux(found, None, options, admitted);
        }
        if let Some(kind) = pod
            .seccomp_profile
            .as_ref()
            .map(|profile| profile.type_.as_str())
            .filter(|kind| !matches!(*kind, "RuntimeDefault" | "Localhost"))
        {
            found.add(
                RuleId::PssSeccompUnconfined,
                set(None, "securityContext.seccompProfile.type", kind),
            );
        }
        for sysctl in pod.sysctls.iter().flatten() {
            let safe = SAFE_SYSCTLS
                .iter()
                .any(|(name, since)| *name == sysctl.name && admitted(*since));
            if !safe {
                found.add(
                    RuleId::PssSysctls,
                    set(None, "securityContext.sysctls", &sysctl.name),
                );
            }
        }
        if pod.run_as_non_root == Some(false) {
            found.raise(
                RuleId::PssRunAsNonRoot,
                AuditSeverity::Medium,
                set(None, "securityContext.runAsNonRoot", "false"),
            );
        }
        if pod.run_as_user == Some(0) {
            found.raise(
                RuleId::PssRunAsUserRoot,
                AuditSeverity::Medium,
                set(None, "securityContext.runAsUser", "0"),
            );
        }
    }
    let annotations = meta.and_then(|meta| meta.annotations.as_ref());
    for (key, value) in annotations.into_iter().flatten() {
        if !key.starts_with(APPARMOR_ANNOTATION) {
            continue;
        }
        if value != "runtime/default" && !value.starts_with("localhost/") {
            found.add(
                RuleId::PssApparmor,
                set(None, &format!("metadata.annotations[{key}]"), value),
            );
        }
    }
}

fn volumes(found: &mut Gathered, spec: &PodSpec) {
    for volume in spec.volumes.iter().flatten() {
        if let Some(host) = volume.host_path.as_ref() {
            found.add(
                RuleId::PssHostPath,
                What::Volume {
                    volume: volume.name.clone(),
                    source: "hostPath".to_string(),
                    path: Some(shown_text(&host.path)),
                },
            );
            if let Some(socket) = reaches_socket(&host.path) {
                found.add(
                    RuleId::RuntimeSocket,
                    What::Socket {
                        volume: volume.name.clone(),
                        path: shown_text(&host.path),
                        socket: socket.to_string(),
                    },
                );
            }
        }
        let sources = source_of(volume);
        if !sources
            .iter()
            .any(|source| RESTRICTED_VOLUMES.contains(&source.as_str()))
        {
            found.add(
                RuleId::PssVolumeTypes,
                What::Volume {
                    volume: volume.name.clone(),
                    source: sources.first().cloned().unwrap_or_default(),
                    path: None,
                },
            );
        }
    }
}

/// The source fields a volume sets, as the API spells them.
fn source_of(volume: &k8s_openapi::api::core::v1::Volume) -> Vec<String> {
    match serde_json::to_value(volume) {
        Ok(serde_json::Value::Object(fields)) => fields
            .into_iter()
            .filter(|(name, value)| name != "name" && !value.is_null())
            .map(|(name, _)| name)
            .collect(),
        _ => Vec::new(),
    }
}

/// The `default` `ServiceAccount`'s token, where the pod mounts it: the pod
/// spec's own say first, then the `ServiceAccount`'s, else mounted.
#[must_use]
pub fn token(facts: &TemplateFacts, account: Option<bool>) -> Option<TokenBy> {
    if !facts.default_account {
        return None;
    }
    match (facts.automount, account) {
        (Some(false), _) | (None, Some(false)) => None,
        (Some(true), _) => Some(TokenBy::Pod),
        (None, Some(true)) => Some(TokenBy::Account),
        (None, None) => Some(TokenBy::Default),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use serde_json::{json, Value};

    use super::*;

    /// A template that meets the restricted profile and every container rule.
    fn clean() -> Value {
        json!({
            "containers": [{
                "name": "app",
                "image": "registry.local/app:1.4.2",
                "securityContext": {
                    "allowPrivilegeEscalation": false,
                    "runAsNonRoot": true,
                    "readOnlyRootFilesystem": true,
                    "capabilities": { "drop": ["ALL"] },
                    "seccompProfile": { "type": "RuntimeDefault" }
                },
                "readinessProbe": { "tcpSocket": { "port": 8080 } },
                "livenessProbe": { "tcpSocket": { "port": 8080 } },
                "resources": {
                    "requests": { "cpu": "100m", "memory": "128Mi" },
                    "limits": { "memory": "256Mi" }
                }
            }],
            "serviceAccountName": "app"
        })
    }

    fn judged(spec: &Value, minor: Option<u32>) -> Judged {
        let spec: PodSpec = serde_json::from_value(spec.clone()).expect("a pod spec");
        judge(None, &spec, minor)
    }

    fn rules(spec: &Value) -> BTreeSet<RuleId> {
        judged(spec, Some(32))
            .findings
            .iter()
            .map(|f| f.rule)
            .collect()
    }

    fn container(spec: &mut Value) -> &mut Value {
        &mut spec["containers"][0]
    }

    /// The template every other test bends. Fails if it breaks a rule
    /// itself, which would make each test below pass for the wrong reason.
    #[test]
    fn a_template_that_meets_every_rule_has_no_findings() {
        assert_eq!(rules(&clean()), BTreeSet::new());
    }

    /// Each baseline control, broken once and kept once at a value the
    /// standard allows. Fails if a control misses its violation or calls an
    /// allowed value one.
    #[test]
    fn every_baseline_control_fires_on_its_violation_and_not_on_an_allowed_value() {
        type Bend = fn(&mut Value);
        let cases: Vec<(RuleId, Bend, Bend)> = vec![
            (
                RuleId::PssHostProcess,
                |s| s["securityContext"] = json!({ "windowsOptions": { "hostProcess": true } }),
                |s| s["securityContext"] = json!({ "windowsOptions": { "hostProcess": false } }),
            ),
            (
                RuleId::PssHostNamespaces,
                |s| s["hostPID"] = json!(true),
                |s| s["hostNetwork"] = json!(false),
            ),
            (
                RuleId::PssPrivileged,
                |s| container(s)["securityContext"]["privileged"] = json!(true),
                |s| container(s)["securityContext"]["privileged"] = json!(false),
            ),
            (
                RuleId::PssCapabilities,
                |s| container(s)["securityContext"]["capabilities"]["add"] = json!(["SYS_ADMIN"]),
                |s| {
                    container(s)["securityContext"]["capabilities"]["add"] =
                        json!(["NET_BIND_SERVICE"]);
                },
            ),
            (
                RuleId::PssHostPath,
                |s| s["volumes"] = json!([{ "name": "logs", "hostPath": { "path": "/var/log" } }]),
                |s| s["volumes"] = json!([{ "name": "scratch", "emptyDir": {} }]),
            ),
            (
                RuleId::PssHostPorts,
                |s| container(s)["ports"] = json!([{ "containerPort": 80, "hostPort": 8080 }]),
                |s| container(s)["ports"] = json!([{ "containerPort": 80, "hostPort": 0 }]),
            ),
            (
                RuleId::PssHostProbes,
                |s| {
                    container(s)["readinessProbe"] =
                        json!({ "httpGet": { "port": 80, "host": "10.0.0.1" } });
                },
                |s| {
                    container(s)["readinessProbe"] =
                        json!({ "httpGet": { "port": 80, "host": "" } });
                },
            ),
            (
                RuleId::PssApparmor,
                |s| {
                    container(s)["securityContext"]["appArmorProfile"] =
                        json!({ "type": "Unconfined" });
                },
                |s| {
                    container(s)["securityContext"]["appArmorProfile"] =
                        json!({ "type": "Localhost", "localhostProfile": "k8s" });
                },
            ),
            (
                RuleId::PssSelinux,
                |s| container(s)["securityContext"]["seLinuxOptions"] = json!({ "type": "spc_t" }),
                |s| {
                    container(s)["securityContext"]["seLinuxOptions"] =
                        json!({ "type": "container_init_t" });
                },
            ),
            (
                RuleId::PssProcMount,
                |s| container(s)["securityContext"]["procMount"] = json!("Unmasked"),
                |s| container(s)["securityContext"]["procMount"] = json!("Default"),
            ),
            (
                RuleId::PssSeccompUnconfined,
                |s| s["securityContext"] = json!({ "seccompProfile": { "type": "Unconfined" } }),
                |s| s["securityContext"] = json!({ "seccompProfile": { "type": "Localhost", "localhostProfile": "p.json" } }),
            ),
            (
                RuleId::PssSysctls,
                |s| {
                    s["securityContext"] =
                        json!({ "sysctls": [{ "name": "kernel.msgmax", "value": "1" }] });
                },
                |s| {
                    s["securityContext"] =
                        json!({ "sysctls": [{ "name": "net.ipv4.tcp_syncookies", "value": "1" }] });
                },
            ),
        ];
        for (rule, broken, allowed) in cases {
            let mut spec = clean();
            broken(&mut spec);
            assert!(
                rules(&spec).contains(&rule),
                "{rule:?} missed its violation"
            );
            let mut spec = clean();
            allowed(&mut spec);
            assert!(
                !rules(&spec).contains(&rule),
                "{rule:?} fired on an allowed value"
            );
        }
    }

    /// The same for the restricted controls.
    #[test]
    fn every_restricted_control_fires_on_its_violation_and_not_on_an_allowed_value() {
        type Bend = fn(&mut Value);
        let cases: Vec<(RuleId, Bend, Bend)> = vec![
            (
                RuleId::PssVolumeTypes,
                |s| {
                    s["volumes"] =
                        json!([{ "name": "share", "nfs": { "server": "nas", "path": "/x" } }]);
                },
                |s| s["volumes"] = json!([{ "name": "conf", "configMap": { "name": "app" } }]),
            ),
            (
                RuleId::PssPrivilegeEscalation,
                |s| container(s)["securityContext"]["allowPrivilegeEscalation"] = json!(true),
                |s| container(s)["securityContext"]["allowPrivilegeEscalation"] = json!(false),
            ),
            (
                RuleId::PssRunAsNonRoot,
                |s| container(s)["securityContext"]["runAsNonRoot"] = Value::Null,
                |s| {
                    container(s)["securityContext"]["runAsNonRoot"] = Value::Null;
                    s["securityContext"] = json!({ "runAsNonRoot": true });
                },
            ),
            (
                RuleId::PssRunAsUserRoot,
                |s| container(s)["securityContext"]["runAsUser"] = json!(0),
                |s| container(s)["securityContext"]["runAsUser"] = json!(1000),
            ),
            (
                RuleId::PssSeccompRequired,
                |s| container(s)["securityContext"]["seccompProfile"] = Value::Null,
                |s| {
                    container(s)["securityContext"]["seccompProfile"] = Value::Null;
                    s["securityContext"] =
                        json!({ "seccompProfile": { "type": "RuntimeDefault" } });
                },
            ),
            (
                RuleId::PssDropCapabilities,
                |s| container(s)["securityContext"]["capabilities"]["add"] = json!(["CHOWN"]),
                |s| {
                    container(s)["securityContext"]["capabilities"]["add"] =
                        json!(["NET_BIND_SERVICE"]);
                },
            ),
        ];
        for (rule, broken, allowed) in cases {
            let mut spec = clean();
            broken(&mut spec);
            assert!(
                rules(&spec).contains(&rule),
                "{rule:?} missed its violation"
            );
            let mut spec = clean();
            allowed(&mut spec);
            assert!(
                !rules(&spec).contains(&rule),
                "{rule:?} fired on an allowed value"
            );
        }
    }

    /// Privilege escalation, seccomp and capabilities apply only where
    /// `spec.os.name` is not windows. Fails if a Windows pod is held to them.
    #[test]
    fn the_linux_only_controls_do_not_hold_a_windows_pod() {
        let mut spec = clean();
        container(&mut spec)["securityContext"] =
            json!({ "runAsNonRoot": true, "readOnlyRootFilesystem": true });
        let linux = rules(&spec);
        spec["os"] = json!({ "name": "windows" });
        let windows = rules(&spec);
        for rule in [
            RuleId::PssPrivilegeEscalation,
            RuleId::PssSeccompRequired,
            RuleId::PssDropCapabilities,
        ] {
            assert!(linux.contains(&rule), "{rule:?}");
            assert!(!windows.contains(&rule), "{rule:?}");
        }
    }

    /// A sysctl the standard admits from 1.32 is not safe on a 1.31
    /// cluster, nor where the version did not parse. Fails if the newest list
    /// is applied to every cluster.
    #[test]
    fn a_sysctl_admitted_later_is_judged_against_the_clusters_version() {
        let mut spec = clean();
        spec["securityContext"] =
            json!({ "sysctls": [{ "name": "net.ipv4.tcp_rmem", "value": "4096" }] });
        let fires = |minor| {
            judged(&spec, minor)
                .findings
                .iter()
                .any(|f| f.rule == RuleId::PssSysctls)
        };
        assert!(fires(Some(31)));
        assert!(!fires(Some(32)));
        assert!(fires(None));
    }

    /// `runAsNonRoot: false` written down is running as root on purpose.
    /// Fails if it is ranked with a field nobody set.
    #[test]
    fn running_as_root_on_purpose_costs_more_than_leaving_it_unset() {
        let severity = |bend: fn(&mut Value)| {
            let mut spec = clean();
            bend(&mut spec);
            judged(&spec, Some(32))
                .findings
                .into_iter()
                .find(|f| f.rule == RuleId::PssRunAsNonRoot)
                .map(|f| f.severity)
        };
        assert_eq!(
            severity(|s| container(s)["securityContext"]["runAsNonRoot"] = Value::Null),
            Some(AuditSeverity::Low)
        );
        assert_eq!(
            severity(|s| container(s)["securityContext"]["runAsNonRoot"] = json!(false)),
            Some(AuditSeverity::Medium)
        );
        assert_eq!(
            severity(|s| s["securityContext"] = json!({ "runAsNonRoot": false })),
            Some(AuditSeverity::Medium)
        );
    }

    /// The value never leaves the process: the finding names the variable
    /// alone. Fails if the literal reaches the wire.
    #[test]
    fn a_secret_looking_variable_is_named_without_its_value() {
        let value: String = ["s3cr", "et-", "value-", "42"].concat();
        let mut spec = clean();
        container(&mut spec)["env"] = json!([
            { "name": "DB_PASSWORD", "value": value },
            { "name": "TOKEN_FILE", "value": "/var/run/token" },
            { "name": "API_KEY", "valueFrom": { "secretKeyRef": { "name": "app", "key": "k" } } },
            { "name": "SECRET", "value": "" }
        ]);
        let findings = judged(&spec, Some(32)).findings;
        let env = findings
            .iter()
            .find(|f| f.rule == RuleId::EnvSecretLiteral)
            .expect("the literal is found");
        assert_eq!(
            env.what,
            vec![What::EnvLiteral {
                at: At {
                    list: ContainerList::Containers,
                    container: "app".to_string()
                },
                variable: "DB_PASSWORD".to_string()
            }]
        );
        let wire = serde_json::to_string(&findings).unwrap();
        assert!(!wire.contains(&value));
    }

    /// A Job's pods run to completion. Fails if they are asked for the
    /// probes and replicas a server is.
    #[test]
    fn a_template_that_runs_to_completion_is_not_asked_for_probes() {
        let mut spec = clean();
        container(&mut spec)["readinessProbe"] = Value::Null;
        container(&mut spec)["livenessProbe"] = Value::Null;
        spec["restartPolicy"] = json!("OnFailure");
        let judged = judged(&spec, Some(32));
        assert!(!judged.facts.long_running);
        assert!(judged.facts.no_readiness.is_empty());
        assert!(!judged
            .findings
            .iter()
            .any(|f| f.rule == RuleId::NoLivenessProbe));
    }

    /// A limit with no request is copied into the request, so it is one.
    /// Fails if such a container is said to request nothing.
    #[test]
    fn a_limit_with_no_request_counts_as_the_request() {
        let mut spec = clean();
        container(&mut spec)["resources"] = json!({ "limits": { "cpu": "1", "memory": "1Gi" } });
        let facts = judged(&spec, Some(32)).facts;
        assert!(facts.no_cpu_request.is_empty());
        assert!(facts.no_memory_request.is_empty());
        container(&mut spec)["resources"] = json!({});
        let facts = judged(&spec, Some(32)).facts;
        assert_eq!(facts.no_cpu_request.len(), 1);
        assert_eq!(facts.no_memory_limit.len(), 1);
    }

    /// An init container with `restartPolicy: Always` serves for the pod's
    /// life. Fails if it is let off the probes a container is held to.
    #[test]
    fn a_sidecar_init_container_is_held_to_what_a_container_is() {
        let mut spec = clean();
        let mut sidecar = spec["containers"][0].clone();
        sidecar["name"] = json!("proxy");
        sidecar["restartPolicy"] = json!("Always");
        sidecar["livenessProbe"] = Value::Null;
        let mut plain = sidecar.clone();
        plain["name"] = json!("migrate");
        plain["restartPolicy"] = Value::Null;
        spec["initContainers"] = json!([sidecar, plain]);
        let liveness = judged(&spec, Some(32))
            .findings
            .into_iter()
            .find(|f| f.rule == RuleId::NoLivenessProbe)
            .expect("the sidecar has none");
        assert_eq!(liveness.what.len(), 1);
    }

    /// A pod-level value inherited by two containers is one value. Fails if
    /// a finding repeats it once per container.
    #[test]
    fn a_value_two_containers_inherit_from_the_pod_is_said_once() {
        let mut spec = clean();
        let second = {
            let mut c = spec["containers"][0].clone();
            c["name"] = json!("worker");
            c
        };
        spec["containers"].as_array_mut().unwrap().push(second);
        for c in spec["containers"].as_array_mut().unwrap() {
            c["securityContext"]["runAsNonRoot"] = Value::Null;
        }
        spec["securityContext"] = json!({ "runAsNonRoot": false });
        let finding = judged(&spec, Some(32))
            .findings
            .into_iter()
            .find(|f| f.rule == RuleId::PssRunAsNonRoot)
            .unwrap();
        assert_eq!(finding.what.len(), 1);
    }

    /// The pod spec's own word decides first, then the `ServiceAccount`'s.
    /// Fails if an account that turns it off is overruled by nothing.
    #[test]
    fn the_default_token_is_mounted_unless_the_pod_or_its_account_says_not() {
        let facts = |automount| TemplateFacts {
            default_account: true,
            automount,
            ..TemplateFacts::default()
        };
        assert_eq!(token(&facts(None), None), Some(TokenBy::Default));
        assert_eq!(token(&facts(None), Some(false)), None);
        assert_eq!(token(&facts(Some(true)), Some(false)), Some(TokenBy::Pod));
        assert_eq!(token(&facts(Some(false)), Some(true)), None);
        assert_eq!(token(&facts(None), Some(true)), Some(TokenBy::Account));
    }
}
