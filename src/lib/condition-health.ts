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

const normalize = (type: string) => type.toLowerCase().replace(/[\s_-]/g, "");

/**
 * What a condition is, in the same five roles every other state in the app is
 * drawn with — so a condition row carries the glyph and the hue that a status
 * column, a container block and a pod picker already carry, rather than a
 * private two-colour ladder of its own.
 */
export function conditionRole(condition: ConditionInfo): StatusRole {
  const status = condition.status.toLowerCase();
  // Unknown is the kubelet having stopped reporting. That is not the object
  // failing, it is the object being unreadable, which is `warn` everywhere
  // else in the app.
  if (status !== "true" && status !== "false") return "warn";
  const type = normalize(condition.type);
  const healthyValue = HEALTHY_WHEN_FALSE.has(type) ? "false" : "true";
  if (status === healthyValue) return "ok";
  if (ADVISORY.has(type)) return "neutral";
  return LIFECYCLE_STEP.has(type) ? "pending" : "err";
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
        conditionRole(condition) === "err"
    ) ?? null
  );
}
