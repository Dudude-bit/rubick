/**
 * The LogQL, and nothing else.
 *
 * Pure strings from pure inputs, so the part of this integration most likely
 * to be quietly wrong is the part that can be asserted on without a server.
 *
 * ## Only a stream selector, never a filter
 *
 * Everything after `{...}` in LogQL — `|=`, `| json`, `| level >= "warn"` —
 * is deliberately not built here. The viewer already has a query language:
 * chips, evaluated over the buffer in TypeScript and at intake in Rust, with
 * a conformance corpus keeping the two evaluators saying the same thing. A
 * third evaluator with different semantics for the same chip would be a bug
 * generator with no upside — the reader would type one query and get two
 * answers depending on whether the lines came from the cluster or from Loki.
 *
 * So LogQL selects streams and the app filters lines. What comes back from a
 * range is put through the same buffer, the same chips and the same
 * highlighting as a live line.
 *
 * ## The label names are the correctness risk
 *
 * `namespace`, `pod` and `container` are what Promtail's and Alloy's stock
 * Kubernetes scrape configs write, and what every quick-start install ends
 * up with. They are *not* guaranteed: an install that relabels to
 * `k8s_namespace_name`, or drops `container` to keep cardinality down, will
 * answer every one of these queries with nothing at all.
 *
 * The answer to that is not to guess more label names — a query that tries
 * six spellings matches the wrong stream on the cluster that uses two of
 * them. It is to ask with the defaults, and to say which names were tried
 * when nothing comes back. See {@link LOKI_LABELS} and the sentence built
 * from it in `client.ts`.
 */

import { escapeRegex, podPattern } from "../pod-names";
import type { LogScope } from "../registry";

/**
 * The label names every query here is built from.
 *
 * Two, and not three: `container` is *read off* the streams that come back —
 * it is what colours a line in the legend — but it is never selected on, so
 * an install that dropped it to keep cardinality down still answers. Naming
 * it as a thing that was tried would send a reader to check a label that
 * cannot be the reason they got nothing.
 *
 * Exported because the mismatch sentence names them: "tried namespace/pod"
 * is something somebody can act on, and "no logs found" is not.
 */
export const LOKI_LABELS = ["namespace", "pod"] as const;

/** A label value, with the two characters that would end it early escaped. */
export function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * The streams a scope's lines are in.
 *
 * A pod is matched exactly and a workload by the shape its controller names
 * its pods — the same expression the usage chart uses, from
 * `../pod-names`, so a rollout does not divide a workload's history into
 * before and after. On a log that judgement pays twice: the pods a
 * Deployment had an hour ago are precisely the ones the API server can no
 * longer be asked about, and they are why anybody opened this range.
 *
 * `container` is not in the selector. Loki would happily narrow on it, but
 * the viewer's legend already hides and solos containers over the buffer,
 * and narrowing the fetch instead would make the legend's line counts a lie
 * and a solo un-undoable without a refetch.
 */
export function streamSelector(scope: LogScope): string {
  const namespace = `namespace="${escapeLabel(scope.namespace)}"`;
  if (scope.kind === "pod") {
    return `{${namespace},pod="${escapeLabel(scope.pod)}"}`;
  }
  const pattern = podPattern(scope.ownerKind, scope.owner);
  return `{${namespace},pod=~"${escapeLabel(pattern)}"}`;
}

export { escapeRegex, podPattern };
