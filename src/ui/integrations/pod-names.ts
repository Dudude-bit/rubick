/**
 * How to ask a third-party store about a workload, when the only thing it
 * knows about a pod is its name.
 *
 * Neither Prometheus nor Loki has ever heard of a ReplicaSet. Both keep the
 * pod's *name* as a label, and both are asked about a workload with a regular
 * expression over it — so what that expression must match is decided in one
 * place rather than twice.
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
 * Spans every generation, deliberately. A Deployment's pods are
 * `<name>-<replicaset hash>-<suffix>` and the hash changes on every rollout,
 * so matching the *current* ReplicaSet's prefix would answer for one
 * generation — precisely the one the reader can still get from the API
 * server. Matching the workload's own name with the two remaining segments
 * left open covers all of them.
 *
 * So a rollout boundary is a bump on a usage chart, not a gap: both
 * generations are briefly running and both are summed. In a log it is two
 * pods writing at once, which is what happened, and why the lines carry their
 * pod name.
 *
 * Neither store knows who owns a pod, so the name is all there is, and it is
 * read exactly as a controller writes it: the generated segments are drawn
 * from `rand.String`'s alphabet, five characters for a pod's suffix and up
 * to ten for a ReplicaSet's hash. Two segments of anything let a Deployment
 * `myapp` claim `myapp-postgresql-0` and `myapp-migrate-x8k2j`, and its
 * history was the app's and its database's summed. What is still shared is
 * a sibling DaemonSet or Job whose own name ends in a segment spelled from
 * that alphabet alone (`myapp-db`).
 */
const GENERATED = "[bcdfghjklmnpqrstvwxz2456789]";

export function podPattern(ownerKind: string, name: string): string {
  const stem = escapeRegex(name);
  const suffix = `${GENERATED}{5}`;
  switch (ownerKind) {
    // The ordinal is stable across rollouts — a StatefulSet's whole promise.
    case "StatefulSet":
      return `^${stem}-[0-9]+$`;
    // Through its ReplicaSet, named by the pod template's hash.
    case "Deployment":
      return `^${stem}-${GENERATED}{1,10}-${suffix}$`;
    // Through its Job, named by the minute it was scheduled for.
    case "CronJob":
      return `^${stem}-[0-9]+-${suffix}$`;
    // Named directly by their controller.
    default:
      return `^${stem}-${suffix}$`;
  }
}
