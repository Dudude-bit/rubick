import type { ConditionInfo } from "@/generated/types";
import type { StatusRole } from "@/lib/status-role";

/**
 * Conditions whose unremarkable value is `False`.
 *
 * A node reports pressure by setting the condition True, which is the exact
 * opposite of the Ready-style conditions. Colouring on the status word alone
 * painted a perfectly healthy node's `MemoryPressure=False` red.
 *
 * `Suspended` and `Terminating` are here for the same reason and not because
 * True is a fault: they name a thing that is usually not happening, so False
 * is the quiet value. What True means for them is decided by `ADVISORY`.
 */
const HEALTHY_WHEN_FALSE = new Set([
  "memorypressure",
  "diskpressure",
  "pidpressure",
  "networkunavailable",
  "replicafailure",
  "failed",
  "failuretarget",
  "suspended",
  "terminating",
  // Gateway API listeners: a controller that looked writes these False.
  "conflicted",
  "overlappingtlsconfig",
  // An HPA inside its range says False; True is the floor or the ceiling.
  "scalinglimited",
  // kstatus, as Flux writes it: True is a reconcile under way, or one that gave up.
  "reconciling",
  "stalled",
  // A CRD whose schema the API server cannot prune or default by.
  "nonstructuralschema",
  // A pod about to be evicted or preempted.
  "disruptiontarget",
  // A namespace being deleted: True is what the deletion waits on or failed at.
  "namespacedeletiondiscoveryfailure",
  "namespacedeletiongroupversionparsingfailure",
  "namespacedeletioncontentfailure",
  "namespacecontentremaining",
  "namespacefinalizersremaining",
]);

/**
 * Conditions whose off value is a fact rather than a fault, and so may not
 * spend a severity colour on being off.
 *
 * `DisruptionAllowed=False` is the case that forced this out of the
 * true/false model. A PodDisruptionBudget says False whenever the budget is
 * currently spent — which is the *normal* state of a budget doing its job on
 * a two-replica workload — and painting it red claimed a fault the cluster
 * never reported. The Job controller's are the same shape: a Job that is not
 * `Complete` yet is running, and a `Suspended` one is suspended because
 * somebody suspended it.
 */
const ADVISORY = new Set([
  "disruptionallowed",
  "suspended",
  "complete",
  "successcriteriamet",
  "terminating",
]);

/**
 * Conditions whose off value means "not yet", not "wrong".
 *
 * A pod that is thirty seconds old has `PodReadyToStartContainers=False`
 * because its sandbox is still being built and `Initialized=False` because
 * its init containers are still running. Both are the system working. They
 * became red triangles under the old rule, on every pod, for the first few
 * seconds of its life — and the pod that is genuinely stuck says so through
 * `Ready`, its container states and its events, all of which are louder and
 * none of which are guesses.
 */
const LIFECYCLE_STEP = new Set(["podreadytostartcontainers", "initialized"]);

/**
 * Conditions whose off value is a caution, not a fault.
 *
 * A Gateway listener on `*.example.com` beside one on `foo.example.com` gets
 * `OverlappingTLSConfig=True`, and both go on serving: the spec raises it for
 * what HTTP/2 connection coalescing may do, not for a listener that broke.
 * An HPA at its ceiling, or blind to its metrics, holds the workload at the
 * size it has: the amber `autoscalerVerdict` gives the same two.
 */
const CAUTION = new Set([
  "overlappingtlsconfig",
  "scalinglimited",
  "scalingactive",
  "nonstructuralschema",
  "disruptiontarget",
]);

/** The kubelet's reasons on a pod that has ended, which only some of its conditions carry. */
const ENDED = new Set(["PodCompleted", "PodFailed"]);

/**
 * What a reason says that its status word does not, as `type=status/reason`;
 * a bare `type=status` is that status whatever the reason. Read first: the
 * sets above know a type by its status alone, and painted a healthy
 * certificate red and a renewal under way green.
 */
const SAID: Record<string, StatusRole> = {
  // cert-manager: True while a request is out. A success takes the condition
  // away, or under server-side apply leaves it False with `Issued`; any other
  // False is the last attempt, failed and in its backoff.
  "issuing=true": "pending",
  "issuing=false/Issued": "ok",
  // The kubelet's reason on a pod that ran to completion.
  "ready=false/PodCompleted": "neutral",
  "containersready=false/PodCompleted": "neutral",
  // Held at minReplicas, and scaled to zero by hand: at rest, not limited.
  "scalinglimited=true/TooFewReplicas": "neutral",
  // Moving as fast as its scale rate allows: scaling, not stuck.
  "scalinglimited=true/ScaleUpLimit": "neutral",
  "scalinglimited=true/ScaleDownLimit": "neutral",
  "scalingactive=false/ScalingDisabled": "neutral",
  // The disruption controller could not work the budget out at all.
  "disruptionallowed=false/SyncFailed": "err",
  // Somebody paused the rollout; the controller did not stop reporting.
  "progressing=unknown/DeploymentPaused": "neutral",
  // Under way, and what a deletion is waiting for: neither is a fault yet.
  "reconciling=true": "pending",
  "namespacecontentremaining=true": "pending",
  "namespacefinalizersremaining=true": "pending",
};

const normalize = (type: string) => type.toLowerCase().replace(/[\s_-]/g, "");

/**
 * What a condition is, in the same five roles every other state in the app is
 * drawn with — so a condition row carries the glyph and the hue that a status
 * column, a container block and a pod picker already carry, rather than a
 * private two-colour ladder of its own.
 *
 * `among` is the conditions it stands with: a finished pod's sandbox is
 * `PodReadyToStartContainers=False` with no reason of its own, and only its
 * siblings say the pod has ended rather than not begun.
 */
export function conditionRole(
  condition: ConditionInfo,
  among: readonly ConditionInfo[]
): StatusRole {
  const status = condition.status.toLowerCase();
  const type = normalize(condition.type);
  const said =
    SAID[`${type}=${status}/${condition.reason ?? ""}`] ??
    SAID[`${type}=${status}`];
  if (said) return said;
  // Unknown is the kubelet having stopped reporting. That is not the object
  // failing, it is the object being unreadable, which is `warn` everywhere
  // else in the app.
  if (status !== "true" && status !== "false") return "warn";
  const healthyValue = HEALTHY_WHEN_FALSE.has(type) ? "false" : "true";
  if (status === healthyValue) return "ok";
  if (ADVISORY.has(type)) return "neutral";
  if (CAUTION.has(type)) return "warn";
  if (!LIFECYCLE_STEP.has(type)) return "err";
  return among.some((other) => ENDED.has(other.reason ?? ""))
    ? "neutral"
    : "pending";
}

/**
 * The condition that says the object is in trouble, or nothing.
 *
 * `ignore` is for the conditions that only restate something the caller can
 * say better: on a pod, `Ready=False · containers with unready status: [app]`
 * is the same fact as the container's own `ImagePullBackOff` with the answer
 * taken out of it.
 */
export function failingCondition(
  conditions: readonly ConditionInfo[],
  ignore: readonly string[] = []
): ConditionInfo | null {
  const skip = new Set(ignore.map((type) => type.toLowerCase()));
  return (
    conditions.find(
      (condition) =>
        !skip.has(condition.type.toLowerCase()) &&
        conditionRole(condition, conditions) === "err"
    ) ?? null
  );
}

/**
 * The condition worth a look though nothing failed — a caution, or one the
 * controller has not decided — or nothing. Asked after `failingCondition`.
 */
export function cautioningCondition(
  conditions: readonly ConditionInfo[]
): ConditionInfo | null {
  return (
    conditions.find(
      (condition) => conditionRole(condition, conditions) === "warn"
    ) ?? null
  );
}

/** What the controller said, in its own words: reason and message, else type and status. */
export const conditionSaid = (c: ConditionInfo): string =>
  [c.reason, c.message].filter(Boolean).join(": ") || `${c.type}: ${c.status}`;
