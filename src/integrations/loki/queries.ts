/**
 * The LogQL, and nothing else. Pure strings from pure inputs, so the part of
 * this integration most likely to be quietly wrong is the part that can be
 * asserted on without a server.
 *
 * Only a stream selector, never a filter: everything after `{...}` — `|=`,
 * `| json`, `| level >= "warn"` — is deliberately not built here. The viewer
 * already evaluates its query language twice (TypeScript over the buffer,
 * Rust at intake, with a conformance corpus keeping the two agreeing), and a
 * third evaluator would mean one typed query and two answers, depending on
 * whether the line came live or from Loki.
 *
 * The label names are the correctness risk: `namespace`, `pod` and
 * `container` are what stock Promtail and Alloy scrape configs write, not
 * what Loki guarantees, and an install that relabels to `k8s_namespace_name`
 * or drops `container` for cardinality answers every query here with nothing.
 * Guessing more spellings is worse — six guesses match the wrong stream on
 * the cluster that uses two — so queries ask with the defaults and say which
 * names were tried. See {@link LOKI_LABELS} and the sentence built from it in
 * `client.ts`.
 */

import { escapeRegex, podPattern } from "../pod-names";
import type { LogScope } from "../registry";

/**
 * The label names every query here is built from.
 *
 * Two, and not three: `container` is *read off* the streams that come back —
 * it is what colours a line in the legend — but never selected on, so an
 * install that dropped it to keep cardinality down still answers, and naming
 * it as a label that was tried would send a reader to check a label that
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
 * its pods — the same expression the usage chart uses, from `../pod-names`,
 * so a rollout does not divide a workload's history into before and after.
 * The pods a Deployment had an hour ago are precisely the ones the API
 * server can no longer be asked about, and they are why anybody opened this
 * range.
 *
 * `container` is not in the selector: the viewer's legend already hides and
 * solos containers over the buffer, and narrowing the fetch instead would
 * make the legend's line counts a lie and a solo un-undoable without a
 * refetch.
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
