/**
 * How to ask a third-party store about a workload, when the only thing it
 * knows about a pod is its name.
 *
 * Neither Prometheus nor Loki has ever heard of a ReplicaSet. Both keep the
 * pod's *name* as a label, and both are asked about a workload with a regular
 * expression over it — so the judgement about what that expression must match
 * belongs in one place rather than being made twice and drifting once.
 *
 * It lives beside the registry rather than in either vendor's folder for the
 * same reason the capability keys do: it is the app's decision about what a
 * question means, not a vendor's knowledge of its own product.
 */

/**
 * A literal inside a `=~` matcher.
 *
 * Kubernetes names are DNS-1123 and so contain only lower-case letters,
 * digits, `-` and `.` — of which `.` is the one that means something to a
 * regular expression. Left unescaped, a Deployment called `a.b` would also
 * claim the pods of one called `axb`. Both stores use RE2, so one escape
 * covers both.
 */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The pods a workload has had, by the shape its controller names them.
 *
 * **This is the rollout decision, and it is deliberate.** A Deployment's pods
 * are `<name>-<replicaset hash>-<suffix>`, and the hash changes on every
 * rollout — so matching the *current* ReplicaSet's prefix would answer for
 * one generation only, which is precisely the generation the reader can still
 * get from the API server. Matching the workload's own name with the two
 * remaining segments left open spans every generation it has ever had.
 *
 * What that looks like differs by what is being asked. On a usage chart a
 * rollout boundary is **a bump, not a gap** — both generations are briefly
 * running and both are summed. In a log it is two pods writing at once, which
 * is what actually happened and is why the lines carry their pod name.
 *
 * The segments are `[^-]+` rather than `.+` so a Deployment `foo` cannot
 * claim the pods of a Deployment `foo-bar`: `foo-bar-<hash>-<suffix>` has
 * three segments after `foo-`, and the pattern admits exactly two. **A bare
 * Pod that a human named `foo-a-b` would still match**, which is the one
 * collision left; it is not worth a second API call to rule out, and on a log
 * it is visible anyway — the line carries the pod that wrote it.
 */
export function podPattern(ownerKind: string, name: string): string {
  const stem = escapeRegex(name);
  switch (ownerKind) {
    // The ordinal is stable across rollouts — a StatefulSet's whole promise.
    case "StatefulSet":
      return `^${stem}-[0-9]+$`;
    // One indirection: the Deployment's ReplicaSet, or the CronJob's Job.
    case "Deployment":
    case "CronJob":
      return `^${stem}-[^-]+-[^-]+$`;
    // Named directly by their controller.
    default:
      return `^${stem}-[^-]+$`;
  }
}
