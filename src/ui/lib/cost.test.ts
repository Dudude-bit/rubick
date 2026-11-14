import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import type {
  CostBasis,
  NodeBasis,
  WorkloadBasis,
  WorkloadFold,
} from "@/generated/types";
import {
  GIB,
  MAX_COST_ROWS,
  costOf,
  estimatePicture,
  monthOf,
  readingPicture,
  type CostReading,
  type Prices,
} from "./cost";

const prices: Prices = {
  cpu: 0.04,
  memory: 0.005,
  storage: 0.1,
  gpu: null,
  currency: "USD",
};

function node(name: string, extra: Partial<NodeBasis> = {}): NodeBasis {
  return {
    name,
    instanceType: "m5.large",
    cpuCapacity: 2000,
    cpuAllocatable: 1900,
    memoryCapacity: 8 * GIB,
    memoryAllocatable: 7 * GIB,
    gpus: 0,
    cpuRequested: 1000,
    memoryRequested: 2 * GIB,
    gpusRequested: 0,
    ...extra,
  };
}

function workload(name: string, namespace = "shop"): WorkloadBasis {
  return {
    key: { namespace, group: "apps", kind: "Deployment", name },
    pods: 2,
    cpu: 500,
    memory: GIB,
    gpus: 0,
    claimBytes: 0,
  };
}

function basis(extra: Partial<CostBasis> = {}): CostBasis {
  return {
    nodes: [node("node-a")],
    nodesUnread: null,
    namespaces: [
      {
        namespace: "shop",
        workloads: 1,
        pods: 2,
        cpu: 500,
        memory: GIB,
        gpus: 0,
        storageBytes: 0,
      },
    ],
    workloads: [workload("web")],
    rest: null,
    waiting: 0,
    unread: [],
    volumeBytes: 0,
    volumeCount: 0,
    unclaimed: [],
    volumesUnread: null,
    claimsUnread: [],
    servedFrom: "watch",
    ...extra,
  };
}

const fold = (
  values: (number | null)[][],
  rest: (number | null)[] = [null]
): WorkloadFold => ({
  values,
  rest,
  unplaced: [],
  unread: [],
  unlabelled: 0,
});

function reading(extra: Partial<CostReading> = {}): CostReading {
  return {
    nodes: [
      { name: "node-a", perHour: 0.2, instanceType: "m5.large", spot: false },
    ],
    allocatedByNode: { "node-a": 0.05 },
    namespaces: { shop: { cpu: 0.03, memory: 0.02 } },
    workloads: fold([[0.03, 0.02, null, null]]),
    storage: {
      total: null,
      unclaimed: null,
      priced: true,
      unpriced: [],
      unsized: [],
    },
    fee: null,
    loadBalancers: null,
    missingLabels: [],
    ...extra,
  };
}

const opencost = {
  kind: "opencost" as const,
  vendor: "Prometheus",
  endpoint: "prom.example.com",
};

describe("an estimate from entered prices", () => {
  /**
   * The node is billed for its whole capacity; what nobody requested of
   * what the scheduler could hand out is idle, and what the kubelet keeps
   * back is said apart. Fails if any of the three is read off the wrong
   * quantity.
   */
  it("bills each node its capacity and splits idle from what the system keeps", () => {
    const picture = estimatePicture(basis(), prices, null);
    const nodeCost = 2 * 0.04 + 8 * 0.005;
    expect(picture.cluster).toEqual({ perHour: nodeCost, atLeast: false });
    const row = picture.nodes![0]!;
    expect(row.allocated).toBeCloseTo(1 * 0.04 + 2 * 0.005);
    expect(row.reserved).toBeCloseTo(0.1 * 0.04 + 1 * 0.005);
    expect(row.idle).toBeCloseTo(nodeCost - row.allocated!);
    expect(monthOf(1)).toBe(730);
  });

  /** A workload's share follows what its running pods request. */
  it("prices each workload by what its pods request", () => {
    const picture = estimatePicture(basis(), prices, null);
    expect(picture.workloads[0]!.perHour).toBeCloseTo(0.5 * 0.04 + 1 * 0.005);
  });

  /**
   * Storage nobody entered a price for is not free: the total is "at
   * least", and the volumes left out are counted.
   */
  it("calls the total at least, and counts the volumes, where storage has no price", () => {
    const picture = estimatePicture(
      basis({ volumeBytes: 10 * GIB, volumeCount: 3 }),
      { ...prices, storage: null },
      null
    );
    expect(picture.cluster!.atLeast).toBe(true);
    expect(picture.unpriced.storage).toEqual({ volumes: 3, bytes: 10 * GIB });
  });

  /** GPUs with no price are named, not billed at zero. */
  it("names the nodes whose devices have no price", () => {
    const picture = estimatePicture(
      basis({ nodes: [node("gpu-1", { gpus: 1 })] }),
      prices,
      null
    );
    expect(picture.unpriced.gpuNodes).toEqual(["gpu-1"]);
    expect(picture.cluster!.atLeast).toBe(true);
  });

  /** A node that did not state its size is unpriced and named, never a free node. */
  it("names a node with no stated capacity instead of pricing it at zero", () => {
    const picture = estimatePicture(
      basis({ nodes: [node("node-a"), node("odd", { cpuCapacity: null })] }),
      prices,
      null
    );
    expect(picture.unpriced.nodes).toEqual(["odd"]);
    expect(picture.nodes![1]!.perHour).toBeNull();
    expect(picture.cluster!.atLeast).toBe(true);
  });

  /**
   * Nodes nobody could list are not a cluster that costs nothing: there is
   * no cluster total at all, and the idle line is gone with it.
   */
  it("has no cluster total where the nodes could not be read", () => {
    const picture = estimatePicture(
      basis({
        nodes: null,
        nodesUnread: { code: "PERMISSION_DENIED", message: "forbidden" },
      }),
      prices,
      null
    );
    expect(picture.cluster).toBeNull();
    expect(picture.idle).toBeNull();
    expect(picture.nodesChecked).toBe(false);
    expect(picture.workloads[0]!.perHour).not.toBeNull();
  });

  /** Some namespaces of the scope unread: what was read is a floor. */
  it("calls a scope's total at least when some of its namespaces could not be read", () => {
    const picture = estimatePicture(
      basis({
        unread: [{ namespace: "bank", code: "PERMISSION_DENIED", message: "" }],
      }),
      prices,
      ["bank", "shop"]
    );
    expect(picture.total!.atLeast).toBe(true);
    expect(picture.total!.perHour).toBeCloseTo(picture.namespaces[0]!.perHour!);
  });
});

describe("a picture from OpenCost's prices", () => {
  /**
   * A node the cluster has and OpenCost does not price makes the total a
   * floor, and the node is named.
   */
  it("names a node OpenCost does not price and calls the total at least", () => {
    const picture = readingPicture(
      basis({ nodes: [node("node-a"), node("worker-7")] }),
      reading(),
      opencost,
      null
    );
    expect(picture.unpriced.nodes).toEqual(["worker-7"]);
    expect(picture.cluster!.atLeast).toBe(true);
    expect(
      picture.nodes!.find((n) => n.name === "worker-7")!.perHour
    ).toBeNull();
  });

  /** Coverage cannot be checked against nodes nobody could list. */
  it("says the nodes were not checked when they could not be listed", () => {
    const picture = readingPicture(
      basis({ nodes: null }),
      reading(),
      opencost,
      null
    );
    expect(picture.nodesChecked).toBe(false);
    expect(picture.unpriced.nodes).toEqual([]);
  });

  /**
   * A scrape that keeps only node_, kube_, container_ and kubecost_ series
   * drops `pv_hourly_cost`: storage then has no price, not a price of zero.
   */
  it("calls storage unpriced, not free, where no volume carries a price", () => {
    const picture = readingPicture(
      basis({ volumeBytes: 50 * GIB, volumeCount: 4 }),
      reading({
        storage: {
          total: null,
          unclaimed: null,
          priced: false,
          unpriced: [],
          unsized: [],
        },
      }),
      opencost,
      null
    );
    expect(picture.unpriced.storage).toEqual({ volumes: 4, bytes: 50 * GIB });
    expect(picture.cluster!.atLeast).toBe(true);
  });

  /** No series for any of a workload's pods is "not priced", never 0/h. */
  it("leaves a workload no series priced without a cost rather than at zero", () => {
    const picture = readingPicture(
      basis(),
      reading({ workloads: fold([[null, null, null, null]]) }),
      opencost,
      null
    );
    expect(picture.workloads[0]!.perHour).toBeNull();
  });

  /** The per-pod read timing out leaves the totals, and says why the rows have none. */
  it("keeps the totals when the workloads' read failed, and says why", () => {
    const picture = readingPicture(
      basis(),
      reading({ workloads: { failed: "timed out after 20s" } }),
      opencost,
      null
    );
    expect(picture.workloadsFailed).toBe("timed out after 20s");
    expect(picture.workloads[0]!.perHour).toBeNull();
    expect(picture.cluster!.perHour).toBeCloseTo(0.2);
  });

  /** Idle is what the node costs less what OpenCost allocated on it. */
  it("reads idle per node as its price less what was allocated there", () => {
    const picture = readingPicture(basis(), reading(), opencost, null);
    expect(picture.nodes![0]!.idle).toBeCloseTo(0.15);
    expect(picture.idle!.perHour).toBeCloseTo(0.15);
  });

  /** The cut workloads' value is carried, not lost. */
  it("adds up the workloads past the cap", () => {
    const picture = readingPicture(
      basis({
        rest: {
          workloads: 3,
          pods: 6,
          cpu: 1,
          memory: 1,
          gpus: 0,
          claimBytes: 0,
        },
      }),
      reading({ workloads: fold([[0.03, 0.02, null, null]], [0.4]) }),
      opencost,
      null
    );
    expect(picture.rest).toEqual({ workloads: 3, perHour: 0.4 });
  });
});

describe("one object's cost", () => {
  /**
   * The detail pages read their line through this, the page reads the same
   * row: one number, two places. Fails if either reads anything else.
   */
  it("is the picture's own row, with its share of the cluster", () => {
    const picture = readingPicture(basis(), reading(), opencost, null);
    const of = costOf(picture, {
      namespace: "shop",
      group: "apps",
      kind: "Deployment",
      name: "web",
    })!;
    expect(of.perHour).toBe(picture.workloads[0]!.perHour);
    expect(of.share).toBeCloseTo(0.05 / 0.2);
    expect(costOf(picture, { namespace: "shop" })!.perHour).toBeCloseTo(0.05);
    expect(
      costOf(picture, {
        namespace: "shop",
        group: "apps",
        kind: "Deployment",
        name: "gone",
      })
    ).toBeNull();
  });
});

describe("the row cap", () => {
  /** The Rust side reads the same file; a constant edited on one side only is the drift this catches. */
  it("matches src/contracts/cost-budget.json", () => {
    const shared = JSON.parse(
      readFileSync(
        resolve(process.cwd(), "src/contracts/cost-budget.json"),
        "utf8"
      )
    ) as { maxCostRows: number };
    expect(MAX_COST_ROWS).toBe(shared.maxCostRows);
  });
});
