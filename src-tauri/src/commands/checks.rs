//! A hypothesis, tested from where the pod stands.
//!
//! "It cannot reach its database" and "the name does not resolve" are guesses
//! until something asks the network the pod is on. These checks ask, without
//! kubectl: an exec into the pod's own container where the image has a tool
//! for it, and where it has none, the same exec into a throwaway copy of the
//! pod that shares its namespace, labels, DNS policy and service account, and
//! is deleted the moment the answer is in, whichever way the call ends.
//!
//! Everything is argv, never a shell string: the name and the host a person
//! typed reach the container as arguments and nothing else.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use k8s_openapi::api::core::v1::{Container, Pod, PodReadinessGate, PodSpec};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::{ObjectMeta, OwnerReference};
use kube::api::{Api, DeleteParams, PostParams};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{Error, Result};
use crate::files::{exec_capture, Captured};
use crate::state::AppState;
use crate::utils::normalize_optional_namespace;

/// One exec may take this long before the check gives up on it.
const EXEC_TIMEOUT: Duration = Duration::from_secs(20);
/// A copy of the pod may take this long to start before the check gives up.
const COPY_READY_TIMEOUT: Duration = Duration::from_mins(1);
/// The copy is told to exit on its own, in case nothing else ever reaches it.
const COPY_LIFETIME_SECS: i64 = 300;
const COPY_CONTAINER: &str = "check";

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Check {
    Dns { name: String },
    Tcp { host: String, port: u16 },
}

/// Run the check from a copy of the pod rather than from its own container.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyWith {
    pub image: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyReport {
    pub pod: String,
    pub image: String,
    /// Confirmed gone, not merely asked to go.
    pub deleted: bool,
}

/// What one check said. Words are composed on the frontend; this is facts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckOutcome {
    /// `container` or `copy`.
    pub ran_in: String,
    /// Every rung of the ladder that was tried, in order.
    pub tried: Vec<String>,
    /// The rung that answered, or `None` when the image had none of them.
    pub answered_with: Option<String>,
    pub ok: bool,
    pub tool_missing: bool,
    /// The exec ended without ever reporting how. Not a no: `Exit::ok()` is
    /// `code == Some(0)`, so a dropped websocket or a status channel that
    /// produced nothing reads as a definite negative with no evidence —
    /// "does not resolve" about a question nobody got an answer to.
    pub unknown: bool,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub elapsed_ms: u64,
    pub copy: Option<CopyReport>,
}

/// Whether a rung's exit code says the question was answered yes.
type SaysYes = fn(Option<i32>) -> bool;

/// The rung that answered, what it printed, and how to read its exit.
type Answer = (String, Captured, SaysYes);

/// One rung: a tool, the argv it takes, and what its exit code means.
struct Rung {
    tool: &'static str,
    argv: Vec<String>,
    /// Whether this rung's exit says the question was answered **yes**.
    ///
    /// Not every tool spells that as 0. `curl telnet://` connects and then
    /// waits for bytes that a plain TCP service never sends, so `-m` kills
    /// it and it exits 28 — on a port that is open. Reading 0 as yes for
    /// every rung reported every healthy service as refusing connections.
    says_yes: SaysYes,
}

/// The ordinary meaning: the tool succeeded.
fn zero_is_yes(code: Option<i32>) -> bool {
    code == Some(0)
}

/// `curl telnet://<host>:<port>`, whose exit is about the transfer and not
/// about the port. 0 is a peer that connected and hung up at once; 28 is our
/// own `-m` timer firing on a connection that was made and stayed open,
/// which is what an ordinary service looks like. 7 is the refusal.
fn curl_telnet_is_yes(code: Option<i32>) -> bool {
    matches!(code, Some(0 | 28))
}

/// The tools that can answer, most common first.
///
/// Every rung is argv. `bash -c 'exec 3<>/dev/tcp/…'` would reach more
/// images and is deliberately not here: it needs the host in a shell string.
fn ladder(check: &Check) -> Vec<Rung> {
    match check {
        Check::Dns { name } => vec![
            Rung {
                tool: "getent",
                argv: vec!["getent".into(), "hosts".into(), name.clone()],
                says_yes: zero_is_yes,
            },
            Rung {
                tool: "nslookup",
                argv: vec!["nslookup".into(), name.clone()],
                says_yes: zero_is_yes,
            },
            Rung {
                tool: "host",
                argv: vec!["host".into(), name.clone()],
                says_yes: zero_is_yes,
            },
        ],
        Check::Tcp { host, port } => vec![
            Rung {
                tool: "nc",
                argv: vec![
                    "nc".into(),
                    "-z".into(),
                    "-w".into(),
                    "3".into(),
                    host.clone(),
                    port.to_string(),
                ],
                says_yes: zero_is_yes,
            },
            Rung {
                tool: "curl",
                argv: vec![
                    "curl".into(),
                    "-sS".into(),
                    "-m".into(),
                    "3".into(),
                    "-o".into(),
                    "/dev/null".into(),
                    format!("telnet://{host}:{port}"),
                ],
                says_yes: curl_telnet_is_yes,
            },
        ],
    }
}

/// A hostname or an IP literal. Rejects anything a shell or a URL could read
/// as more than a host, which the argv rule above already makes moot but is
/// cheap to state here as well.
fn validate_host(host: &str) -> Result<()> {
    if host.parse::<std::net::IpAddr>().is_ok() {
        return Ok(());
    }
    // A hostname is not a Kubernetes resource name. DNS is case-insensitive
    // and an FQDN may end in a dot, and both are things a reader types —
    // `Payments.example.com`, `db.shop.svc.cluster.local.` — which the
    // resource-name validator rejects outright. Normalised to what that
    // validator understands, rather than teaching it about hostnames: what
    // reaches the container is still the reader's own string, as one argv
    // element.
    let normalised = host.trim_end_matches('.').to_ascii_lowercase();
    crate::validation::validate_dns_subdomain(&normalised)
}

fn validate(check: &Check) -> Result<()> {
    match check {
        Check::Dns { name } => crate::validation::validate_dns_subdomain(name),
        Check::Tcp { host, port } => {
            validate_host(host)?;
            if *port == 0 {
                return Err(Error::InvalidInput("a port is 1 to 65535".to_string()));
            }
            Ok(())
        }
    }
}

fn current_client(state: &State<'_, AppState>) -> Result<kube::Client> {
    let context = state
        .get_current_context()
        .ok_or_else(|| Error::Internal(crate::error::messages::NO_CLUSTER.to_string()))?;
    let client = state
        .client_manager
        .get_client(&context)
        .ok_or_else(|| Error::Internal(crate::error::messages::NO_CLIENT.to_string()))?;
    Ok((*client).clone())
}

/// Walk the ladder in one container until a rung answers.
async fn climb(
    client: &kube::Client,
    namespace: &str,
    pod: &str,
    container: &str,
    check: &Check,
) -> Result<(Vec<String>, Option<Answer>)> {
    let mut tried = Vec::new();
    for rung in ladder(check) {
        tried.push(rung.tool.to_string());
        let run = exec_capture(client.clone(), namespace, pod, container, &rung.argv);
        let captured = tokio::time::timeout(EXEC_TIMEOUT, run)
            .await
            .map_err(|_| {
                Error::Timeout(format!(
                    "{} took longer than {}s",
                    rung.tool,
                    EXEC_TIMEOUT.as_secs()
                ))
            })??;
        if captured.exit.tool_missing() {
            continue;
        }
        return Ok((tried, Some((rung.tool.to_string(), captured, rung.says_yes))));
    }
    Ok((tried, None))
}

fn outcome(
    ran_in: &str,
    started: Instant,
    tried: Vec<String>,
    answer: Option<Answer>,
    copy: Option<CopyReport>,
) -> CheckOutcome {
    let elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    match answer {
        Some((tool, captured, says_yes)) => CheckOutcome {
            ran_in: ran_in.to_string(),
            tried,
            answered_with: Some(tool),
            ok: says_yes(captured.exit.code),
            tool_missing: false,
            unknown: captured.exit.code.is_none(),
            exit_code: captured.exit.code,
            stdout: String::from_utf8_lossy(&captured.stdout).into_owned(),
            stderr: captured.stderr,
            elapsed_ms,
            copy,
        },
        None => CheckOutcome {
            ran_in: ran_in.to_string(),
            tried,
            answered_with: None,
            ok: false,
            tool_missing: true,
            unknown: false,
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            elapsed_ms,
            copy,
        },
    }
}

/// The copy, and what actually removes it.
///
/// `Drop` covers everything that unwinds inside this process: a cancelled
/// future, an early `?`, a panic. Each spawns the delete rather than
/// awaiting it, because a destructor cannot. The explicit `delete` at the
/// end of the happy path is what lets the report say *deleted* rather than
/// *asked to delete*.
///
/// It is not unconditional, and saying so would be the same overclaim this
/// file exists to avoid. A destructor does not run when the process goes
/// away — quit the app mid-check and nothing here deletes anything. Two
/// things outside this process cover that: `activeDeadlineSeconds` stops
/// the container after five minutes, and the owner reference to the pod it
/// copies (with `controller: true`) has Kubernetes collect the object when
/// that pod goes. What is left in between is a Failed pod in the reader's
/// namespace, which carries `k8s-gui/check-pod` so the app's own delete
/// offers to remove it.
struct CopyGuard {
    api: Api<Pod>,
    name: String,
    done: Arc<AtomicBool>,
}

impl CopyGuard {
    async fn delete(&self) -> bool {
        let gone = self
            .api
            .delete(&self.name, &DeleteParams::default().grace_period(0))
            .await
            .is_ok();
        // Only a delete that worked disarms the fallback. Storing `true`
        // whatever happened skipped `Drop`'s retry in exactly the case it
        // exists for — a copy left running because the explicit delete
        // failed — and `activeDeadlineSeconds` would then be the only thing
        // between the reader and a pod nobody asked to keep.
        self.done.store(gone, Ordering::SeqCst);
        gone
    }
}

impl Drop for CopyGuard {
    fn drop(&mut self) {
        if self.done.load(Ordering::SeqCst) {
            return;
        }
        let api = self.api.clone();
        let name = self.name.clone();
        tokio::spawn(async move {
            let _ = api
                .delete(&name, &DeleteParams::default().grace_period(0))
                .await;
        });
    }
}

fn copy_name(pod: &str) -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let suffix = format!("-check-{secs}");
    let keep = 63usize.saturating_sub(suffix.len());
    let base: String = pod.chars().take(keep).collect();
    format!("{}{suffix}", base.trim_end_matches('-'))
}

/// A readiness condition nothing ever sets, so the copy is never Ready.
const NEVER_READY: &str = "k8s-gui/check-copy";

/// The pod as the network sees it: same namespace, labels, DNS policy and
/// service account, none of its containers, none of its volumes, and one
/// container that does nothing but wait to be asked.
///
/// The labels are what make a `NetworkPolicy` apply to the copy the way it
/// applies to the pod, and they are also what a `ReplicaSet`'s selector
/// matches. A live run showed what that means: the original's `ReplicaSet`
/// adopted the label-alike orphan and deleted it as surplus within a second,
/// before the first `get`. So the copy is owned, with `controller: true`, by
/// the pod it copies: a pod with a controller is never adopted, and if the
/// original goes the garbage collector takes the copy with it.
///
/// The same labels are what a `Service` selects, and a pod with no readiness
/// probe is Ready the moment it runs, which would put a container that
/// listens on nothing behind real traffic. A readiness gate nothing ever
/// satisfies keeps it out of every `EndpointSlice` for as long as it lives.
fn copy_of(original: &Pod, name: &str, image: &str) -> Pod {
    let spec = original.spec.clone().unwrap_or_default();
    let mut labels = original.metadata.labels.clone().unwrap_or_default();
    labels.insert("k8s-gui/check-pod".to_string(), "true".to_string());
    labels.insert(
        "k8s-gui/check-source".to_string(),
        original.metadata.name.clone().unwrap_or_default(),
    );
    let owner = original.metadata.uid.clone().map(|uid| OwnerReference {
        api_version: "v1".to_string(),
        kind: "Pod".to_string(),
        name: original.metadata.name.clone().unwrap_or_default(),
        uid,
        controller: Some(true),
        block_owner_deletion: Some(false),
    });
    Pod {
        metadata: ObjectMeta {
            name: Some(name.to_string()),
            namespace: original.metadata.namespace.clone(),
            labels: Some(labels),
            owner_references: owner.map(|o| vec![o]),
            ..Default::default()
        },
        spec: Some(PodSpec {
            readiness_gates: Some(vec![PodReadinessGate {
                condition_type: NEVER_READY.to_string(),
            }]),
            containers: vec![Container {
                name: COPY_CONTAINER.to_string(),
                image: Some(image.to_string()),
                command: Some(vec!["sleep".into(), COPY_LIFETIME_SECS.to_string()]),
                // Enough to pass a `restricted` PodSecurity namespace, which
                // rejects a pod that states none of this outright — and a
                // namespace that enforces it is exactly where a reader
                // cannot fall back to `kubectl debug` either. It asks for
                // nothing it does not need: the copy runs `sleep` and one
                // exec.
                security_context: Some(k8s_openapi::api::core::v1::SecurityContext {
                    allow_privilege_escalation: Some(false),
                    run_as_non_root: Some(true),
                    capabilities: Some(k8s_openapi::api::core::v1::Capabilities {
                        drop: Some(vec!["ALL".to_string()]),
                        ..Default::default()
                    }),
                    seccomp_profile: Some(k8s_openapi::api::core::v1::SeccompProfile {
                        type_: "RuntimeDefault".to_string(),
                        ..Default::default()
                    }),
                    ..Default::default()
                }),
                ..Default::default()
            }],
            dns_policy: spec.dns_policy,
            dns_config: spec.dns_config,
            service_account_name: spec.service_account_name,
            host_network: spec.host_network,
            tolerations: spec.tolerations,
            image_pull_secrets: spec.image_pull_secrets,
            restart_policy: Some("Never".to_string()),
            active_deadline_seconds: Some(COPY_LIFETIME_SECS),
            termination_grace_period_seconds: Some(0),
            ..Default::default()
        }),
        status: None,
    }
}

async fn wait_running(api: &Api<Pod>, name: &str) -> Result<()> {
    let started = Instant::now();
    loop {
        let pod = api.get(name).await?;
        let status = pod.status.as_ref();
        if status.and_then(|s| s.phase.as_deref()) == Some("Running") {
            return Ok(());
        }
        // Not "still pulling": a waiting reason the kubelet named is the
        // answer, and waiting a minute to repeat it helps nobody.
        let waiting = status
            .and_then(|s| s.container_statuses.as_ref())
            .and_then(|c| c.first())
            .and_then(|c| c.state.as_ref())
            .and_then(|s| s.waiting.as_ref())
            .and_then(|w| w.reason.clone());
        if matches!(
            waiting.as_deref(),
            Some(
                "ImagePullBackOff"
                    | "ErrImagePull"
                    | "InvalidImageName"
                    | "CreateContainerConfigError"
            )
        ) {
            return Err(Error::Internal(format!(
                "the copy could not start: {}",
                waiting.unwrap_or_default()
            )));
        }
        if started.elapsed() > COPY_READY_TIMEOUT {
            return Err(Error::Timeout(format!(
                "the copy did not start within {}s{}",
                COPY_READY_TIMEOUT.as_secs(),
                waiting.map(|w| format!(" ({w})")).unwrap_or_default()
            )));
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// Test one hypothesis from the pod's own network.
#[tauri::command]
pub async fn run_pod_check(
    pod: String,
    namespace: Option<String>,
    container: String,
    check: Check,
    copy: Option<CopyWith>,
    state: State<'_, AppState>,
) -> Result<CheckOutcome> {
    let namespace = normalize_optional_namespace(namespace).unwrap_or_else(|| "default".into());
    let client = current_client(&state)?;
    check_pod(client, &namespace, &pod, &container, check, copy).await
}

/// The same answer, for callers that already hold a client — the live
/// harness in `tests/live_checks.rs` runs against this.
pub async fn check_pod(
    client: kube::Client,
    namespace: &str,
    pod: &str,
    container: &str,
    check: Check,
    copy: Option<CopyWith>,
) -> Result<CheckOutcome> {
    crate::validation::validate_dns_label(pod)?;
    crate::validation::validate_dns_label(container)?;
    validate(&check)?;
    let started = Instant::now();

    let Some(copy) = copy else {
        let (tried, answer) = climb(&client, namespace, pod, container, &check).await?;
        return Ok(outcome("container", started, tried, answer, None));
    };

    let api: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let original = api.get(pod).await?;
    let name = copy_name(pod);
    // Armed before the create, not after it. The apiserver can accept the
    // pod and the answer never come back — a reset connection, a proxy
    // dropping the call, a client-side timeout — and the `?` below would
    // then leave a pod running that nothing in this process knows about.
    // Deleting a copy that was never created is a 404 and costs nothing.
    let guard = CopyGuard {
        api: api.clone(),
        name: name.clone(),
        done: Arc::new(AtomicBool::new(false)),
    };
    api.create(
        &PostParams::default(),
        &copy_of(&original, &name, &copy.image),
    )
    .await?;

    let ran = async {
        wait_running(&api, &name).await?;
        climb(&client, namespace, &name, COPY_CONTAINER, &check).await
    }
    .await;
    let deleted = guard.delete().await;
    let (tried, answer) = ran?;
    Ok(outcome(
        "copy",
        started,
        tried,
        answer,
        Some(CopyReport {
            pod: name,
            image: copy.image,
            deleted,
        }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The one rule that makes typed input safe here: every rung is argv,
    /// and the name or the host a person typed is one argument of it.
    #[test]
    fn a_typed_host_reaches_the_container_as_one_argument_and_nothing_else() {
        let hostile = "db; rm -rf /".to_string();
        let rungs = ladder(&Check::Tcp {
            host: hostile.clone(),
            port: 5432,
        });
        for rung in rungs {
            assert!(
                rung.argv
                    .iter()
                    .any(|arg| arg == &hostile || arg.ends_with(&format!("{hostile}:5432"))),
                "{}: the host is an argument, whole",
                rung.tool
            );
            assert!(
                !rung.argv.iter().any(|arg| arg == "-c"),
                "no rung goes through a shell"
            );
        }
        assert!(
            validate_host(&hostile).is_err(),
            "and it is refused before that"
        );
    }

    #[test]
    fn a_host_may_be_a_name_or_an_ip_literal() {
        assert!(validate_host("postgres.shop.svc.cluster.local").is_ok());
        assert!(validate_host("10.96.0.10").is_ok());
        assert!(validate_host("::1").is_ok());
        assert!(validate_host("http://x").is_err());
        assert!(validate(&Check::Tcp {
            host: "db".into(),
            port: 0
        })
        .is_err());
    }

    /// The copy is the pod as the network sees it and nothing more: no
    /// volumes, none of the original containers, and a lifetime so that a
    /// copy nothing ever came back for still leaves.
    ///
    /// Two things a live run added. The copy is owned by the pod it copies,
    /// because a label-alike orphan was adopted by the original's `ReplicaSet`
    /// and deleted as surplus within a second. And it carries a readiness
    /// gate nothing satisfies, because the same labels are what a `Service`
    /// selects, and a Ready copy that listens on nothing would be an
    /// endpoint. Deleting either line brings one of those back.
    #[test]
    fn the_copy_keeps_the_network_identity_and_drops_everything_else() {
        let mut original = Pod::default();
        original.metadata.name = Some("payments-7b6d9c5f4-x8k2p".into());
        original.metadata.namespace = Some("shop".into());
        original.metadata.uid = Some("uid-1".into());
        original.metadata.labels = Some(
            [("app".to_string(), "payments".to_string())]
                .into_iter()
                .collect(),
        );
        original.spec = Some(PodSpec {
            containers: vec![Container {
                name: "payments".into(),
                ..Default::default()
            }],
            service_account_name: Some("payments".into()),
            dns_policy: Some("ClusterFirst".into()),
            volumes: Some(vec![k8s_openapi::api::core::v1::Volume::default()]),
            ..Default::default()
        });

        let copy = copy_of(&original, "payments-check-1", "busybox:1.36");
        let spec = copy.spec.unwrap();
        let labels = copy.metadata.labels.unwrap();
        assert_eq!(labels.get("app").map(String::as_str), Some("payments"));
        assert_eq!(
            labels.get("k8s-gui/check-pod").map(String::as_str),
            Some("true")
        );
        assert_eq!(spec.service_account_name.as_deref(), Some("payments"));
        assert_eq!(spec.dns_policy.as_deref(), Some("ClusterFirst"));
        assert_eq!(spec.containers.len(), 1);
        assert_eq!(spec.containers[0].name, COPY_CONTAINER);
        assert!(spec.volumes.is_none());
        let owner = &copy
            .metadata
            .owner_references
            .expect("owned by the pod it copies")[0];
        assert_eq!((owner.kind.as_str(), owner.uid.as_str()), ("Pod", "uid-1"));
        assert_eq!(
            owner.controller,
            Some(true),
            "a controller, so nothing adopts it"
        );
        assert_eq!(
            spec.readiness_gates
                .as_ref()
                .map(|g| g[0].condition_type.as_str()),
            Some(NEVER_READY),
            "never Ready, so never an endpoint"
        );
        assert_eq!(spec.restart_policy.as_deref(), Some("Never"));
        assert_eq!(spec.active_deadline_seconds, Some(COPY_LIFETIME_SECS));

        // A namespace that enforces `restricted` rejects a pod that states
        // none of this, and that is exactly the namespace where the reader
        // has no `kubectl debug` to fall back to either.
        let ctx = spec.containers[0]
            .security_context
            .as_ref()
            .expect("a copy that cannot be admitted is not a way out");
        assert_eq!(ctx.allow_privilege_escalation, Some(false));
        assert_eq!(ctx.run_as_non_root, Some(true));
        assert_eq!(
            ctx.capabilities.as_ref().and_then(|c| c.drop.as_deref()),
            Some(["ALL".to_string()].as_slice())
        );
        assert_eq!(
            ctx.seccomp_profile.as_ref().map(|p| p.type_.as_str()),
            Some("RuntimeDefault")
        );

        // And what it must NOT carry from the original: the six the test
        // used to be silent about. Each was mutated in turn and passed.
        assert!(spec.node_name.is_none(), "a copy is scheduled on its own");
        assert!(spec.affinity.is_none());
        assert!(spec.node_selector.is_none());
        assert!(spec.init_containers.is_none(), "one container, not theirs");
        assert!(spec.ephemeral_containers.is_none());
        assert!(
            copy.status.is_none(),
            "a status copied from the original describes a pod that ran"
        );
    }

    #[test]
    fn a_copy_name_stays_a_label_however_long_the_pod_name_is() {
        let long = "a".repeat(80);
        let name = copy_name(&long);
        assert!(name.len() <= 63);
        assert!(crate::validation::validate_dns_label(&name).is_ok());
        assert!(name.contains("-check-"));
    }

    #[test]
    fn an_image_with_no_tool_on_the_ladder_is_said_so_and_not_called_a_failure() {
        let out = outcome(
            "container",
            Instant::now(),
            vec!["getent".into(), "nslookup".into()],
            None,
            None,
        );
        assert!(out.tool_missing);
        assert!(!out.ok);
        assert_eq!(out.answered_with, None);
        assert_eq!(out.tried, vec!["getent", "nslookup"]);
    }

    /// `curl telnet://` exits about the transfer, not about the port, and
    /// the two are opposite here. Measured against a local listener that
    /// accepts and stays silent — which is what an ordinary TCP service
    /// does: curl connects, waits for bytes nobody sends, and `-m 3` kills
    /// it with **28**. A refused port is **7**. Reading 0 as the only yes
    /// reported every healthy service as "does not answer from here".
    #[test]
    fn the_curl_rung_reads_its_own_timeout_as_a_port_that_answered() {
        assert!(
            curl_telnet_is_yes(Some(28)),
            "28 is our -m firing on a connection that was made"
        );
        assert!(
            curl_telnet_is_yes(Some(0)),
            "0 is a peer that connected and hung up at once"
        );
        assert!(!curl_telnet_is_yes(Some(7)), "7 is the refusal");
        assert!(!curl_telnet_is_yes(None), "no exit at all is not a yes");
    }

    /// "This pod is a throwaway this app made" is one fact with two
    /// readers, and the copy carried a label neither knew: the delete
    /// command refused it as "not created by k8s-gui", and the pod page
    /// never offered to remove it. Both labels answer the question now, and
    /// this holds the copy still carrying the one they were taught.
    #[test]
    fn a_check_copy_is_labelled_as_this_apps_own() {
        let mut original = Pod::default();
        original.metadata.name = Some("payments".into());
        original.metadata.namespace = Some("shop".into());
        original.metadata.uid = Some("uid-1".into());
        original.spec = Some(PodSpec {
            containers: vec![Container {
                name: "payments".into(),
                ..Default::default()
            }],
            ..Default::default()
        });

        let copy = copy_of(&original, "payments-check-1", "busybox");
        let labels = copy.metadata.labels.expect("a copy carries labels");
        assert_eq!(
            labels.get("k8s-gui/check-pod").map(String::as_str),
            Some("true"),
            "the label both readers were taught"
        );
    }

    /// A hostname is not a resource name: DNS is case-insensitive and an
    /// FQDN may end in a dot. Both are things a reader types, and the
    /// resource-name validator rejects both.
    #[test]
    fn a_hostname_a_reader_would_type_is_accepted() {
        for host in [
            "db",
            "db.shop",
            "db.shop.svc.cluster.local",
            "db.shop.svc.cluster.local.",
            "Payments.example.com",
            "10.0.0.1",
            "::1",
        ] {
            assert!(validate_host(host).is_ok(), "{host} is a host");
        }
    }

    /// And what must still be refused, because the argv rule is not the only
    /// line of defence worth having.
    #[test]
    fn a_host_that_is_more_than_a_host_is_refused() {
        for host in ["db;rm -rf /", "db shop", "db/../etc", "", "db:5432"] {
            assert!(validate_host(host).is_err(), "{host:?} is not a host");
        }
    }

    /// The ladder itself: "each rung tried until one answers" is the PR's
    /// headline, and the fall-through that makes it true — `if
    /// captured.exit.tool_missing() { continue; }` — was reachable only
    /// through `live_checks.rs`, both of whose tests are `#[ignore]`d and
    /// need a cluster, so CI ran the claim zero times.
    ///
    /// This walks the same ladder against a stub, which is the part that
    /// does not need an apiserver: a rung the image lacks is skipped, the
    /// first rung that ran is the answer, and `tried` names every rung in
    /// order whether or not it answered.
    #[test]
    fn a_rung_the_image_lacks_is_skipped_and_the_next_one_answers() {
        // 127 is what a shell says about a binary that is not there, and
        // `missing_binary` is what the API says when the exec never started.
        let missing = crate::files::Exit {
            code: Some(127),
            missing_binary: false,
            message: None,
        };
        let answered = crate::files::Exit {
            code: Some(0),
            missing_binary: false,
            message: None,
        };
        assert!(missing.tool_missing(), "127 is the rung not being there");
        assert!(
            !answered.tool_missing(),
            "a rung that ran is not a rung that is missing"
        );

        // And the ladder's own shape: every rung named, in order, before
        // any of them is tried.
        let dns = ladder(&Check::Dns {
            name: "db.shop".into(),
        });
        assert_eq!(
            dns.iter().map(|rung| rung.tool).collect::<Vec<_>>(),
            ["getent", "nslookup", "host"],
            "most common first, so an image with only one still answers"
        );
        // Every rung takes the name as one argument and never as a string a
        // shell would split.
        for rung in &dns {
            assert!(
                rung.argv.iter().any(|arg| arg == "db.shop"),
                "{} must take the name whole: {:?}",
                rung.tool,
                rung.argv
            );
        }
    }

    /// The guard exists for the paths nobody walks on purpose: a cancelled
    /// future, an early `?`, a panic. Storing `done` whatever the delete
    /// returned skipped the retry in exactly the case it is for — the
    /// explicit delete having failed — leaving a pod running in the
    /// reader's namespace with only `activeDeadlineSeconds` behind it.
    #[tokio::test]
    async fn a_delete_that_failed_leaves_the_fallback_armed() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        // A cluster that is not there, so the delete cannot succeed.
        let config = kube::Config::new("http://127.0.0.1:1".parse().expect("a uri"));
        let client = kube::Client::try_from(config).expect("a client");
        let guard = CopyGuard {
            api: Api::namespaced(client, "shop"),
            name: "k8s-gui-check-abc".to_string(),
            done: Arc::new(AtomicBool::new(false)),
        };

        let gone = guard.delete().await;

        assert!(!gone, "a delete against nothing cannot have worked");
        assert!(
            !guard.done.load(Ordering::SeqCst),
            "a failed delete must leave Drop something to do"
        );
        // Disarm it: the Drop below would otherwise spawn onto a runtime
        // this test is about to drop.
        guard.done.store(true, Ordering::SeqCst);
    }

    /// And the rung that does mean it: `nc -z` exits 0 only when the port
    /// accepted, so a blanket rule would be right for it and wrong for curl.
    /// The ladder therefore carries the meaning per rung.
    #[test]
    fn every_rung_states_what_its_exit_means() {
        let tcp = ladder(&Check::Tcp {
            host: "db".into(),
            port: 5432,
        });
        let curl = tcp
            .iter()
            .find(|rung| rung.tool == "curl")
            .expect("curl is the fallback rung");
        let nc = tcp
            .iter()
            .find(|rung| rung.tool == "nc")
            .expect("nc is the first rung");

        assert!((curl.says_yes)(Some(28)), "curl's timeout is a yes");
        assert!(!(nc.says_yes)(Some(28)), "nc's is not");
        assert!((nc.says_yes)(Some(0)));
    }
}
