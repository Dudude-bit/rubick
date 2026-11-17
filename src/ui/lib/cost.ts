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
  OwnerReference,
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

/**
 * OpenCost answers and prices none of the nodes: on kind, or a provider it
 * has no price list for, it logs "No pricing found" and writes no node
 * prices while every other series is there.
 */
export const pricesNoNode = (reading: CostReading): boolean =>
  reading.nodes.length === 0;

/** A sum that knows whether it is the whole of what it adds up. */
export interface Amount {
  perHour: number;
  atLeast: boolean;
}

/** A row's total, from the parts it has a price for. */
export interface Priced {
  /** `null` where none of what it holds carries a price. */
  perHour: number | null;
  /** Some of what it holds carries no price: the total is a floor. */
  atLeast: boolean;
  parts: Parts;
  /** What it holds that carries no price, by part. */
  unpriced: CostPart[];
}

export interface NamespaceCost extends Priced {
  namespace: string;
}

export interface WorkloadCost extends Priced {
  key: WorkloadKey;
  pods: number;
  requests: { cpu: number; memory: number };
}

/** The parts a row holds something of, which a price must cover. */
function heldParts(held: {
  pods: number;
  gpus: number;
  storageBytes: number | null;
}): CostPart[] {
  return [
    ...(held.pods > 0 ? (["cpu", "memory"] as const) : []),
    ...(held.gpus > 0 ? (["gpu"] as const) : []),
    ...((held.storageBytes ?? 0) > 0 ? (["storage"] as const) : []),
  ];
}

/**
 * A row out of what it holds and the parts priced: unpriced parts make it a
 * floor, and a row priced in none of them has no total, never 0.
 */
function pricedRow(parts: Parts, held: readonly CostPart[]): Priced {
  const unpriced = held.filter((part) => parts[part] === undefined);
  const any = Object.keys(parts).length > 0;
  return {
    perHour: !any && unpriced.length > 0 ? null : partsTotal(parts),
    atLeast: any && unpriced.length > 0,
    parts,
    unpriced,
  };
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
  /**
   * Paid for and allocated to nobody, the cluster's. `null` where no node
   * carries a price: the nodes' cost is what idle is taken from, and with
   * none of it known there is no idle to state, not an idle of 0.
   */
  idle: { perHour: number; reserved: number | null; atLeast: boolean } | null;
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
  /** Why what each node holds was not counted, where the pods were refused. */
  heldUnread: ReadFailure | null;
  /** Namespaces whose pods could not be read. */
  unread: UnreadNamespace[];
  /** Series for pods not on a node, per namespace. */
  unplaced: Array<{ namespace: string; pods: number; perHour: number }>;
  waiting: number;
  missingLabels: string[];
  /**
   * Nodes the supplier prices that the cluster's node list, read, does not
   * hold: another cluster's in a shared Prometheus. Left out of the totals.
   */
  foreignNodes: string[];
}

export const monthOf = (perHour: number): number => perHour * HOURS_PER_MONTH;

/**
 * The CronJob a Job's cost is billed to: its controller, by the same rule
 * `cost_basis` folds a Job's pods into the CronJob's row.
 */
export const cronJobOf = (
  job: { ownerReferences: readonly OwnerReference[] } | null | undefined
): { group: string; kind: string; name: string } | null => {
  const owner = job?.ownerReferences.find(
    (o) => o.controller === true && o.kind === "CronJob"
  );
  return owner ? { group: "batch", kind: "CronJob", name: owner.name } : null;
};

/** The nodes were read and none of them carries a price. */
export const noNodePriced = (picture: CostPicture): boolean =>
  picture.nodes !== null &&
  picture.nodes.length > 0 &&
  picture.nodes.every((node) => node.perHour === null);

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
): Pick<
  CostPicture,
  "nodesChecked" | "nodesUnread" | "heldUnread" | "unread" | "waiting"
> {
  return {
    nodesChecked: basis.nodes !== null,
    nodesUnread: basis.nodesUnread,
    heldUnread: basis.heldUnread,
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
      namespaces.some((n) => n.perHour === null || n.atLeast),
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
    const allocated =
      node.cpuRequested === null || node.memoryRequested === null
        ? null
        : partsTotal(
            priceOf(prices, {
              cpu: node.cpuRequested,
              memory: node.memoryRequested,
              gpus: node.gpusRequested ?? 0,
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
      idle: allocated === null ? null : perHour - allocated,
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
      return { namespace: n.namespace, ...pricedRow(parts, heldParts(n)) };
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
    // Idle needs what every priced node holds: one uncounted is no total.
    idle:
      nodes &&
      nodes.some((n) => n.perHour !== null) &&
      nodes.every((n) => n.perHour === null || n.idle !== null)
        ? {
            perHour: sum(nodes.map((n) => n.idle)),
            reserved: nodes.some(
              (n) => n.perHour !== null && n.reserved === null
            )
              ? null
              : sum(nodes.map((n) => n.reserved)),
            atLeast: unpriced.nodes.length > 0,
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
    foreignNodes: [],
  };
}

function estimateWorkload(w: WorkloadBasis, prices: Prices): WorkloadCost {
  return {
    key: w.key,
    pods: w.pods,
    ...pricedRow(
      priceOf(prices, w),
      heldParts({ ...w, storageBytes: w.claimBytes })
    ),
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
  // A shared Prometheus prices other clusters' nodes too; where this one's
  // list was read, only its own count.
  const listed = basis.nodes && new Set(basis.nodes.map((n) => n.name));
  const ours = listed
    ? reading.nodes.filter((n) => listed.has(n.name))
    : reading.nodes;
  const priced = new Map(ours.map((n) => [n.name, n]));
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
    ...ours.map((n) => n.name),
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

  const atLeast =
    unpriced.nodes.length > 0 ||
    unpriced.volumes.length > 0 ||
    unpriced.unsized.length > 0 ||
    unpriced.storage !== null;
  // Without the cluster's own node list nothing says which priced nodes are
  // this cluster's, or that none of its nodes went unpriced: no total.
  const cluster: Amount | null =
    basis.nodes === null
      ? null
      : {
          perHour:
            sum(ours.map((n) => n.perHour)) +
            (reading.storage.total ?? 0) +
            (reading.fee ?? 0) +
            (reading.loadBalancers ?? 0),
          atLeast,
        };

  // Every namespace the cluster runs something in, priced or not: one
  // nothing priced is a row that says so, not a row left out.
  const held = new Map(basis.namespaces.map((n) => [n.namespace, n]));
  const namespaces = [
    ...new Set([...Object.keys(reading.namespaces), ...held.keys()]),
  ]
    .filter((namespace) => inScope(scope, namespace))
    .sort((a, b) => a.localeCompare(b))
    .map((namespace): NamespaceCost => ({
      namespace,
      ...pricedRow(
        reading.namespaces[namespace] ?? {},
        heldParts(held.get(namespace) ?? { pods: 0, gpus: 0, storageBytes: 0 })
      ),
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
      // A failed read priced nothing it could vouch for: no total at all.
      ...(fold
        ? pricedRow(parts, heldParts({ ...w, storageBytes: w.claimBytes }))
        : { perHour: null, atLeast: false, parts, unpriced: [] }),
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
    total: scopeTotal(basis, scope, cluster, namespaces, atLeast),
    idle:
      cluster && withNodes && nodes.some((n) => n.perHour !== null)
        ? {
            perHour: sum(nodes.map((n) => n.idle)),
            reserved: null,
            atLeast: unpriced.nodes.length > 0,
          }
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
    foreignNodes: listed
      ? reading.nodes.filter((n) => !listed.has(n.name)).map((n) => n.name)
      : [],
  };
}

export type CostTarget =
  | { namespace: string }
  | { namespace: string; group: string; kind: string; name: string };

export interface CostOf {
  perHour: number | null;
  /** Its own total is a floor: some of what it holds carries no price. */
  partial: boolean;
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
    partial: row.atLeast,
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
