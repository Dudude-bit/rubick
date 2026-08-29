//! Draining a node, including the waiting.
//!
//! A drain is not one call, it is a conversation. The eviction API refuses
//! while a `PodDisruptionBudget` has nothing spare and agrees the moment a
//! replacement is ready somewhere else, so `kubectl drain` asks again, and
//! again, until it can leave. Anything that gives up on the first refusal is
//! not draining a node, it is reporting on one.
//!
//! Two things this must never do, both of which it has done before:
//!
//! * **Delete a pod an eviction refused.** A `DELETE` is the one call that
//!   does not consult the budget. The version this replaced fell back to it
//!   on *any* eviction error, with the flag enabling that hard-wired on in
//!   the node list — so a budget's refusal was answered by deleting the pod
//!   it was protecting.
//! * **Say it will wait and then not.** The dialog promised exactly this
//!   waiting while the backend did the deleting above. Now the waiting is
//!   here, so the sentence is true.
//!
//! Shaped after [`crate::search`], which had already solved the same
//! problem: an operation too long for one command call, that has to report
//! as it goes and stop when told. Same `watch` cancellation, same session
//! map, same gate that holds the first event until the frontend is
//! listening.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use dashmap::DashMap;
use k8s_openapi::api::core::v1::Pod;
use kube::api::ListParams;
use kube::{Api, Client};
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, oneshot, watch};

use crate::error::{Error, Result};
use crate::state::AppEvent;
use crate::utils::generate_id;

/// How long to wait before asking again, by attempt.
///
/// It climbs because a budget waiting on a slow rollout should not be asked
/// every two seconds for an hour, and it caps because a drain must not sit
/// idle long after the replacement is ready. The last value repeats.
const BACKOFF: [Duration; 4] = [
    Duration::from_secs(2),
    Duration::from_secs(5),
    Duration::from_secs(10),
    Duration::from_secs(15),
];

/// How long to hold the first event for the frontend's listener before
/// going ahead without it.
const SUBSCRIBE_GATE_TIMEOUT: Duration = Duration::from_secs(5);

// --- what the caller asks for -------------------------------------------

/// Which pods a drain is allowed to move.
///
/// These decide membership, never the method: everything in the set leaves
/// by eviction. That is the distinction `kubectl drain` draws with `--force`
/// and `--delete-emptydir-data`, and the one an earlier `force` flag here
/// collapsed into a licence to delete.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrainOptions {
    /// Leave `DaemonSet` pods where they are. On by default, as in `kubectl`:
    /// their controller would put them straight back.
    pub ignore_daemonsets: bool,
    /// Include pods no controller owns. Moving one ends it for good.
    pub evict_unmanaged_pods: bool,
    /// Include pods with an `emptyDir`, whose contents do not outlive them.
    pub evict_pods_with_emptydir: bool,
}

/// Handed back the moment a drain starts; everything else arrives as events.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrainHandle {
    /// Id to filter events on, and to cancel with.
    pub drain_id: String,
}

// --- what comes back -----------------------------------------------------

/// Why a pod is still on the node.
///
/// A code rather than a sentence: the reader's language is chosen in the
/// webview, and a refusal phrased here would arrive in whatever language
/// this file happens to be written in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DrainRefusal {
    /// HTTP 429 — the API declined this eviction *for now*. The only
    /// refusal worth asking about again, and the reason this module waits.
    ///
    /// Deliberately not called "budget". Kubernetes answers 429 both for a
    /// spent `PodDisruptionBudget` and for its own request throttling, and
    /// `kube::core::ErrorResponse` in 0.97 is flattened to
    /// status/message/reason/code — it carries neither `details.causes`,
    /// which is where `DisruptionBudget` would be named, nor `Retry-After`.
    /// Which of the two this is cannot be known from here, so it is not
    /// claimed. The drain dialog reads the budgets from the cluster itself
    /// and names them from that instead.
    NotNow,
    /// No controller owns this pod, so evicting it ends it for good.
    /// Terminal: waiting will not change it, only `evict_unmanaged_pods`.
    NothingWouldReplaceIt,
    /// The pod has an `emptyDir`, whose contents do not outlive it.
    /// Terminal, like the one above, and answered by
    /// `evict_pods_with_emptydir`.
    HoldsLocalData,
    /// Anything else. `message` carries the API's own words, which is all
    /// there is when this app has no name for the failure.
    Other,
}

impl DrainRefusal {
    /// Whether asking again could ever give a different answer.
    ///
    /// The whole loop turns on this. Retrying a pod nothing would replace is
    /// asking the cluster a question only the operator can answer.
    #[must_use]
    pub fn worth_asking_again(self) -> bool {
        matches!(self, DrainRefusal::NotNow)
    }
}

/// One pod the drain has not moved, and why.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefusedPod {
    pub namespace: String,
    pub name: String,
    pub refusal: DrainRefusal,
    /// Set only for `Other`, and quoted rather than composed.
    pub message: Option<String>,
}

impl RefusedPod {
    /// The three refusals this app has a name for. `Other` is built by hand,
    /// because it is the only one that carries words.
    fn new(namespace: String, name: String, refusal: DrainRefusal) -> Self {
        Self {
            namespace,
            name,
            refusal,
            message: None,
        }
    }
}

/// Where a drain stood at the last look.
///
/// A report rather than a `Result`, because a drain that moved forty pods
/// and is waiting on one is neither a success nor a failure, and the old
/// signature had to pick. It picked failure and joined the refusals into a
/// single error string — which put English somewhere the catalogue cannot
/// reach, and left the dialog a blob to print instead of a list to walk.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrainReport {
    /// Pods this drain evicted, across every attempt.
    pub evicted: u32,
    /// Pods that had already left when their turn came. Neither evicted by
    /// this drain nor refused by anything — kept apart from both so that
    /// neither count claims them.
    pub already_gone: u32,
    /// Evictions accepted whose pods have not left yet.
    ///
    /// Its own number because "asked to go" and "gone" are not the same
    /// state, and this drain used to report the node empty at the first.
    pub leaving: u32,
    /// `DaemonSet` pods on the node at the last look, which is the whole of
    /// what `ignore_daemonsets` does.
    pub daemonset_pods_left: u32,
    /// Everything still on the node at the last look.
    pub refused: Vec<RefusedPod>,
}

/// How a drain ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DrainOutcome {
    /// Everything the options allowed is off the node.
    Drained,
    /// What is left will not leave by waiting — it needs an opt-in the
    /// operator did not give, or a failure only they can clear. Distinct
    /// from `Drained` because the node is not empty, and from `Cancelled`
    /// because nobody stopped it.
    Stopped,
    /// The operator stopped it. Whatever had already been evicted stays
    /// evicted; an eviction is not a transaction.
    Cancelled,
    /// The drain itself broke — the node could not be listed, say. Not a
    /// pod refusing, which is `refused`.
    Failed,
}

// --- deciding ------------------------------------------------------------

/// What the drain has decided about one pod, before it calls anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PodPlan {
    /// A `DaemonSet` pod under `ignore_daemonsets`. It stays, and that is
    /// not a refusal — nothing was ever asked of it.
    LeaveDaemonSet,
    /// In the set.
    Evict,
    /// Out of the set, for a reason the report can name.
    Leave(DrainRefusal),
}

/// Decide about one pod from its spec alone.
///
/// Split out of the loop so the membership rules can be tested without a
/// cluster: which pods a drain touches is the half of this that decides
/// whether anything is lost by running it.
fn plan_for(pod: &Pod, options: DrainOptions) -> PodPlan {
    let owners = pod.metadata.owner_references.as_deref().unwrap_or_default();

    if options.ignore_daemonsets && owners.iter().any(|r| r.kind == "DaemonSet") {
        return PodPlan::LeaveDaemonSet;
    }

    if owners.is_empty() && !options.evict_unmanaged_pods {
        return PodPlan::Leave(DrainRefusal::NothingWouldReplaceIt);
    }

    let holds_local_data = pod
        .spec
        .as_ref()
        .and_then(|spec| spec.volumes.as_ref())
        .is_some_and(|volumes| volumes.iter().any(|v| v.empty_dir.is_some()));

    if holds_local_data && !options.evict_pods_with_emptydir {
        return PodPlan::Leave(DrainRefusal::HoldsLocalData);
    }

    PodPlan::Evict
}

/// How one eviction call turned out.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Evicted {
    Yes,
    /// It had already left. Not this drain's doing, and not a refusal either.
    AlreadyGone,
    /// It is still on the node. There is deliberately no fourth arm that
    /// reaches for `DELETE` instead.
    No(DrainRefusal, Option<String>),
}

/// Read one failed eviction.
///
/// This is the half the security report was about. Every arm leaves the pod
/// where it is; the version this replaced turned *any* of them into a direct
/// `DELETE`, which is the one call that does not consult a
/// `PodDisruptionBudget`.
fn outcome_of(err: kube::Error) -> Evicted {
    if let kube::Error::Api(response) = &err {
        match response.code {
            404 | 410 => return Evicted::AlreadyGone,
            429 => return Evicted::No(DrainRefusal::NotNow, None),
            _ => {}
        }
    }

    let message = crate::state::readable_cause(&Error::KubeApi(err));
    Evicted::No(DrainRefusal::Other, Some(message))
}

// --- running -------------------------------------------------------------

struct DrainSession {
    /// Firing this stops the loop. A `watch` rather than a `oneshot` so the
    /// pass and the sleep can both wait on it.
    cancel_tx: watch::Sender<bool>,
    subscribe_tx: Option<oneshot::Sender<()>>,
}

/// Removes the session row on every exit path, including a panic unwind.
struct DrainCleanup {
    sessions: Arc<DashMap<String, DrainSession>>,
    key: String,
}

impl Drop for DrainCleanup {
    fn drop(&mut self) {
        self.sessions.remove(&self.key);
    }
}

/// Owns every drain in flight.
pub struct DrainManager {
    event_tx: broadcast::Sender<AppEvent>,
    sessions: Arc<DashMap<String, DrainSession>>,
}

impl DrainManager {
    #[must_use]
    pub fn new(event_tx: broadcast::Sender<AppEvent>) -> Self {
        Self {
            event_tx,
            sessions: Arc::new(DashMap::new()),
        }
    }

    #[must_use]
    pub fn active_drains(&self) -> usize {
        self.sessions.len()
    }

    /// Release the gate once the frontend's listener is installed.
    ///
    /// # Errors
    ///
    /// Unknown ids error, which keeps a caller from poking at drains it does
    /// not own. Idempotent for one it does.
    pub fn mark_subscribed(&self, drain_id: &str) -> Result<()> {
        if let Some(mut entry) = self.sessions.get_mut(drain_id) {
            if let Some(tx) = entry.subscribe_tx.take() {
                let _ = tx.send(());
            }
            Ok(())
        } else {
            Err(Error::Internal(format!("Drain {drain_id} not found")))
        }
    }

    /// Stop a drain. Idempotent, and safe to race with completion.
    ///
    /// Stops the asking, not the asked: pods already evicted are gone.
    pub fn cancel(&self, drain_id: &str) {
        if let Some((_, session)) = self.sessions.remove(drain_id) {
            let _ = session.cancel_tx.send(true);
        }
    }

    /// Stop every drain in flight.
    pub fn cancel_all(&self) {
        let ids: Vec<String> = self.sessions.iter().map(|e| e.key().clone()).collect();
        for id in ids {
            self.cancel(&id);
        }
    }

    /// Start draining, and return at once.
    ///
    /// Unlike a search, a new drain does **not** cancel the previous one:
    /// two nodes can legitimately be draining together, and stopping one
    /// because another started would be the tool making a cluster-wide
    /// decision on its own.
    #[must_use]
    pub fn start(&self, client: Client, node: String, options: DrainOptions) -> DrainHandle {
        let drain_id = generate_id("drain");
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let (subscribe_tx, subscribe_rx) = oneshot::channel();

        self.sessions.insert(
            drain_id.clone(),
            DrainSession {
                cancel_tx,
                subscribe_tx: Some(subscribe_tx),
            },
        );

        let event_tx = self.event_tx.clone();
        let sessions = self.sessions.clone();
        let id = drain_id.clone();

        tokio::spawn(async move {
            let _cleanup = DrainCleanup {
                sessions,
                key: id.clone(),
            };
            let mut cancel_rx = cancel_rx;

            tokio::select! {
                _ = subscribe_rx => {}
                () = cancelled(&mut cancel_rx) => return,
                () = tokio::time::sleep(SUBSCRIBE_GATE_TIMEOUT) => {
                    tracing::warn!("Drain {id} subscribe gate timed out; going ahead anyway");
                }
            }

            run(&event_tx, &id, &client, &node, options, &mut cancel_rx).await;
        });

        DrainHandle { drain_id }
    }
}

/// One pod this drain took responsibility for, fixed at the first look.
#[derive(Debug, Clone)]
struct Target {
    namespace: String,
    name: String,
    /// The identity a name does not give.
    ///
    /// Needed to tell "this pod left" from "a pod with this name is here":
    /// a `StatefulSet` recreates `web-0` as `web-0`, so on a node something
    /// tolerates the cordon on, matching by name would report a pod as
    /// still terminating forever — or as gone when its replacement had
    /// simply not arrived yet.
    uid: String,
}

/// The node as it was when the drain started.
struct Survey {
    /// The pods this drain will act on, and — this is the point — the only
    /// ones it ever will.
    ///
    /// Decided once and never revisited. Evicting a Deployment's pod makes
    /// its controller create a new one, and on a node something tolerates the
    /// cordon on, that replacement lands right back here; a drain that
    /// re-listed for *work* each pass would chase its own replacements and
    /// never finish. Watched it do exactly that against a live cluster — the
    /// moved count climbing one per attempt — before this was a fixed set.
    /// `kubectl drain` fixes its set for the same reason.
    ///
    /// Later listings are for *departures* only, matched by uid, and can
    /// never add to this.
    targets: Vec<Target>,
    /// Refusals that no amount of waiting changes.
    terminal: Vec<RefusedPod>,
    daemonset_pods_left: u32,
    /// Uids on the node at the first look, so the first attempt does not
    /// list it twice.
    present: HashSet<String>,
}

/// The uids of every pod currently on the node.
async fn present_on(client: &Client, node: &str) -> Result<HashSet<String>> {
    Ok(pods_on(client, node)
        .await?
        .into_iter()
        .filter_map(|pod| pod.metadata.uid)
        .collect())
}

async fn pods_on(client: &Client, node: &str) -> Result<Vec<Pod>> {
    let api: Api<Pod> = Api::all(client.clone());
    let params = ListParams::default().fields(&format!("spec.nodeName={node}"));
    Ok(api.list(&params).await?.items)
}

/// Look once, and decide the whole job from that look.
async fn survey(client: &Client, node: &str, options: DrainOptions) -> Result<Survey> {
    let pods = pods_on(client, node).await?;

    let mut targets = Vec::new();
    let mut terminal = Vec::new();
    let mut daemonset_pods_left = 0;
    let mut present = HashSet::new();

    for pod in pods {
        let name = pod.metadata.name.clone().unwrap_or_default();
        let namespace = pod
            .metadata
            .namespace
            .clone()
            .unwrap_or_else(|| "default".to_string());
        let uid = pod.metadata.uid.clone().unwrap_or_default();
        present.insert(uid.clone());

        match plan_for(&pod, options) {
            PodPlan::LeaveDaemonSet => daemonset_pods_left += 1,
            PodPlan::Leave(refusal) => terminal.push(RefusedPod::new(namespace, name, refusal)),
            PodPlan::Evict => targets.push(Target {
                namespace,
                name,
                uid,
            }),
        }
    }

    Ok(Survey {
        targets,
        terminal,
        daemonset_pods_left,
        present,
    })
}

/// Everything the loop carries between attempts.
struct Progress {
    /// Refused for now, and asked again next time.
    waiting: Vec<Target>,
    /// Eviction accepted, still on the node.
    ///
    /// An eviction is a *graceful* delete: the API answers as soon as it is
    /// accepted and the pod stays put for its grace period — thirty seconds
    /// by default, minutes with a `preStop` hook. Reporting a node drained at
    /// acceptance told the operator it was safe to power off a node whose
    /// pods were all still running. So the drain waits for these to go, which
    /// is what `kubectl drain` does and what this app's own text already
    /// claimed it did.
    leaving: Vec<Target>,
    evicted: u32,
    already_gone: u32,
}

/// Cordon, survey, then ask until the node is actually empty of the set.
async fn run(
    event_tx: &broadcast::Sender<AppEvent>,
    drain_id: &str,
    client: &Client,
    node: &str,
    options: DrainOptions,
    cancel_rx: &mut watch::Receiver<bool>,
) {
    let empty = DrainReport {
        evicted: 0,
        already_gone: 0,
        leaving: 0,
        daemonset_pods_left: 0,
        refused: Vec::new(),
    };

    macro_rules! bail {
        ($outcome:expr, $report:expr, $message:expr) => {{
            finish(event_tx, drain_id, node, $outcome, $report, $message);
            return;
        }};
    }

    // Cordoning belongs to the drain, not to whoever starts one. It used to
    // sit in the Tauri command, and the first caller that was not that command
    // — a test — got a drain that evicted pods onto a node still accepting
    // them, forever. An operation that needs a step to make sense owns it.
    let cordoned = tokio::select! {
        result = cordon(client, node) => result,
        () = cancelled(cancel_rx) => bail!(DrainOutcome::Cancelled, &empty, None),
    };
    if let Err(err) = cordoned {
        let message = crate::state::readable_cause(&err);
        tracing::warn!("Drain {drain_id} could not cordon {node}: {message}");
        bail!(DrainOutcome::Failed, &empty, Some(message));
    }

    let surveyed = tokio::select! {
        result = survey(client, node, options) => result,
        () = cancelled(cancel_rx) => bail!(DrainOutcome::Cancelled, &empty, None),
    };
    let Survey {
        targets,
        mut terminal,
        daemonset_pods_left,
        mut present,
    } = match surveyed {
        Ok(survey) => survey,
        Err(err) => {
            let message = crate::state::readable_cause(&err);
            tracing::warn!("Drain {drain_id} could not read {node}: {message}");
            bail!(DrainOutcome::Failed, &empty, Some(message));
        }
    };

    let mut progress = Progress {
        waiting: targets,
        leaving: Vec::new(),
        evicted: 0,
        already_gone: 0,
    };

    for attempt in 1u32.. {
        // The survey already listed for attempt 1. Later attempts look again
        // — for departures only, never for new work.
        if attempt > 1 {
            let seen = tokio::select! {
                result = present_on(client, node) => result,
                () = cancelled(cancel_rx) => {
                    let report = assemble(&progress, daemonset_pods_left, &terminal);
                    bail!(DrainOutcome::Cancelled, &report, None);
                }
            };
            match seen {
                Ok(seen) => present = seen,
                Err(err) => {
                    let message = crate::state::readable_cause(&err);
                    let report = assemble(&progress, daemonset_pods_left, &terminal);
                    bail!(DrainOutcome::Failed, &report, Some(message));
                }
            }
        }

        progress.leaving.retain(|t| present.contains(&t.uid));

        let mut still_waiting = Vec::new();
        for target in std::mem::take(&mut progress.waiting) {
            if !present.contains(&target.uid) {
                progress.already_gone += 1;
                continue;
            }

            let outcome = tokio::select! {
                result = evict(client, &target) => result,
                () = cancelled(cancel_rx) => {
                    progress.waiting = still_waiting;
                    let report = assemble(&progress, daemonset_pods_left, &terminal);
                    bail!(DrainOutcome::Cancelled, &report, None);
                }
            };

            match outcome {
                Evicted::Yes => {
                    tracing::info!("Evicted pod {}/{}", target.namespace, target.name);
                    progress.evicted += 1;
                    progress.leaving.push(target);
                }
                Evicted::AlreadyGone => progress.already_gone += 1,
                // The only refusal worth another pass, so the only one that
                // stays in the set.
                Evicted::No(DrainRefusal::NotNow, _) => still_waiting.push(target),
                Evicted::No(refusal, message) => terminal.push(RefusedPod {
                    namespace: target.namespace,
                    name: target.name,
                    refusal,
                    message,
                }),
            }
        }
        progress.waiting = still_waiting;

        let report = assemble(&progress, daemonset_pods_left, &terminal);
        let _ = event_tx.send(AppEvent::DrainProgress {
            drain_id: drain_id.to_string(),
            node: node.to_string(),
            attempt,
            report: report.clone(),
        });

        // Empty of the set means both: nobody still refusing, and nobody
        // still on their way out.
        if progress.waiting.is_empty() && progress.leaving.is_empty() {
            let outcome = if terminal.is_empty() {
                DrainOutcome::Drained
            } else {
                DrainOutcome::Stopped
            };
            bail!(outcome, &report, None);
        }

        tokio::select! {
            () = tokio::time::sleep(backoff_for(attempt)) => {}
            () = cancelled(cancel_rx) => bail!(DrainOutcome::Cancelled, &report, None),
        }
    }
}

/// Close the node to scheduling, so that what leaves does not come back.
async fn cordon(client: &Client, node: &str) -> Result<()> {
    let api: Api<k8s_openapi::api::core::v1::Node> = Api::all(client.clone());
    let patch = serde_json::json!({ "spec": { "unschedulable": true } });
    api.patch(
        node,
        &kube::api::PatchParams::default(),
        &kube::api::Patch::Merge(&patch),
    )
    .await?;
    Ok(())
}

/// Ask one pod to leave.
async fn evict(client: &Client, target: &Target) -> Evicted {
    let api: Api<Pod> = Api::namespaced(client.clone(), &target.namespace);
    match api
        .evict(&target.name, &kube::api::EvictParams::default())
        .await
    {
        Ok(_) => Evicted::Yes,
        Err(err) => outcome_of(err),
    }
}

/// The report, from the running totals and the two lists.
///
/// `refused` puts the ones not going anywhere before the ones still being
/// waited on: the first list is what the reader has to act on, and it does
/// not move between attempts.
fn assemble(progress: &Progress, daemonset_pods_left: u32, terminal: &[RefusedPod]) -> DrainReport {
    let mut refused: Vec<RefusedPod> = terminal.to_vec();
    refused.extend(progress.waiting.iter().map(|target| {
        RefusedPod::new(
            target.namespace.clone(),
            target.name.clone(),
            DrainRefusal::NotNow,
        )
    }));
    DrainReport {
        evicted: progress.evicted,
        already_gone: progress.already_gone,
        leaving: u32::try_from(progress.leaving.len()).unwrap_or(u32::MAX),
        daemonset_pods_left,
        refused,
    }
}

fn finish(
    event_tx: &broadcast::Sender<AppEvent>,
    drain_id: &str,
    node: &str,
    outcome: DrainOutcome,
    report: &DrainReport,
    message: Option<String>,
) {
    let _ = event_tx.send(AppEvent::DrainFinished {
        drain_id: drain_id.to_string(),
        node: node.to_string(),
        outcome,
        report: report.clone(),
        message,
    });
}

/// How long to wait after `attempt`, holding at the last step.
///
/// Its own function so the cap is testable: an off-by-one here is either a
/// panic on the fifth attempt or a drain that asks far too often, and
/// neither shows up until a budget actually refuses something.
fn backoff_for(attempt: u32) -> Duration {
    let index = usize::try_from(attempt)
        .unwrap_or(usize::MAX)
        .saturating_sub(1);
    BACKOFF[index.min(BACKOFF.len() - 1)]
}

/// Resolves when the drain has been cancelled — either explicitly or
/// because its session row (and with it the sender) went away.
async fn cancelled(rx: &mut watch::Receiver<bool>) {
    loop {
        if *rx.borrow_and_update() {
            return;
        }
        if rx.changed().await.is_err() {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::api::core::v1::{
        EmptyDirVolumeSource, PersistentVolumeClaimVolumeSource, PodSpec, Volume,
    };
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::{ObjectMeta, OwnerReference};

    /// What the dialog sends when nothing is ticked, which is what it sends
    /// unless the operator says otherwise.
    fn safe() -> DrainOptions {
        DrainOptions {
            ignore_daemonsets: true,
            evict_unmanaged_pods: false,
            evict_pods_with_emptydir: false,
        }
    }

    fn owner(kind: &str) -> OwnerReference {
        OwnerReference {
            kind: kind.to_string(),
            name: "owner".to_string(),
            uid: "u".to_string(),
            api_version: "apps/v1".to_string(),
            ..Default::default()
        }
    }

    fn pod(owners: Vec<OwnerReference>, volumes: Vec<Volume>) -> Pod {
        Pod {
            metadata: ObjectMeta {
                name: Some("p".to_string()),
                namespace: Some("n".to_string()),
                owner_references: if owners.is_empty() {
                    None
                } else {
                    Some(owners)
                },
                ..Default::default()
            },
            spec: Some(PodSpec {
                volumes: if volumes.is_empty() {
                    None
                } else {
                    Some(volumes)
                },
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    fn scratch() -> Volume {
        Volume {
            name: "scratch".to_string(),
            empty_dir: Some(EmptyDirVolumeSource::default()),
            ..Default::default()
        }
    }

    fn api_error(code: u16) -> kube::Error {
        kube::Error::Api(kube::error::ErrorResponse {
            status: "Failure".into(),
            message: format!("the server responded with {code}"),
            reason: "Whatever".into(),
            code,
        })
    }

    /// Points nowhere on purpose. Enough to exercise the bookkeeping —
    /// starting, cancelling, subscribing — without a cluster to drain.
    ///
    /// Building a client puts a rustls stack together, and that needs the
    /// process-wide provider `main` installs at startup. Tests have no
    /// `main`, so the first one here does it; `install_default` is
    /// once-only, hence the ignored result rather than an `expect`.
    fn nowhere() -> Client {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let config = kube::Config::new("http://127.0.0.1:1".parse().expect("a uri"));
        Client::try_from(config).expect("a client that never connects")
    }

    fn manager() -> (DrainManager, broadcast::Receiver<AppEvent>) {
        let (event_tx, rx) = broadcast::channel(64);
        (DrainManager::new(event_tx), rx)
    }

    // --- which pods are in the set ------------------------------------------

    #[test]
    fn an_ordinary_replaceable_pod_is_evicted() {
        let plan = plan_for(&pod(vec![owner("ReplicaSet")], vec![]), safe());
        assert_eq!(plan, PodPlan::Evict);
    }

    /// Left alone, and counted apart from the refusals: a `DaemonSet` pod that
    /// stays is the option working, not something declining to move.
    #[test]
    fn a_daemonset_pod_is_left_without_being_called_refused() {
        let ds = pod(vec![owner("DaemonSet")], vec![]);
        assert_eq!(plan_for(&ds, safe()), PodPlan::LeaveDaemonSet);

        let including = DrainOptions {
            ignore_daemonsets: false,
            ..safe()
        };
        assert_eq!(plan_for(&ds, including), PodPlan::Evict);
    }

    /// `kubectl drain` refuses these without `--force` because nothing will
    /// bring them back. The old code shipped that opt-in switched permanently
    /// on, so a drain silently ended every standalone pod it met.
    #[test]
    fn a_pod_no_controller_owns_stays_until_it_is_asked_for() {
        let bare = pod(vec![], vec![]);
        assert_eq!(
            plan_for(&bare, safe()),
            PodPlan::Leave(DrainRefusal::NothingWouldReplaceIt)
        );

        let asked = DrainOptions {
            evict_unmanaged_pods: true,
            ..safe()
        };
        assert_eq!(plan_for(&bare, asked), PodPlan::Evict);
    }

    #[test]
    fn a_pod_holding_local_data_stays_until_it_is_asked_for() {
        let with_data = pod(vec![owner("ReplicaSet")], vec![scratch()]);
        assert_eq!(
            plan_for(&with_data, safe()),
            PodPlan::Leave(DrainRefusal::HoldsLocalData)
        );

        let asked = DrainOptions {
            evict_pods_with_emptydir: true,
            ..safe()
        };
        assert_eq!(plan_for(&with_data, asked), PodPlan::Evict);
    }

    /// A volume that is not an `emptyDir` survives the pod, so it is not a
    /// reason to hold one back.
    #[test]
    fn a_mounted_volume_that_outlives_the_pod_is_not_local_data() {
        let mounted = Volume {
            name: "data".to_string(),
            persistent_volume_claim: Some(PersistentVolumeClaimVolumeSource::default()),
            ..Default::default()
        };
        let plan = plan_for(&pod(vec![owner("StatefulSet")], vec![mounted]), safe());
        assert_eq!(plan, PodPlan::Evict);
    }

    /// Both opt-ins are off and both apply: answering only the first still
    /// leaves the second holding it.
    #[test]
    fn a_pod_that_trips_both_rules_still_stays() {
        let both = pod(vec![], vec![scratch()]);
        assert!(matches!(plan_for(&both, safe()), PodPlan::Leave(_)));

        let half = DrainOptions {
            evict_unmanaged_pods: true,
            ..safe()
        };
        assert_eq!(
            plan_for(&both, half),
            PodPlan::Leave(DrainRefusal::HoldsLocalData)
        );
    }

    // --- what a failed eviction means ---------------------------------------

    /// The reported bug, as a test. A 429 is the eviction API saying "not
    /// now" — most often a spent `PodDisruptionBudget`. The old code answered
    /// it with a direct `DELETE`, which is the one call that does not consult
    /// the budget at all.
    #[test]
    fn a_refused_eviction_leaves_the_pod_where_it_is() {
        assert_eq!(
            outcome_of(api_error(429)),
            Evicted::No(DrainRefusal::NotNow, None)
        );
    }

    /// Deliberately not named after the budget. Kubernetes answers 429 for
    /// throttling too, and nothing in `ErrorResponse` tells the two apart.
    #[test]
    fn the_refusal_does_not_claim_to_know_which_429_it_was() {
        let Evicted::No(refusal, message) = outcome_of(api_error(429)) else {
            panic!("a 429 leaves the pod");
        };
        assert_eq!(refusal, DrainRefusal::NotNow);
        assert!(
            message.is_none(),
            "no words here: the dialog reads the budgets itself"
        );
    }

    /// It left on its own between the listing and its turn. Neither an
    /// eviction this drain performed nor a refusal — the third state.
    #[test]
    fn a_pod_that_already_left_is_neither_evicted_nor_refused() {
        assert_eq!(outcome_of(api_error(404)), Evicted::AlreadyGone);
        assert_eq!(outcome_of(api_error(410)), Evicted::AlreadyGone);
    }

    /// Anything this app has no name for still leaves the pod, and carries
    /// the API's own sentence so the reader has something to act on.
    #[test]
    fn an_unrecognised_failure_leaves_the_pod_and_quotes_the_server() {
        let Evicted::No(refusal, Some(message)) = outcome_of(api_error(403)) else {
            panic!("an unrecognised failure leaves the pod and says why");
        };
        assert_eq!(refusal, DrainRefusal::Other);
        assert!(message.contains("403"), "got {message:?}");
    }

    /// Not every failure is an API rejection — a dropped connection has no
    /// HTTP code at all, and must not fall through to anything destructive.
    #[test]
    fn a_transport_failure_also_leaves_the_pod() {
        assert!(matches!(
            outcome_of(kube::Error::LinesCodecMaxLineLengthExceeded),
            Evicted::No(DrainRefusal::Other, Some(_))
        ));
    }

    // --- what the loop does with a refusal ----------------------------------

    /// The whole reason this waits. Only a 429 can answer differently later;
    /// the other three need the operator, and asking the cluster again would
    /// be an endless loop over a question it cannot answer.
    #[test]
    fn only_the_refusal_that_can_change_is_worth_waiting_on() {
        assert!(DrainRefusal::NotNow.worth_asking_again());
        assert!(!DrainRefusal::NothingWouldReplaceIt.worth_asking_again());
        assert!(!DrainRefusal::HoldsLocalData.worth_asking_again());
        assert!(!DrainRefusal::Other.worth_asking_again());
    }

    #[test]
    fn the_wait_grows_and_then_holds() {
        assert_eq!(backoff_for(1), BACKOFF[0]);
        assert_eq!(backoff_for(2), BACKOFF[1]);
        assert_eq!(backoff_for(4), BACKOFF[3]);
        assert_eq!(
            backoff_for(9_999),
            *BACKOFF.last().unwrap(),
            "a long wait holds at the cap instead of running off the end"
        );
    }

    // --- bookkeeping ---------------------------------------------------------

    /// Unlike a search, which has one consumer and supersedes itself, two
    /// nodes can legitimately drain at once. Cancelling one because another
    /// started would be the tool deciding something cluster-wide on its own.
    #[tokio::test]
    async fn starting_a_second_drain_leaves_the_first_running() {
        let (manager, _rx) = manager();

        let first = manager.start(nowhere(), "node-a".to_string(), safe());
        let second = manager.start(nowhere(), "node-b".to_string(), safe());

        assert_eq!(manager.active_drains(), 2);
        assert_ne!(first.drain_id, second.drain_id);
        assert!(manager.mark_subscribed(&first.drain_id).is_ok());
        assert!(manager.mark_subscribed(&second.drain_id).is_ok());

        manager.cancel_all();
    }

    #[tokio::test]
    async fn cancel_is_idempotent_and_unknown_ids_do_not_panic() {
        let (manager, _rx) = manager();
        let handle = manager.start(nowhere(), "node-a".to_string(), safe());

        manager.cancel(&handle.drain_id);
        manager.cancel(&handle.drain_id);
        manager.cancel("no-such-drain");
        assert_eq!(manager.active_drains(), 0);
    }

    /// The one test that drives the whole task: the gate opens, a pass runs,
    /// the failure is classified, the finish event goes out and the session
    /// row is cleaned up. It reaches a port nothing listens on, so what it
    /// proves is the path, not the cluster.
    #[tokio::test]
    async fn a_drain_that_cannot_reach_the_cluster_says_so_and_stops() {
        let (manager, mut rx) = manager();
        let handle = manager.start(nowhere(), "node-a".to_string(), safe());
        manager
            .mark_subscribed(&handle.drain_id)
            .expect("the drain is there to subscribe to");

        let finished = tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                match rx.recv().await.expect("the channel stays open") {
                    AppEvent::DrainFinished {
                        drain_id,
                        outcome,
                        message,
                        ..
                    } if drain_id == handle.drain_id => return (outcome, message),
                    _ => {}
                }
            }
        })
        .await
        .expect("a drain that cannot connect has to finish, not hang");

        assert_eq!(finished.0, DrainOutcome::Failed);
        assert!(
            finished.1.is_some(),
            "a failure has to carry what broke, or the dialog has nothing to show"
        );
        assert_eq!(
            manager.active_drains(),
            0,
            "the session row goes with the task, on every exit path"
        );
    }

    #[tokio::test]
    async fn subscribing_to_a_drain_that_is_not_there_is_an_error() {
        let (manager, _rx) = manager();
        assert!(manager.mark_subscribed("nope").is_err());
    }

    // --- the seam with the frontend ------------------------------------------

    /// These four shapes reach the webview through `AppEvent`, and the type
    /// generator only emits what a *command* signature reaches — so the
    /// frontend writes them out by hand in `src/hooks/useNodeDrain.ts`, the
    /// way `useResourceSearch` does for `SearchHit`.
    ///
    /// Hand-written means nothing tells you when they drift. This does. If
    /// you renamed a field or a variant, change it there too and then change
    /// it here.
    #[test]
    fn the_shapes_the_frontend_mirrors_by_hand() {
        let report = DrainReport {
            evicted: 1,
            already_gone: 2,
            leaving: 4,
            daemonset_pods_left: 3,
            refused: vec![RefusedPod::new(
                "n".to_string(),
                "p".to_string(),
                DrainRefusal::NotNow,
            )],
        };
        let value = serde_json::to_value(&report).expect("a report serialises");

        let mut keys: Vec<&str> = value
            .as_object()
            .expect("an object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "alreadyGone",
                "daemonsetPodsLeft",
                "evicted",
                "leaving",
                "refused"
            ],
            "DrainReport's fields moved; update src/hooks/useNodeDrain.ts"
        );

        let mut pod_keys: Vec<&str> = value["refused"][0]
            .as_object()
            .expect("an object")
            .keys()
            .map(String::as_str)
            .collect();
        pod_keys.sort_unstable();
        assert_eq!(
            pod_keys,
            ["message", "name", "namespace", "refusal"],
            "RefusedPod's fields moved; update src/hooks/useNodeDrain.ts"
        );

        let spellings = |values: Vec<serde_json::Value>| -> Vec<String> {
            values
                .into_iter()
                .map(|v| v.as_str().expect("a string").to_string())
                .collect()
        };

        assert_eq!(
            spellings(vec![
                serde_json::to_value(DrainRefusal::NotNow).unwrap(),
                serde_json::to_value(DrainRefusal::NothingWouldReplaceIt).unwrap(),
                serde_json::to_value(DrainRefusal::HoldsLocalData).unwrap(),
                serde_json::to_value(DrainRefusal::Other).unwrap(),
            ]),
            ["notNow", "nothingWouldReplaceIt", "holdsLocalData", "other"],
            "DrainRefusal's spellings moved; update src/hooks/useNodeDrain.ts"
        );

        assert_eq!(
            spellings(vec![
                serde_json::to_value(DrainOutcome::Drained).unwrap(),
                serde_json::to_value(DrainOutcome::Stopped).unwrap(),
                serde_json::to_value(DrainOutcome::Cancelled).unwrap(),
                serde_json::to_value(DrainOutcome::Failed).unwrap(),
            ]),
            ["drained", "stopped", "cancelled", "failed"],
            "DrainOutcome's spellings moved; update src/hooks/useNodeDrain.ts"
        );
    }
}
