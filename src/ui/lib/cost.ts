/**
 * What the cluster costs, as one picture from either source: OpenCost's
 * prices read from Prometheus, or prices the reader entered applied to what
 * the cluster holds (`cost_basis`). Pure, so the Cost page, a namespace's
 * page and a workload's page all read their numbers through {@link costOf}
 * on a picture built here, and cannot disagree.
 *
 * Units: CPU in millicores, memory and storage in bytes, money per hour.
 * A month is the hourly rate × {@link HOURS_PER_MONTH}, a projection.
 */
import type {
  CostBasis,
  ReadFailure,
  UnreadNamespace,
  WorkloadBasis,
  WorkloadFold,
  WorkloadKey,
} from "@/generated/types";
import { formatAmount, formatPercent } from "@/lib/utils";
import { currentLocale } from "@/stores/localeStore";

/** OpenCost's and Kubecost's own month: 730 hours. */
export const HOURS_PER_MONTH = 730;
export const GIB = 1024 ** 3;
/** The most workload rows one answer carries, as `src/contracts/cost-budget.json` states it; a test on each side holds them equal. */
export const MAX_COST_ROWS = 600;

/**
 * What the reader entered for one cluster. CPU per vCPU-hour, memory per
 * GiB-hour, storage per GiB-month, GPU per device-hour; `null` is "not
 * entered", which leaves that resource unpriced rather than free.
 */
export interface Prices {
  cpu: number;
  memory: number;
  storage: number | null;
  gpu: number | null;
  /** A label, never converted. Empty where none was entered. */
  currency: string;
}

export const COST_PARTS = [
  "cpu",
  "memory",
  "gpu",
  "storage",
  "loadBalancer",
] as const;
export type CostPart = (typeof COST_PARTS)[number];
export type Parts = Partial<Record<CostPart, number>>;

/** The order a supplier's per-pod cost queries answer in. */
export const WORKLOAD_PARTS = ["cpu", "memory", "gpu", "storage"] as const;

/** What a supplier that prices the cluster read, per hour. */
export interface CostReading {
  /** Every node it prices. */
  nodes: Array<{
    name: string;
    perHour: number;
    instanceType: string | null;
    spot: boolean | null;
  }>;
  /** What it allocated on each node; `null` where it was not asked. */
  allocatedByNode: Record<string, number> | null;
  /** Per namespace of the scope, by part. */
  namespaces: Record<string, Parts>;
  /**
   * Positional on the basis's workloads, in {@link WORKLOAD_PARTS} order;
   * or why it could not be read, which leaves the totals standing.
   */
  workloads: WorkloadFold | { failed: string };
  storage: {
    /** Every priced volume; `null` where no volume carries both a price and a size. */
    total: number | null;
    unclaimed: number | null;
    /** Whether any volume carries a price at all. */
    priced: boolean;
    /** Volumes with a size and no price. */
    unpriced: string[];
    /** Volumes with a price and no size. */
    unsized: string[];
  };
  fee: number | null;
  loadBalancers: number | null;
  /** Labels a join needs that some series do not carry. */
  missingLabels: string[];
}

export type CostSource =
  | { kind: "opencost"; vendor: string; endpoint: string }
  | { kind: "estimate"; prices: Prices };

/** A sum that knows whether it is the whole of what it adds up. */
export interface Amount {
  perHour: number;
  atLeast: boolean;
}

export interface NamespaceCost {
  namespace: string;
  /** `null` where nothing of it could be priced. */
  perHour: number | null;
  parts: Parts;
}

export interface WorkloadCost {
  key: WorkloadKey;
  pods: number;
  /** `null` where no series priced any of its pods. */
  perHour: number | null;
  parts: Parts;
  requests: { cpu: number; memory: number };
}

export interface NodeCost {
  name: string;
  instanceType: string | null;
  spot: boolean | null;
  /** `null` for a node nothing prices. */
  perHour: number | null;
  allocated: number | null;
  idle: number | null;
  /** What the kubelet and the system keep back, where it is known. */
  reserved: number | null;
}

export interface Unpriced {
  nodes: string[];
  /** Nodes whose devices have no price, though the rest of them does. */
  gpuNodes: string[];
  volumes: string[];
  unsized: string[];
  /** Volumes nothing prices at all: the source has no storage price. */
  storage: { volumes: number; bytes: number } | null;
}

export interface CostPicture {
  source: CostSource;
  /** The whole cluster; `null` where its nodes could not be read. */
  cluster: Amount | null;
  /** The scope: the cluster, or the namespaces in it. */
  total: Amount | null;
  /** Paid for and allocated to nobody, the cluster's. */
  idle: { perHour: number; reserved: number | null } | null;
  namespaces: NamespaceCost[];
  workloads: WorkloadCost[];
  /** Workloads past the cap, added up. */
  rest: { workloads: number; perHour: number | null } | null;
  /** Why no workload has a cost, where its read failed and the totals did not. */
  workloadsFailed: string | null;
  nodes: NodeCost[] | null;
  unclaimed: number | null;
  fee: number | null;
  unpriced: Unpriced;
  /** Whether every node could be checked for a price. */
  nodesChecked: boolean;
  nodesUnread: ReadFailure | null;
  /** Namespaces whose pods could not be read. */
  unread: UnreadNamespace[];
  /** Series for pods not on a node, per namespace. */
  unplaced: Array<{ namespace: string; pods: number; perHour: number }>;
  waiting: number;
  missingLabels: string[];
}

export const monthOf = (perHour: number): number => perHour * HOURS_PER_MONTH;

function sum(values: Iterable<number | null | undefined>): number {
  let total = 0;
  for (const value of values) total += value ?? 0;
  return total;
}

const partsTotal = (parts: Parts): number => sum(Object.values(parts));

function inScope(scope: readonly string[] | null, namespace: string): boolean {
  return scope === null || scope.includes(namespace);
}

/** Priced from the reader's own figures. */
function priceOf(
  prices: Prices,
  held: {
    cpu: number;
    memory: number;
    gpus: number;
    claimBytes?: number;
  }
): Parts {
  const parts: Parts = {
    cpu: (held.cpu / 1000) * prices.cpu,
    memory: (held.memory / GIB) * prices.memory,
  };
  if (held.gpus > 0 && prices.gpu !== null) parts.gpu = held.gpus * prices.gpu;
  if ((held.claimBytes ?? 0) > 0 && prices.storage !== null)
    parts.storage = storagePerHour(held.claimBytes!, prices.storage);
  return parts;
}

const storagePerHour = (bytes: number, perGibMonth: number): number =>
  ((bytes / GIB) * perGibMonth) / HOURS_PER_MONTH;

function unread(
  basis: CostBasis
): Pick<CostPicture, "nodesChecked" | "nodesUnread" | "unread" | "waiting"> {
  return {
    nodesChecked: basis.nodes !== null,
    nodesUnread: basis.nodesUnread,
    unread: basis.unread,
    waiting: basis.waiting,
  };
}

/** What is left of the scope when some of it could not be read. */
function scopeTotal(
  basis: CostBasis,
  scope: readonly string[] | null,
  cluster: Amount | null,
  namespaces: NamespaceCost[],
  partial: boolean
): Amount | null {
  if (scope === null) return cluster;
  return {
    perHour: sum(namespaces.map((n) => n.perHour)),
    atLeast:
      partial ||
      basis.unread.length > 0 ||
      namespaces.some((n) => n.perHour === null),
  };
}

/** The cluster as the reader's prices make it. */
export function estimatePicture(
  basis: CostBasis,
  prices: Prices,
  scope: readonly string[] | null
): CostPicture {
  const unpriced: Unpriced = {
    nodes: [],
    gpuNodes: [],
    volumes: [],
    unsized: [],
    storage: null,
  };
  const nodes = basis.nodes?.map((node): NodeCost => {
    const base = {
      name: node.name,
      instanceType: node.instanceType,
      spot: null,
    };
    if (node.cpuCapacity === null || node.memoryCapacity === null) {
      unpriced.nodes.push(node.name);
      return {
        ...base,
        perHour: null,
        allocated: null,
        idle: null,
        reserved: null,
      };
    }
    if (node.gpus > 0 && prices.gpu === null) unpriced.gpuNodes.push(node.name);
    const perHour = partsTotal(
      priceOf(prices, {
        cpu: node.cpuCapacity,
        memory: node.memoryCapacity,
        gpus: node.gpus,
      })
    );
    const allocated = partsTotal(
      priceOf(prices, {
        cpu: node.cpuRequested,
        memory: node.memoryRequested,
        gpus: node.gpusRequested,
      })
    );
    const reserved =
      node.cpuAllocatable === null || node.memoryAllocatable === null
        ? null
        : partsTotal(
            priceOf(prices, {
              cpu: node.cpuCapacity - node.cpuAllocatable,
              memory: node.memoryCapacity - node.memoryAllocatable,
              gpus: 0,
            })
          );
    return {
      ...base,
      perHour,
      allocated,
      idle: perHour - allocated,
      reserved,
    };
  });

  const volumeBytes = basis.volumeBytes;
  if (prices.storage === null && volumeBytes !== null && volumeBytes > 0)
    unpriced.storage = { volumes: basis.volumeCount ?? 0, bytes: volumeBytes };
  const storage =
    prices.storage === null || volumeBytes === null
      ? null
      : storagePerHour(volumeBytes, prices.storage);
  const unclaimedBytes =
    basis.unclaimed === null ? null : sum(basis.unclaimed.map((v) => v.bytes));
  const unclaimed =
    prices.storage === null || unclaimedBytes === null
      ? null
      : storagePerHour(unclaimedBytes, prices.storage);

  const cluster: Amount | null = nodes
    ? {
        perHour: sum(nodes.map((n) => n.perHour)) + (storage ?? 0),
        atLeast:
          unpriced.nodes.length > 0 ||
          unpriced.gpuNodes.length > 0 ||
          unpriced.storage !== null ||
          volumeBytes === null,
      }
    : null;

  const namespaces = basis.namespaces
    .filter((n) => inScope(scope, n.namespace))
    .map((n): NamespaceCost => {
      const parts = priceOf(prices, {
        cpu: n.cpu,
        memory: n.memory,
        gpus: n.gpus,
      });
      if (n.storageBytes !== null && prices.storage !== null)
        parts.storage = storagePerHour(n.storageBytes, prices.storage);
      return { namespace: n.namespace, perHour: partsTotal(parts), parts };
    });

  const workloads = basis.workloads.map((w): WorkloadCost =>
    estimateWorkload(w, prices)
  );
  const rest = basis.rest && {
    workloads: basis.rest.workloads,
    perHour: partsTotal(priceOf(prices, basis.rest)),
  };
  const partial =
    unpriced.gpuNodes.length > 0 ||
    (prices.storage === null &&
      basis.namespaces.some((n) => (n.storageBytes ?? 0) > 0)) ||
    basis.namespaces.some((n) => n.storageBytes === null);

  return {
    source: { kind: "estimate", prices },
    cluster,
    total: scopeTotal(basis, scope, cluster, namespaces, partial),
    idle: nodes
      ? {
          perHour: sum(nodes.map((n) => n.idle)),
          reserved: nodes.some((n) => n.perHour !== null && n.reserved === null)
            ? null
            : sum(nodes.map((n) => n.reserved)),
        }
      : null,
    namespaces,
    workloads,
    rest,
    workloadsFailed: null,
    nodes: nodes ?? null,
    unclaimed,
    fee: null,
    unpriced,
    ...unread(basis),
    unplaced: [],
    missingLabels: [],
  };
}

function estimateWorkload(w: WorkloadBasis, prices: Prices): WorkloadCost {
  const parts = priceOf(prices, w);
  return {
    key: w.key,
    pods: w.pods,
    perHour: partsTotal(parts),
    parts,
    requests: { cpu: w.cpu, memory: w.memory },
  };
}

function valuesTotal(values: readonly (number | null)[]): number | null {
  return values.every((v) => v === null) ? null : sum(values);
}

/** The cluster as a supplier that prices it reads it. */
export function readingPicture(
  basis: CostBasis,
  reading: CostReading,
  source: Extract<CostSource, { kind: "opencost" }>,
  scope: readonly string[] | null
): CostPicture {
  const priced = new Map(reading.nodes.map((n) => [n.name, n]));
  const unpriced: Unpriced = {
    nodes: [],
    gpuNodes: [],
    volumes: reading.storage.unpriced,
    unsized: reading.storage.unsized,
    storage:
      !reading.storage.priced && (basis.volumeBytes ?? 0) > 0
        ? { volumes: basis.volumeCount ?? 0, bytes: basis.volumeBytes ?? 0 }
        : null,
  };
  for (const node of basis.nodes ?? [])
    if (!priced.has(node.name)) unpriced.nodes.push(node.name);

  const names = new Set([
    ...reading.nodes.map((n) => n.name),
    ...(basis.nodes ?? []).map((n) => n.name),
  ]);
  const types = new Map(
    (basis.nodes ?? []).map((n) => [n.name, n.instanceType])
  );
  const nodes = [...names].sort().map((name): NodeCost => {
    const price = priced.get(name);
    const allocated = reading.allocatedByNode
      ? (reading.allocatedByNode[name] ?? 0)
      : null;
    const perHour = price?.perHour ?? null;
    return {
      name,
      instanceType: price?.instanceType ?? types.get(name) ?? null,
      spot: price?.spot ?? null,
      perHour,
      allocated: perHour === null ? null : allocated,
      idle: perHour === null || allocated === null ? null : perHour - allocated,
      reserved: null,
    };
  });

  const cluster: Amount = {
    perHour:
      sum(reading.nodes.map((n) => n.perHour)) +
      (reading.storage.total ?? 0) +
      (reading.fee ?? 0) +
      (reading.loadBalancers ?? 0),
    atLeast:
      unpriced.nodes.length > 0 ||
      unpriced.volumes.length > 0 ||
      unpriced.unsized.length > 0 ||
      unpriced.storage !== null,
  };

  const namespaces = Object.entries(reading.namespaces)
    .filter(([namespace]) => inScope(scope, namespace))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([namespace, parts]): NamespaceCost => ({
      namespace,
      perHour: partsTotal(parts),
      parts,
    }));

  const fold = "failed" in reading.workloads ? null : reading.workloads;
  const workloads = basis.workloads.map((w, i): WorkloadCost => {
    const values = fold?.values[i] ?? [null];
    const parts: Parts = {};
    WORKLOAD_PARTS.forEach((part, at) => {
      const value = values[at];
      if (value !== null && value !== undefined) parts[part] = value;
    });
    return {
      key: w.key,
      pods: w.pods,
      perHour: valuesTotal(values),
      parts,
      requests: { cpu: w.cpu, memory: w.memory },
    };
  });
  const rest = basis.rest && {
    workloads: basis.rest.workloads,
    perHour: fold ? valuesTotal(fold.rest) : null,
  };
  const withNodes = reading.allocatedByNode !== null;

  return {
    source,
    cluster,
    total: scopeTotal(basis, scope, cluster, namespaces, cluster.atLeast),
    idle: withNodes
      ? { perHour: sum(nodes.map((n) => n.idle)), reserved: null }
      : null,
    namespaces,
    workloads,
    rest,
    workloadsFailed:
      "failed" in reading.workloads ? reading.workloads.failed : null,
    nodes: withNodes ? nodes : null,
    unclaimed: reading.storage.unclaimed,
    fee: reading.fee,
    unpriced,
    ...unread(basis),
    unplaced: (fold?.unplaced ?? []).map((u) => ({
      namespace: u.namespace,
      pods: u.pods,
      perHour: sum(u.values),
    })),
    missingLabels: reading.missingLabels,
  };
}

export type CostTarget =
  | { namespace: string }
  | { namespace: string; group: string; kind: string; name: string };

export interface CostOf {
  perHour: number | null;
  /** Of the whole cluster, where both are known. */
  share: number | null;
  atLeast: boolean;
}

/** One workload: a custom kind may share a built-in's name, so the group counts too. */
export const sameKey = (a: WorkloadKey, b: WorkloadKey): boolean =>
  a.namespace === b.namespace &&
  a.group === b.group &&
  a.kind === b.kind &&
  a.name === b.name;

/**
 * One namespace's or one workload's cost, read off a picture. The page's
 * rows and the detail pages' lines both come through here.
 *
 * `null` where the picture does not hold it: a workload with no pod on a
 * node, or one past the cap.
 */
export function costOf(
  picture: CostPicture,
  target: CostTarget
): CostOf | null {
  const row =
    "kind" in target
      ? picture.workloads.find((w) => sameKey(w.key, target))
      : picture.namespaces.find((n) => n.namespace === target.namespace);
  if (!row) return null;
  const cluster = picture.cluster;
  return {
    perHour: row.perHour,
    share:
      row.perHour === null || !cluster || cluster.perHour <= 0
        ? null
        : row.perHour / cluster.perHour,
    atLeast: cluster?.atLeast ?? true,
  };
}

/**
 * An amount as the reader's language writes numbers, with the entered
 * currency as a label after it and never converted.
 */
export function formatMoney(
  value: number,
  currency: string,
  locale: string = currentLocale()
): string {
  const text = formatAmount(value, locale);
  return currency ? `${text}\u00a0${currency}` : text;
}

/** A share of a whole, to a tenth of a per cent below ten. */
export function formatShare(
  ratio: number,
  locale: string = currentLocale()
): string {
  return formatPercent(ratio, ratio < 0.1 ? 1 : 0, locale);
}

/** The currency an amount is written in: the entered label, or none for OpenCost's. */
export function currencyOf(picture: CostPicture): string {
  return picture.source.kind === "estimate"
    ? picture.source.prices.currency
    : "";
}
