import type { ConditionInfo } from "@/generated/types";

/**
 * Conditions whose healthy value is `False`.
 *
 * A node reports pressure by setting the condition True, which is the exact
 * opposite of the Ready-style conditions. Colouring on the status word alone
 * painted a perfectly healthy node's `MemoryPressure=False` red.
 */
const HEALTHY_WHEN_FALSE = new Set([
  "memorypressure",
  "diskpressure",
  "pidpressure",
  "networkunavailable",
  "replicafailure",
  "failed",
  "failuretarget",
]);

export type ConditionVerdict = "good" | "unknown" | "bad";

export function conditionVerdict(condition: ConditionInfo): ConditionVerdict {
  const status = condition.status.toLowerCase();
  if (status !== "true" && status !== "false") return "unknown";
  const healthyValue = HEALTHY_WHEN_FALSE.has(
    condition.type.toLowerCase().replace(/[\s_-]/g, "")
  )
    ? "false"
    : "true";
  return status === healthyValue ? "good" : "bad";
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
        conditionVerdict(condition) === "bad"
    ) ?? null
  );
}
