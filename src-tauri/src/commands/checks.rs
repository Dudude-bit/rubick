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

use k8s_openapi::api::core::v1::{Container, Pod, PodSpec};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
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
const COPY_READY_TIMEOUT: Duration = Duration::from_secs(60);
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
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub elapsed_ms: u64,
    pub copy: Option<CopyReport>,
}

/// One rung: a tool and the argv it takes for this check.
struct Rung {
    tool: &'static str,
    argv: Vec<String>,
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
            },
            Rung {
                tool: "nslookup",
                argv: vec!["nslookup".into(), name.clone()],
            },
            Rung {
                tool: "host",
                argv: vec!["host".into(), name.clone()],
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
    crate::validation::validate_dns_subdomain(host)
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
) -> Result<(Vec<String>, Option<(String, Captured)>)> {
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
        return Ok((tried, Some((rung.tool.to_string(), captured))));
    }
    Ok((tried, None))
}

fn outcome(
    ran_in: &str,
    started: Instant,
    tried: Vec<String>,
    answer: Option<(String, Captured)>,
    copy: Option<CopyReport>,
) -> CheckOutcome {
    let elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    match answer {
        Some((tool, captured)) => CheckOutcome {
            ran_in: ran_in.to_string(),
            tried,
            answered_with: Some(tool),
            ok: captured.exit.ok(),
            tool_missing: false,
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
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            elapsed_ms,
            copy,
        },
    }
}

/// The copy, and the promise that it goes.
///
/// `Drop` is what makes the cleanup unconditional: a cancelled future, an
/// early `?` and a panic all run it, and each spawns the delete rather than
/// awaiting it, because a destructor cannot. The explicit `delete` at the end
/// of the happy path is what lets the report say *deleted* rather than
/// *asked to delete*.
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
        self.done.store(true, Ordering::SeqCst);
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

/// The pod as the network sees it: same namespace, labels, DNS policy and
/// service account, none of its containers, none of its volumes, none of
/// its owners, and one container that does nothing but wait to be asked.
fn copy_of(original: &Pod, name: &str, image: &str) -> Pod {
    let spec = original.spec.clone().unwrap_or_default();
    let mut labels = original.metadata.labels.clone().unwrap_or_default();
    labels.insert("k8s-gui/check-pod".to_string(), "true".to_string());
    labels.insert(
        "k8s-gui/check-source".to_string(),
        original.metadata.name.clone().unwrap_or_default(),
    );
    Pod {
        metadata: ObjectMeta {
            name: Some(name.to_string()),
            namespace: original.metadata.namespace.clone(),
            labels: Some(labels),
            ..Default::default()
        },
        spec: Some(PodSpec {
            containers: vec![Container {
                name: COPY_CONTAINER.to_string(),
                image: Some(image.to_string()),
                command: Some(vec!["sleep".into(), COPY_LIFETIME_SECS.to_string()]),
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
    crate::validation::validate_dns_label(&pod)?;
    crate::validation::validate_dns_label(&container)?;
    validate(&check)?;
    let namespace = normalize_optional_namespace(namespace).unwrap_or_else(|| "default".into());
    let client = current_client(&state)?;
    let started = Instant::now();

    let Some(copy) = copy else {
        let (tried, answer) = climb(&client, &namespace, &pod, &container, &check).await?;
        return Ok(outcome("container", started, tried, answer, None));
    };

    let api: Api<Pod> = Api::namespaced(client.clone(), &namespace);
    let original = api.get(&pod).await?;
    let name = copy_name(&pod);
    api.create(
        &PostParams::default(),
        &copy_of(&original, &name, &copy.image),
    )
    .await?;
    let guard = CopyGuard {
        api: api.clone(),
        name: name.clone(),
        done: Arc::new(AtomicBool::new(false)),
    };

    let ran = async {
        wait_running(&api, &name).await?;
        climb(&client, &namespace, &name, COPY_CONTAINER, &check).await
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
    /// volumes, no owners, none of the original containers, and a lifetime
    /// so that a copy nothing ever came back for still leaves.
    #[test]
    fn the_copy_keeps_the_network_identity_and_drops_everything_else() {
        let mut original = Pod::default();
        original.metadata.name = Some("payments-7b6d9c5f4-x8k2p".into());
        original.metadata.namespace = Some("shop".into());
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
        assert!(copy.metadata.owner_references.is_none());
        assert_eq!(spec.restart_policy.as_deref(), Some("Never"));
        assert_eq!(spec.active_deadline_seconds, Some(COPY_LIFETIME_SECS));
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
}
