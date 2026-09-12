import type { DeclaredPoint, NodeUsageWindow } from "@/integrations";
import { parseCPU, parseMemory } from "@/lib/k8s-quantity";
import type { NodeInfo } from "@/generated/types";

/** One measure over the window, as a share of what the node can give. */
export interface TrendLane {
  /** Percent of allocatable at each bucket; `null` where nothing was sampled. */
  points: readonly DeclaredPoint[];
  peak: number;
  avg: number;
}

/**
 * Why a row has no lane. Three answers, not one:
 *
 * - `notLooked` — the window itself is unknown: still in flight, refused, or
 *   the supplier is unreachable. Saying "no series" here is a claim about
 *   somebody's Prometheus made out of our own failure to ask.
 * - `noSeries` — the window was read and holds nothing for this node.
 * - `noAllocatable` — there are samples, but the node's allocatable could not
 *   be read, so a share of it cannot be computed. A fact about the cluster,
 *   not about Prometheus.
 */
export type TrendBlind = "notLooked" | "noSeries" | "noAllocatable";

export interface NodeTrend {
  node: NodeInfo;
  /** `null` when there is no lane to draw; {@link NodeTrend.blind} says why. */
  cpu: TrendLane | null;
  memory: TrendLane | null;
  /** 100 minus the busier peak; `null` without a series. */
  headroom: number | null;
  /** How long ago the node last reported anything, when it ever did. */
  newestAgoMs: number | null;
  /** Whether the staleness probe answered at all; `false` is "could not ask". */
  newestKnown: boolean;
  /** Why there is no lane, or `null` where there is one. */
  blind: TrendBlind | null;
  cordoned: boolean;
}

/** The half of a name Prometheus and the cluster are most likely to agree on. */
export function shortName(name: string): string {
  return name.split(":")[0].split(".")[0].toLowerCase();
}

function lane(
  points: readonly DeclaredPoint[],
  allocatable: number | null
): TrendLane | null {
  if (allocatable === null || allocatable <= 0) return null;
  const shares = points.map((p) => ({
    t: p.t,
    v: p.v === null ? null : (p.v / allocatable) * 100,
  }));
  const seen = shares.filter(
    (p): p is { t: number; v: number } => p.v !== null
  );
  if (seen.length === 0) return null;
  const peak = Math.max(...seen.map((p) => p.v));
  const avg = seen.reduce((sum, p) => sum + p.v, 0) / seen.length;
  return { points: shares, peak, avg };
}

/**
 * Every node with what the window says about it, least headroom first.
 *
 * A node without a series is not a node at zero: it sorts to the end and
 * says so, with how old the newest sample is where there is one at all.
 */
export function nodeTrends(
  window: NodeUsageWindow | null,
  nodes: readonly NodeInfo[],
  now: number,
  /**
   * Whether `window` is an answer. `false` — still reading, refused, or the
   * supplier is unreachable — makes every row say "could not look" instead of
   * asserting Prometheus has nothing for the node.
   */
  windowKnown = true
): NodeTrend[] {
  const byShort = new Map<string, NodeUsageWindow["nodes"][string]>();
  const newestByShort = new Map<string, number>();
  if (window) {
    for (const [name, series] of Object.entries(window.nodes)) {
      byShort.set(shortName(name), series);
    }
    for (const [name, at] of Object.entries(window.newestAt)) {
      newestByShort.set(shortName(name), at);
    }
  }

  const trends = nodes.map((node): NodeTrend => {
    const key = shortName(node.name);
    const series = byShort.get(key);
    const cpuAllocatable = node.allocatable.cpu
      ? parseCPU(node.allocatable.cpu)
      : null;
    const memoryAllocatable = node.allocatable.memory
      ? parseMemory(node.allocatable.memory)
      : null;
    const cpu = series ? lane(series.cpuMillicores, cpuAllocatable) : null;
    const memory = series ? lane(series.memoryBytes, memoryAllocatable) : null;
    const peaks = [cpu?.peak, memory?.peak].filter(
      (p): p is number => p !== undefined
    );
    // Samples in hand but no share to draw means the node's own allocatable
    // could not be read — a fact about the cluster, not about Prometheus.
    const sampled =
      series !== undefined &&
      (series.cpuMillicores.some((p) => p.v !== null) ||
        series.memoryBytes.some((p) => p.v !== null));
    const blind: TrendBlind | null = !windowKnown
      ? "notLooked"
      : cpu !== null || memory !== null
        ? null
        : sampled
          ? "noAllocatable"
          : "noSeries";
    const newest = newestByShort.get(key);
    return {
      node,
      cpu,
      memory,
      headroom: peaks.length === 0 ? null : 100 - Math.max(...peaks),
      newestAgoMs: newest === undefined ? null : Math.max(0, now - newest),
      newestKnown: windowKnown && window?.newestKnown !== false,
      blind,
      cordoned: node.unschedulable,
    };
  });

  return trends.sort((a, b) => {
    if (a.headroom === null && b.headroom === null) {
      return a.node.name.localeCompare(b.node.name);
    }
    if (a.headroom === null) return 1;
    if (b.headroom === null) return -1;
    return a.headroom - b.headroom || a.node.name.localeCompare(b.node.name);
  });
}
