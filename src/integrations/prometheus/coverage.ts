/**
 * Whether the Prometheus somebody connected is watching *this* cluster.
 *
 * The question the whole page exists for, and one nothing else in the app can
 * ask. A connection is judged by a probe, and a probe only proves the address
 * answers PromQL — so pointing the app at the organisation's central
 * Prometheus, which scrapes four clusters and not this one, produces a
 * connection that reads as healthy and charts that are about somebody else's
 * pods. Every number is real. None of them is yours.
 *
 * The check is a comparison rather than a judgement: the node names Prometheus
 * knows against the node names this cluster has. Nothing else identifies a
 * cluster from the outside — a namespace called `default` exists everywhere,
 * and a pod name is gone by tomorrow — while a node name is long, specific and
 * stable enough to be a fingerprint.
 *
 * ## And whether the metrics it needs are there
 *
 * A Prometheus that scrapes the right cluster but not its kubelets answers
 * every query with an empty series, and an empty series draws an empty chart
 * that looks exactly like a quiet pod. So the families the capabilities are
 * built on are checked by name, once, and a missing one is named — because
 * "install kube-state-metrics" and "your pod used no CPU" are the same
 * picture and very different repairs.
 */

import { commands } from "@/lib/commands";
import type { PromSeries } from "@/generated/types";

/** The label a node's name lands in, per exporter, most specific first. */
const NODE_LABELS = ["node", "instance", "nodename"] as const;

/**
 * The families each capability is built on, named so a gap can be attributed.
 *
 * Deliberately the metric *this app queries*, not a representative one: the
 * point is to answer "why is that chart empty", and only the exact name the
 * query uses can.
 */
export const FAMILIES: Array<{
  metric: string;
  powers: string;
  from: string;
}> = [
  {
    metric: "container_cpu_usage_seconds_total",
    powers: "CPU over a window longer than this app has been open",
    from: "cAdvisor, via the kubelet",
  },
  {
    metric: "container_memory_working_set_bytes",
    powers: "memory history",
    from: "cAdvisor, via the kubelet",
  },
  {
    metric: "kubelet_volume_stats_used_bytes",
    powers: "how full a volume actually is",
    from: "the kubelet",
  },
  {
    metric: "container_network_receive_bytes_total",
    powers: "bytes in and out of a workload",
    from: "cAdvisor, via the kubelet",
  },
];

export interface Coverage {
  /** Node names this cluster has and Prometheus has never scraped. */
  unseen: string[];
  /** Node names Prometheus knows that are not in this cluster. */
  foreign: string[];
  /** How many of the cluster's nodes it does know. */
  matched: number;
  clusterNodes: number;
  /** Families the app queries and this Prometheus has no series for. */
  missing: Array<(typeof FAMILIES)[number]>;
  /**
   * How many series each family answers with, by metric name — the row's
   * own evidence, so "is it there" is read off the page rather than clicked
   * into the graph UI. `null` where the count could not be read; a family
   * that answered nothing at all is in {@link missing} instead.
   */
  series: Record<string, number | null>;
  /** Set where the comparison could not be made at all. */
  problem: string | null;
}

const nameFrom = (series: PromSeries): string | null => {
  for (const label of NODE_LABELS) {
    const value = series.labels[label];
    if (typeof value === "string" && value !== "") {
      // `instance` is `10.0.0.4:9100` on a node exporter; the host half is
      // the part that could match a node name, and often does not — which is
      // why it is the last label tried rather than the first.
      return value.split(":")[0];
    }
  }
  return null;
};

/**
 * A name Prometheus and Kubernetes may spell differently.
 *
 * A node is `ip-10-0-1-4.eu-west-1.compute.internal` to Kubernetes and
 * frequently `ip-10-0-1-4` to a scrape target, so the comparison is on the
 * first label. Wrong in the lenient direction only — two nodes in one cluster
 * never share a first label — and being lenient is right here, because the
 * finding this produces sends somebody to change a connection.
 */
const shortName = (name: string) => name.split(".")[0].toLowerCase();

export async function coverage(): Promise<Coverage> {
  const empty: Coverage = {
    unseen: [],
    foreign: [],
    matched: 0,
    clusterNodes: 0,
    missing: [],
    series: {},
    problem: null,
  };

  const nodes = await commands.listNodes(null).catch(() => null);
  if (nodes === null) {
    return {
      ...empty,
      problem:
        "This cluster's nodes could not be listed, so there is nothing to compare what Prometheus knows against.",
    };
  }

  // One instant query per family, plus the node one. `up` is deliberately not
  // used: it is present on any Prometheus at all and would say nothing about
  // whether this cluster is among what it scrapes. The count is kept, not
  // reduced to presence — it is the row's own evidence of what is there.
  const [seen, ...counts] = await Promise.all([
    commands
      .prometheusQuery("count by (node) (kube_node_info)")
      .catch(() => null),
    ...FAMILIES.map((family) =>
      commands
        .prometheusQuery(`count(${family.metric})`)
        .then((answer): number | null =>
          answer.length === 0 ? 0 : (answer[0].points[0]?.v ?? null)
        )
        // A failed read is unknown, never "missing": the difference between
        // "install kube-state-metrics" and "the tunnel dropped".
        .catch((): number | null => null)
    ),
  ]);

  const missing = FAMILIES.filter((_, index) => counts[index] === 0);
  const series = Object.fromEntries(
    FAMILIES.map((family, index) => [family.metric, counts[index]])
  );

  if (seen === null) {
    return {
      ...empty,
      clusterNodes: nodes.length,
      missing,
      series,
      problem:
        "kube_node_info returned nothing — kube-state-metrics is not among what this Prometheus scrapes, so which cluster it is watching cannot be established from here.",
    };
  }

  const known = new Set(
    seen.flatMap((series) => {
      const name = nameFrom(series);
      return name ? [shortName(name)] : [];
    })
  );
  const ours = new Set(nodes.map((node) => shortName(node.name)));

  const unseen = nodes
    .filter((node) => !known.has(shortName(node.name)))
    .map((node) => node.name);
  const foreign = [...known].filter((name) => !ours.has(name));

  return {
    unseen,
    foreign: foreign.sort(),
    matched: nodes.length - unseen.length,
    clusterNodes: nodes.length,
    missing,
    series,
    problem: null,
  };
}

/** What the comparison amounts to, in one word for the row. */
export function verdict(found: Coverage): {
  text: string;
  tone: "ok" | "warn" | "err";
} {
  if (found.problem !== null) return { text: "could not tell", tone: "warn" };
  if (found.clusterNodes === 0)
    return { text: "no nodes to compare", tone: "warn" };
  if (found.matched === 0) {
    return { text: "watching another cluster", tone: "err" };
  }
  if (found.unseen.length > 0)
    return { text: "watching part of it", tone: "warn" };
  if (found.foreign.length > 0)
    return { text: "watching more than this", tone: "ok" };
  return { text: "watching this cluster", tone: "ok" };
}
