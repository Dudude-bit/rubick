/**
 * Which nodes stopped reporting, and therefore whose pods are describing a
 * moment that has passed.
 *
 * A pod's status is written by the kubelet on its node. When that node stops
 * answering, nothing rewrites the pod: it keeps the last state it was in, and
 * every client — this one, `kubectl get pods`, a dashboard — faithfully shows
 * a pod that may already be gone. `Running` was true when it was written.
 *
 * The window is not small. The node controller waits out
 * `node-monitor-grace-period` before it moves `Ready` to `Unknown`, then taints
 * the node `node.kubernetes.io/unreachable:NoExecute`, and pods leave only
 * after their `tolerationSeconds` — which the default admission plugin sets to
 * 300. A StatefulSet's pods do not leave at all until the node object is
 * removed or someone force-deletes them, because the guarantee is that the
 * name exists once.
 *
 * `Ready=False` is deliberately NOT silence. A node that says it is not ready
 * is a node that is still talking, so its pods' statuses are current — the node
 * is unhealthy, the reading is not stale. Only `Unknown`, or a Ready condition
 * that is missing altogether, means nobody is answering for those pods.
 */

import type { T } from "@/i18n/useT";
import type { NodeInfo } from "@/generated/types";

/** A node whose Ready condition stopped being asserted either way. */
export interface NodeSilence {
  node: string;
  /**
   * When `Ready` last changed — the moment the controller stopped believing
   * the node. `null` when the API did not say, which is not a reason to
   * withhold the warning.
   */
  since: string | null;
  /** The condition's reason, e.g. `NodeStatusUnknown`. */
  reason: string | null;
}

/**
 * A row that knows whether its reporter is still talking.
 *
 * Optional because most rows are drawn before the node list arrives, and
 * absent must read as "nothing to say" rather than as "the node is fine".
 */
export type WithNodeSilence<T> = T & { nodeSilence?: NodeSilence | null };

const READY = "Ready";
const UNKNOWN = "Unknown";

/**
 * The nodes nothing is heard from, keyed by name.
 *
 * Keyed rather than filtered because the caller has a pod and a `nodeName`,
 * and asks per row.
 */
export function silentNodes(nodes: NodeInfo[]): Map<string, NodeSilence> {
  const out = new Map<string, NodeSilence>();
  for (const node of nodes) {
    const ready = node.status.conditions.find((c) => c.type === READY);
    // A missing Ready condition is the same absence of an answer as Unknown,
    // and happens on a node that has never finished registering.
    if (ready && ready.status !== UNKNOWN) continue;
    out.set(node.name, {
      node: node.name,
      since: ready?.lastTransitionTime ?? null,
      reason: ready?.reason ?? null,
    });
  }
  return out;
}

/** The silence covering this pod, if its node is one of them. */
export function silenceOf(
  nodeName: string | null | undefined,
  silent: Map<string, NodeSilence>
): NodeSilence | null {
  if (!nodeName) return null;
  return silent.get(nodeName) ?? null;
}

/**
 * Attach each row's silence, if any.
 *
 * Returns the rows untouched when nothing is silent, so the common case costs
 * one map lookup and no new array — this runs on every pod list render.
 */
export function withNodeSilence<T extends { nodeName?: string | null }>(
  rows: T[],
  silent: Map<string, NodeSilence>
): WithNodeSilence<T>[] {
  if (silent.size === 0) return rows;
  return rows.map((row) => {
    const silence = silenceOf(row.nodeName, silent);
    return silence ? { ...row, nodeSilence: silence } : row;
  });
}

/**
 * The sentence that goes with the row.
 *
 * Says what is wrong with the *reading*, not with the pod: the caller has no
 * idea whether the pod is fine, and neither does the cluster.
 */
export function silenceNote(
  silence: NodeSilence,
  t: T,
  now: Date = new Date()
): string {
  const when = silence.since ? ago(silence.since, now) : null;
  return when
    ? t("readings", "nodeStoppedReportingAgo", {
        node: silence.node,
        age: when,
      })
    : t("readings", "nodeStoppedReporting", { node: silence.node });
}

/** `4m ago`, or null when the timestamp is unusable. */
function ago(iso: string, now: Date): string | null {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const seconds = Math.floor((now.getTime() - then) / 1000);
  // A clock that disagrees with the cluster's would otherwise produce
  // "-3m ago", which reads as a bug in this app rather than in the clock.
  if (seconds < 0) return null;
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * The word `kubectl get nodes` prints for a node's readiness.
 *
 * One place, because it was three and only one of them knew about cordons: a
 * cordoned node keeps `Ready: True`, so a reader judging by conditions alone
 * calls it healthy full stop while the overview says "Cordoned" about the
 * same object.
 *
 * The words are `kubectl`'s and stay untranslated — `statusRole` looks them
 * up to pick the colour, and the reader is comparing them against a terminal.
 */
export function nodeReadyWord(node: {
  status: { ready: boolean };
  unschedulable: boolean;
}): string {
  if (!node.status.ready) return "NotReady";
  return node.unschedulable ? "Ready,SchedulingDisabled" : "Ready";
}
