/**
 * The PromQL, and nothing else. Pure strings from pure inputs, so the part
 * of this integration that is easiest to get quietly wrong is the part that
 * can be asserted on without a server. Every query here was compared against
 * `kubectl top` on a real cluster before it was believed.
 *
 * `container!=""` is load-bearing. cAdvisor emits three series for a
 * one-container pod: the pod's own cgroup roll-up, the pause container that
 * owns the network namespace (neither carries a `container` label, on
 * containerd), and the real container. Summing without the filter counts the
 * workload twice — measured: `busy-demo` reads 40m unfiltered and 20m
 * filtered, and `kubectl top pod` says 20m. `container="POD"` is the older
 * runtimes' spelling of the pause container and is excluded too.
 *
 * Network is the exception: every container in a pod shares one network
 * namespace, so cAdvisor reports traffic only on the sandbox — the very
 * series `container!=""` throws away. Traffic sums over interfaces instead,
 * minus loopback, which is a pod talking to itself.
 */

import { escapeRegex, podPattern } from "../pod-names";
import { RANGE_WINDOW_MS } from "../registry";
import type { UsageRange, UsageScope } from "../registry";

export { escapeRegex, podPattern };

/**
 * How a range is drawn, and what that costs in fidelity.
 *
 * Max per bucket, never mean: a bucket wide enough to hide a spike hides the
 * thirty seconds that got a container OOM-killed, which is the one reading
 * anybody opens this chart for. So every bucket asks Prometheus, through a
 * subquery, for the *largest* value at a finer resolution inside it rather
 * than for whatever the series read at the bucket's own boundary.
 *
 * `inner` is `null` for the shortest range, where the bucket already is the
 * scrape resolution and there is nothing finer to take a maximum over — the
 * label under the picker names the resolution for exactly this reason.
 */
export interface RangeSpec {
  id: UsageRange;
  /** How far back the window reaches, in milliseconds — the registry's
   *  number, so a range means the same span here as it does in a log. */
  windowMs: number;
  /** Seconds between drawn points. ~120 of them, which is the bucket count
   *  the watched-window chart already draws at. */
  stepSeconds: number;
  /**
   * The counter window a `rate` is taken over. Wider than the step on the
   * long ranges, because a rate window narrower than two scrape intervals
   * has nothing to divide and returns gaps.
   */
  rateWindow: string;
  /** The resolution each bucket takes its maximum across, or `null`. */
  inner: string | null;
  /** What the chart says it is drawing, in words. */
  resolution: string;
}

export const RANGE_SPECS: Readonly<Record<UsageRange, RangeSpec>> = {
  "15m": {
    id: "15m",
    windowMs: RANGE_WINDOW_MS["15m"],
    stepSeconds: 15,
    rateWindow: "1m",
    inner: null,
    resolution: "15s buckets, at the scrape resolution",
  },
  "1h": {
    id: "1h",
    windowMs: RANGE_WINDOW_MS["1h"],
    stepSeconds: 30,
    rateWindow: "1m",
    inner: "15s",
    resolution: "30s buckets, max over a 15s resolution",
  },
  "6h": {
    id: "6h",
    windowMs: RANGE_WINDOW_MS["6h"],
    stepSeconds: 180,
    rateWindow: "2m",
    inner: "30s",
    resolution: "3m buckets, max over a 30s resolution",
  },
  "24h": {
    id: "24h",
    windowMs: RANGE_WINDOW_MS["24h"],
    stepSeconds: 720,
    rateWindow: "5m",
    inner: "2m",
    resolution: "12m buckets, max over a 2m resolution",
  },
  "7d": {
    id: "7d",
    windowMs: RANGE_WINDOW_MS["7d"],
    stepSeconds: 5400,
    rateWindow: "10m",
    inner: "5m",
    resolution: "90m buckets, max over a 5m resolution",
  },
};

/** A label value, with the two characters that would end it early escaped. */
export function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** The label matchers that select a scope's containers. */
function containerSelector(scope: UsageScope): string {
  const real = 'container!="",container!="POD"';
  switch (scope.kind) {
    case "pod":
      return `namespace="${escapeLabel(scope.namespace)}",pod="${escapeLabel(scope.pod)}",${real}`;
    case "workload":
      return `namespace="${escapeLabel(scope.namespace)}",pod=~"${escapeLabel(
        podPattern(scope.ownerKind, scope.owner)
      )}",${real}`;
    case "node":
      // The node's own root cgroup: everything the kubelet accounts for,
      // including the containers no namespace owns.
      return `id="/"`;
  }
}

/**
 * Which label names the node — asked every way, because the answer depends
 * on how somebody else's Prometheus was configured.
 *
 * `instance` is what a kubelet job scraped through the API server proxy
 * reports, `node` is what kube-prometheus-stack relabels to, `nodename` is
 * node-exporter's, and `kubernetes_io_hostname` is what a `labelmap` of the
 * node's own labels leaves behind. Guessing one would be the sniffing this
 * app refuses; asking for their union costs one `or` and is right on all.
 *
 * **One list, three readers.** The grouping, the per-node selector and
 * `nodeNameOf` — which keys a returned series back to a node — all read it.
 * They used to carry three different lists: the grouping asked for
 * `kubernetes_io_hostname`, the reader could not spell it, and every series
 * a Prometheus labelled that way was keyed to nothing and dropped, so the
 * node reported "no series in Prometheus" while its samples sat in hand.
 *
 * Order is trust: `instance` is `10.0.0.4:9100`, whose host half often is
 * not a node name at all, so it is tried last.
 */
export const NODE_LABELS = [
  "node",
  "nodename",
  "kubernetes_io_hostname",
  "instance",
] as const;

/**
 * The same selector once per candidate label, joined by `or`.
 *
 * `fn` wraps each selector where the metric is a counter (`rate`), and is
 * empty for a gauge. Identical series on both sides of an `or` collapse to
 * one, so a Prometheus carrying two of the three spellings does not double.
 */
function nodeUnion(
  fn: "rate" | "",
  node: string,
  metric: string,
  window = ""
): string {
  const name = escapeLabel(node);
  return NODE_LABELS.map((label) => {
    const selector = `${metric}{id="/",${label}="${name}"}${window}`;
    return fn === "" ? selector : `${fn}(${selector})`;
  }).join(" or ");
}

/** Wraps an expression so the bucket reports its peak rather than its edge. */
function peak(expression: string, spec: RangeSpec): string {
  if (spec.inner === null) return expression;
  return `max_over_time((${expression})[${spec.stepSeconds}s:${spec.inner}])`;
}

/**
 * CPU, in millicores, summed to the scope.
 *
 * `rate` of the counter is seconds-of-CPU per second, which is cores; the
 * app's charts are in millicores everywhere else, so the factor of a
 * thousand is applied here rather than left for a caller to forget.
 */
export function cpuQuery(scope: UsageScope, spec: RangeSpec): string {
  const expression =
    scope.kind === "node"
      ? `max(${nodeUnion(
          "rate",
          scope.node,
          `container_cpu_usage_seconds_total`,
          `[${spec.rateWindow}]`
        )})`
      : `sum(rate(container_cpu_usage_seconds_total{${containerSelector(scope)}}[${spec.rateWindow}]))`;
  return `${peak(expression, spec)} * 1000`;
}

/**
 * Memory, in bytes, summed to the scope.
 *
 * Working set rather than RSS or usage: it is the number the kernel's OOM
 * killer acts on and the number `kubectl top` prints, so a chart drawn from
 * anything else would disagree with both.
 */
export function memoryQuery(scope: UsageScope, spec: RangeSpec): string {
  const expression =
    scope.kind === "node"
      ? `max(${nodeUnion("", scope.node, "container_memory_working_set_bytes")})`
      : `sum(container_memory_working_set_bytes{${containerSelector(scope)}})`;
  return peak(expression, spec);
}

/**
 * How many times a container in this scope started, per bucket.
 *
 * `container_start_time_seconds` changing is a container that came back, and
 * cAdvisor reports it on every cluster — unlike
 * `kube_pod_container_status_restarts_total`, which needs kube-state-metrics
 * and would make the restart marker depend on a second install.
 *
 * The window is the bucket, so a restart is attributed to the bucket it
 * happened in rather than smeared across the rate window.
 */
/**
 * What was declared, as kube-state-metrics recorded it: a step function,
 * so no peak wrapping — the value at the bucket's edge is the value.
 * Cores come back as cores and go out as millicores, like everything else.
 */
export function declaredQuery(
  scope: UsageScope,
  resource: "cpu" | "memory",
  what: "requests" | "limits"
): string {
  const selector =
    scope.kind === "pod"
      ? `namespace="${escapeLabel(scope.namespace)}",pod="${escapeLabel(scope.pod)}"`
      : scope.kind === "workload"
        ? `namespace="${escapeLabel(scope.namespace)}",pod=~"${escapeLabel(
            podPattern(scope.ownerKind, scope.owner)
          )}"`
        : `node="${escapeLabel(scope.node)}"`;
  const sum = `sum(kube_pod_container_resource_${what}{resource="${resource}",${selector}})`;
  return resource === "cpu" ? `${sum} * 1000` : sum;
}

/**
 * Every node at once, keyed by whatever node label this Prometheus writes.
 *
 * Derived from {@link NODE_LABELS} rather than spelled again: a label this
 * groups by that the reader cannot spell is a series keyed to nothing.
 */
const NODE_GROUPING = `by (${NODE_LABELS.join(", ")})`;

export function nodesQuery(kind: "cpu" | "memory", spec: RangeSpec): string {
  const by = NODE_GROUPING;
  const expression =
    kind === "cpu"
      ? `max ${by} (rate(container_cpu_usage_seconds_total{id="/"}[${spec.rateWindow}]))`
      : `max ${by} (container_memory_working_set_bytes{id="/"})`;
  const peaked = peak(expression, spec);
  return kind === "cpu" ? `${peaked} * 1000` : peaked;
}

/** When each node last reported anything, so an empty window can say how empty. */
export function nodesNewestQuery(): string {
  return `max ${NODE_GROUPING} (timestamp(container_cpu_usage_seconds_total{id="/"}))`;
}

export function restartQuery(scope: UsageScope, spec: RangeSpec): string {
  if (scope.kind === "node") return "";
  return `sum(changes(container_start_time_seconds{${containerSelector(scope)}}[${spec.stepSeconds}s]))`;
}

/**
 * How full each of a namespace's volumes is.
 *
 * Two series rather than the ratio, because the row states used *and*
 * capacity: a bare percentage gets misread as a share of the declared size,
 * which it is not. The kubelet reports the filesystem behind the volume, and
 * for a provisioner that does not enforce a quota (`local-path`, `hostPath`)
 * that filesystem is the node's.
 */
export function volumeUsedQuery(namespace: string, claims: string[]): string {
  return `kubelet_volume_stats_used_bytes{${claimSelector(namespace, claims)}}`;
}

export function volumeCapacityQuery(
  namespace: string,
  claims: string[]
): string {
  return `kubelet_volume_stats_capacity_bytes{${claimSelector(namespace, claims)}}`;
}

function claimSelector(namespace: string, claims: string[]): string {
  const names = claims.map(escapeRegex).join("|");
  return `namespace="${escapeLabel(namespace)}",persistentvolumeclaim=~"^(${names})$"`;
}

/**
 * Bytes per second in and out of a scope's pods.
 *
 * Summed over interfaces with loopback excluded — a pod talking to itself is
 * not traffic — and deliberately *without* the `container!=""` filter that
 * the CPU and memory queries need: the counters live on the sandbox
 * container, which that filter removes entirely.
 */
export function trafficQuery(
  scope: UsageScope,
  spec: RangeSpec,
  direction: "receive" | "transmit"
): string {
  if (scope.kind === "node") return "";
  const pods =
    scope.kind === "pod"
      ? `namespace="${escapeLabel(scope.namespace)}",pod="${escapeLabel(scope.pod)}"`
      : `namespace="${escapeLabel(scope.namespace)}",pod=~"${escapeLabel(
          podPattern(scope.ownerKind, scope.owner)
        )}"`;
  const metric = `container_network_${direction}_bytes_total`;
  return peak(
    `sum(rate(${metric}{${pods},interface!="lo"}[${spec.rateWindow}]))`,
    spec
  );
}
