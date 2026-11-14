/**
 * What the cluster costs, read from OpenCost's series in this Prometheus.
 * Kubecost's cost model writes the same names into its own.
 *
 * Names, labels and units are OpenCost's `pkg/costmodel/metrics.go`:
 * `node_cpu_hourly_cost` per vCPU-hour, `node_ram_hourly_cost` per
 * GiB-hour, `node_gpu_hourly_cost` per device-hour, `node_total_hourly_cost`
 * per node-hour; `pv_hourly_cost` per GiB-hour (`allocation_helpers.go`
 * reads it as `CostPerGiBHour`); `container_*_allocation` the larger of
 * request and use, for running containers only. No series names a
 * currency.
 *
 * Every selector reads a label under its own name or as `exported_*`: a
 * scrape without `honor_labels` renames the metric's `namespace`, `pod` and
 * `node` when the target carries its own.
 *
 * A workload's numbers are per pod here and added up per workload in Rust
 * (`prometheus_by_workload`), by the rule the pod list names a pod's
 * workload with, so ten thousand pods never cross IPC.
 */
import { commands } from "@/lib/commands";
import { errorToShow } from "@/lib/error-utils";
import type { PromSeries, WorkloadFold, WorkloadKey } from "@/generated/types";
import { GIB, HOURS_PER_MONTH, WORKLOAD_PARTS } from "@/lib/cost";
import type { CostPart, CostReading, Parts, Prices } from "@/lib/cost";
import { USAGE_QUERIES } from "@/lib/efficiency";
import type { CostRange, CostTrend, DeclaredPoint } from "../registry";
import { RANGE_WINDOW_MS } from "../registry";
import { RANGE_SPECS, escapeLabel, escapeRegex } from "./queries";

const RENAMED = ["namespace", "pod", "node"] as const;

/** The series' own labels back, wherever a scrape renamed them. */
export function own(expression: string): string {
  return RENAMED.reduce(
    (inner, label) =>
      `label_replace(${inner}, "${label}", "$1", "exported_${label}", "(.+)")`,
    expression
  );
}

function namesPattern(namespaces: readonly string[]): string {
  return `"${escapeLabel(`^(${namespaces.map(escapeRegex).join("|")})$`)}"`;
}

/** A metric in the scope's namespaces, under whichever label it arrived. */
export function inNamespaces(
  metric: string,
  namespaces: readonly string[] | null,
  matchers = ""
): string {
  if (namespaces === null)
    return own(matchers ? `${metric}{${matchers}}` : metric);
  const names = namesPattern(namespaces);
  const more = matchers ? `,${matchers}` : "";
  return `(${own(`${metric}{exported_namespace=~${names}${more}}`)} or ${own(
    `${metric}{exported_namespace="",namespace=~${names}${more}}`
  )})`;
}

const price = (metric: string) => `max by (node) (${own(metric)})`;

const ALLOCATION: Record<
  "cpu" | "memory" | "gpu",
  { metric: string; scale: string; price: string }
> = {
  cpu: {
    metric: "container_cpu_allocation",
    scale: "",
    price: "node_cpu_hourly_cost",
  },
  memory: {
    metric: "container_memory_allocation_bytes",
    scale: ` / ${GIB}`,
    price: "node_ram_hourly_cost",
  },
  gpu: {
    metric: "container_gpu_allocation",
    scale: "",
    price: "node_gpu_hourly_cost",
  },
};

/**
 * Each container's allocation at its node's price, per hour. `max by`
 * first, because a cost model scraped by two jobs answers twice.
 */
export function allocationCost(
  resource: keyof typeof ALLOCATION,
  namespaces: readonly string[] | null
): string {
  const { metric, scale, price: rate } = ALLOCATION[resource];
  return `max by (namespace, pod, container, node) (${inNamespaces(metric, namespaces)})${scale} * on (node) group_left () ${price(rate)}`;
}

/** Each volume's price for its size, per hour. */
const VOLUME_COST = `(max by (persistentvolume) (pv_hourly_cost) * on (persistentvolume) max by (persistentvolume) (kube_persistentvolume_capacity_bytes) / ${GIB})`;

function claimedIn(namespaces: readonly string[] | null): string {
  const selector =
    namespaces === null
      ? "kube_persistentvolume_claim_ref"
      : `kube_persistentvolume_claim_ref{claim_namespace=~${namesPattern(namespaces)}}`;
  return `max by (persistentvolume, namespace) (label_replace(${selector}, "namespace", "$1", "claim_namespace", "(.+)"))`;
}

const tagged = (expression: string, label: string, value: string) =>
  `label_replace(${expression}, "${label}", "${value}", "", "")`;

/** What the scope's namespaces spend, one series per part. */
export function scopeParts(namespaces: readonly string[] | null): string {
  return [
    tagged(allocationCost("cpu", namespaces), "part", "cpu"),
    tagged(allocationCost("memory", namespaces), "part", "memory"),
    tagged(allocationCost("gpu", namespaces), "part", "gpu"),
    tagged(
      `${VOLUME_COST} * on (persistentvolume) group_left (namespace) ${claimedIn(namespaces)}`,
      "part",
      "storage"
    ),
    tagged(
      `max by (namespace, service_name) (${inNamespaces("kubecost_load_balancer_cost", namespaces)})`,
      "part",
      "loadBalancer"
    ),
  ].join(" or ");
}

/** What the cluster is billed: its nodes, volumes, fee and load balancers. */
export function clusterParts(): string {
  return [
    tagged(`max by (node) (${own("node_total_hourly_cost")})`, "part", "nodes"),
    tagged(VOLUME_COST, "part", "storage"),
    tagged(
      `max by (provisioner_name) (${own("kubecost_cluster_management_cost")})`,
      "part",
      "fee"
    ),
    tagged(
      `max by (namespace, service_name) (${own("kubecost_load_balancer_cost")})`,
      "part",
      "loadBalancer"
    ),
  ].join(" or ");
}

export function namespacesQuery(namespaces: readonly string[] | null): string {
  return `sum by (namespace, part) (${scopeParts(namespaces)})`;
}

export const NODES_QUERY = `max by (node, instance_type) (${own("node_total_hourly_cost")})`;
export const SPOT_QUERY = `max by (node) (${own("kubecost_node_is_spot")})`;

export const BY_NODE_QUERY = `sum by (node) (${[
  tagged(allocationCost("cpu", null), "part", "cpu"),
  tagged(allocationCost("memory", null), "part", "memory"),
  tagged(allocationCost("gpu", null), "part", "gpu"),
].join(" or ")})`;

export const TOTALS_QUERY = [
  tagged(`sum(${VOLUME_COST})`, "part", "storage"),
  tagged(
    `sum(${VOLUME_COST} unless on (persistentvolume) ${claimedIn(null)})`,
    "part",
    "unclaimed"
  ),
  tagged(
    `sum(max by (provisioner_name) (${own("kubecost_cluster_management_cost")}))`,
    "part",
    "fee"
  ),
  tagged(
    `sum(max by (namespace, service_name) (${own("kubecost_load_balancer_cost")}))`,
    "part",
    "loadBalancers"
  ),
  tagged(
    "count(max by (persistentvolume) (pv_hourly_cost))",
    "part",
    "pricedVolumes"
  ),
].join(" or ");

export const VOLUMES_QUERY = [
  tagged(
    "max by (persistentvolume) (kube_persistentvolume_capacity_bytes) unless on (persistentvolume) pv_hourly_cost",
    "why",
    "unpriced"
  ),
  tagged(
    "max by (persistentvolume) (pv_hourly_cost) unless on (persistentvolume) kube_persistentvolume_capacity_bytes",
    "why",
    "unsized"
  ),
].join(" or ");

/** The cost series by name only, asked when the node prices came back empty. */
export const PRESENCE_QUERY =
  'count by (__name__) ({__name__=~"node_total_hourly_cost|node_cpu_hourly_cost|container_cpu_allocation|container_memory_allocation_bytes|pv_hourly_cost"})';

/** Per pod, in {@link WORKLOAD_PARTS} order. */
export function workloadQueries(
  namespaces: readonly string[] | null
): string[] {
  const perPod = (expression: string) =>
    `sum by (namespace, pod) (${expression})`;
  const queries: Record<(typeof WORKLOAD_PARTS)[number], string> = {
    cpu: perPod(allocationCost("cpu", namespaces)),
    memory: perPod(allocationCost("memory", namespaces)),
    gpu: perPod(allocationCost("gpu", namespaces)),
    storage: perPod(
      `max by (namespace, pod, persistentvolume) (${inNamespaces("pod_pvc_allocation", namespaces)}) / ${GIB} * on (persistentvolume) group_left () max by (persistentvolume) (pv_hourly_cost)`
    ),
  };
  return WORKLOAD_PARTS.map((part) => queries[part]);
}

const value = (series: PromSeries): number | null =>
  series.points[series.points.length - 1]?.v ?? null;

function isPart(part: string): part is CostPart {
  return (
    part === "cpu" ||
    part === "memory" ||
    part === "gpu" ||
    part === "storage" ||
    part === "loadBalancer"
  );
}

/** One instant query's series, by the label that tells them apart. */
function byLabel(series: PromSeries[], label: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const one of series) {
    const v = value(one);
    if (v !== null) out.set(one.labels[label] ?? "", v);
  }
  return out;
}

/**
 * What the cluster costs now. `null` where the Prometheus answered and
 * holds none of the cost series by name.
 */
export async function costNow(input: {
  namespaces: string[] | null;
  keys: WorkloadKey[];
  nodes: boolean;
}): Promise<CostReading | null> {
  const query = (q: string) => commands.prometheusQuery(q);
  const [nodes, namespaces, totals, volumes, spot, byNode, workloads] =
    await Promise.all([
      query(NODES_QUERY),
      query(namespacesQuery(input.namespaces)),
      query(TOTALS_QUERY),
      query(VOLUMES_QUERY),
      input.nodes ? query(SPOT_QUERY) : Promise.resolve(null),
      input.nodes ? query(BY_NODE_QUERY) : Promise.resolve(null),
      // Apart, because the per-pod queries are the heaviest here: a page
      // whose workloads timed out still has its totals to say.
      commands
        .prometheusByWorkload(
          workloadQueries(input.namespaces),
          input.namespaces,
          input.keys
        )
        .catch((error: unknown) => ({ failed: errorToShow(error) })),
    ]);

  if (nodes.length === 0) {
    const present = await query(PRESENCE_QUERY);
    if (present.length === 0) return null;
  }

  const missingLabels = new Set<string>();
  const spotOf = spot && byLabel(spot, "node");
  const priced: CostReading["nodes"] = [];
  for (const series of nodes) {
    const name = series.labels["node"] ?? "";
    const v = value(series);
    if (!name) {
      missingLabels.add("node");
      continue;
    }
    if (v === null || priced.some((n) => n.name === name)) continue;
    priced.push({
      name,
      perHour: v,
      instanceType: series.labels["instance_type"] || null,
      spot: spotOf ? (spotOf.has(name) ? spotOf.get(name)! > 0 : null) : null,
    });
  }

  const perNamespace: Record<string, Parts> = {};
  for (const series of namespaces) {
    const namespace = series.labels["namespace"] ?? "";
    const part = series.labels["part"] ?? "";
    const v = value(series);
    if (!namespace) {
      missingLabels.add("namespace");
      continue;
    }
    if (v === null || !isPart(part)) continue;
    (perNamespace[namespace] ??= {})[part] = v;
  }
  if (!("failed" in workloads) && workloads.unlabelled > 0) {
    missingLabels.add("namespace");
    missingLabels.add("pod");
  }

  const total = byLabel(totals, "part");
  const storage = total.get("storage") ?? null;
  const pricedVolumes = (total.get("pricedVolumes") ?? 0) > 0;
  const why = (reason: string) =>
    volumes
      .filter((s) => s.labels["why"] === reason && s.labels["persistentvolume"])
      .map((s) => s.labels["persistentvolume"]!)
      .sort();

  return {
    nodes: priced.sort((a, b) => a.name.localeCompare(b.name)),
    allocatedByNode: byNode
      ? Object.fromEntries(
          [...byLabel(byNode, "node")].filter(([name]) => name !== "")
        )
      : null,
    namespaces: perNamespace,
    workloads,
    storage: {
      total: storage,
      unclaimed: storage === null ? null : (total.get("unclaimed") ?? 0),
      priced: pricedVolumes,
      unpriced: pricedVolumes ? why("unpriced") : [],
      unsized: why("unsized"),
    },
    fee: total.get("fee") ?? null,
    loadBalancers: total.get("loadBalancers") ?? null,
    missingLabels: [...missingLabels].sort(),
  };
}

const number = (n: number) => (Number.isFinite(n) && n >= 0 ? String(n) : "0");

/** What the cluster held, at the reader's prices, from kube-state-metrics. */
export function estimateTrendQuery(
  namespaces: readonly string[] | null,
  prices: Prices
): string {
  const parts: string[] = [];
  const perGibHour =
    prices.storage === null ? null : prices.storage / HOURS_PER_MONTH;
  if (namespaces === null) {
    const capacity = (resource: string) =>
      `max by (node, resource) (kube_node_status_capacity{resource=${resource}})`;
    parts.push(
      tagged(`${capacity('"cpu"')} * ${number(prices.cpu)}`, "part", "cpu"),
      tagged(
        `${capacity('"memory"')} / ${GIB} * ${number(prices.memory)}`,
        "part",
        "memory"
      )
    );
    if (prices.gpu !== null)
      parts.push(
        tagged(
          `${capacity('~".+_gpu"')} * ${number(prices.gpu)}`,
          "part",
          "gpu"
        )
      );
    if (perGibHour !== null)
      parts.push(
        tagged(
          `max by (persistentvolume) (kube_persistentvolume_capacity_bytes) / ${GIB} * ${number(perGibHour)}`,
          "part",
          "storage"
        )
      );
  } else {
    const names = namesPattern(namespaces);
    const held = (resource: string) =>
      `max by (namespace, pod, container) (kube_pod_container_resource_requests{resource=${resource},node!="",namespace=~${names}}) and on (namespace, pod) (max by (namespace, pod) (kube_pod_status_phase{phase=~"Pending|Running",namespace=~${names}}) == 1)`;
    parts.push(
      tagged(`(${held('"cpu"')}) * ${number(prices.cpu)}`, "part", "cpu"),
      tagged(
        `(${held('"memory"')}) / ${GIB} * ${number(prices.memory)}`,
        "part",
        "memory"
      )
    );
    if (prices.gpu !== null)
      parts.push(
        tagged(`(${held('~".+_gpu"')}) * ${number(prices.gpu)}`, "part", "gpu")
      );
    if (perGibHour !== null)
      parts.push(
        tagged(
          `max by (persistentvolume) (kube_persistentvolume_capacity_bytes) * on (persistentvolume) group_left (namespace) ${claimedIn(namespaces)} / ${GIB} * ${number(perGibHour)}`,
          "part",
          "storage"
        )
      );
  }
  return `sum(${parts.join(" or ")})`;
}

export function trendQuery(
  namespaces: readonly string[] | null,
  prices: Prices | null
): string {
  if (prices) return estimateTrendQuery(namespaces, prices);
  return namespaces === null
    ? `sum(${clusterParts()})`
    : `sum(${scopeParts(namespaces)})`;
}

/** The buckets the trend answered for, a bucket with nothing kept as a gap. */
function pointsOf(series: PromSeries[]): DeclaredPoint[] {
  const at = new Map<number, number | null>();
  for (const one of series)
    for (const point of one.points) {
      // Seconds came back as float milliseconds; a step's key is whole.
      const t = Math.round(point.t);
      const seen = at.get(t);
      if (point.v === null || point.v === undefined) {
        if (seen === undefined) at.set(t, null);
      } else at.set(t, (seen ?? 0) + point.v);
    }
  return [...at.keys()]
    .sort((a, b) => a - b)
    .map((t) => ({ t, v: at.get(t) ?? null }));
}

/**
 * Prometheus leaves a step with no sample out of the answer altogether;
 * every step of the window is put back, empty, so the chart draws the hole.
 */
export function withHoles(
  points: readonly DeclaredPoint[],
  start: number,
  end: number,
  stepMs: number
): DeclaredPoint[] {
  const at = new Map(points.map((p) => [p.t, p.v]));
  const first = points[0]?.t ?? start;
  const out: DeclaredPoint[] = [];
  let t = first - Math.floor((first - start) / stepMs) * stepMs;
  for (; t <= end; t += stepMs) out.push({ t, v: at.get(t) ?? null });
  return out;
}

export async function costHistory(input: {
  namespaces: string[] | null;
  range: CostRange;
  prices: Prices | null;
}): Promise<CostTrend> {
  const spec = RANGE_SPECS[input.range];
  const end = Date.now();
  const start = end - RANGE_WINDOW_MS[input.range];
  const series = await commands.prometheusQueryRange(
    trendQuery(input.namespaces, input.prices),
    start,
    end,
    spec.stepSeconds
  );
  const points = pointsOf(series);
  return {
    points:
      points.length === 0
        ? []
        : withHoles(points, start, end, spec.stepSeconds * 1000),
    stepSeconds: spec.stepSeconds,
  };
}

/** Per pod, in {@link USAGE_QUERIES} order, over the efficiency window. */
export function usageQueries(namespaces: readonly string[] | null): string[] {
  const scope =
    namespaces === null ? "" : `,namespace=~${namesPattern(namespaces)}`;
  const containers = `container!="",container!="POD"${scope}`;
  const cpu = `container_cpu_usage_seconds_total{${containers}}`;
  const memory = `container_memory_working_set_bytes{${containers}}`;
  const queries: Record<(typeof USAGE_QUERIES)[number], string> = {
    cpuAvg: `sum by (namespace, pod) (rate(${cpu}[24h])) * 1000`,
    cpuPeak: `max_over_time((sum by (namespace, pod) (rate(${cpu}[5m])))[24h:5m]) * 1000`,
    memoryAvg: `sum by (namespace, pod) (avg_over_time(${memory}[24h]))`,
    memoryPeak: `max_over_time((sum by (namespace, pod) (${memory}))[24h:5m])`,
  };
  return USAGE_QUERIES.map((name) => queries[name]);
}

export function workloadUsage(input: {
  namespaces: string[] | null;
  keys: WorkloadKey[];
}): Promise<WorkloadFold> {
  return commands.prometheusByWorkload(
    usageQueries(input.namespaces),
    input.namespaces,
    input.keys
  );
}
