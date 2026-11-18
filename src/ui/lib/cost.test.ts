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
  HOURS_PER_MONTH,
  MAX_COST_ROWS,
  costOf,
  cronJobOf,
  estimatePicture,
  monthOf,
  noNodePriced,
  pricesNoNode,
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
    heldUnread: null,
    jobsUnread: null,
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
    unclaimed: { count: 0, bytes: 0 },
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
  covered: [],
  pods: values.map(() => 2),
  since: values.map(() => null),
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

  /**
   * A page about one object does not count what each node holds; idle is
   * then unknown, not the whole node's price.
   */
  it("has no idle where what the nodes hold was not counted", () => {
    const picture = estimatePicture(
      basis({
        nodes: [
          node("node-a", {
            cpuRequested: null,
            memoryRequested: null,
            gpusRequested: null,
          }),
        ],
      }),
      prices,
      null
    );
    expect(picture.idle).toBeNull();
    expect(picture.nodes![0]!.allocated).toBeNull();
    expect(picture.cluster!.perHour).toBeCloseTo(2 * 0.04 + 8 * 0.005);
  });

  /**
   * A row's total from parts some of which carry no price is a floor, and
   * one with none priced has no total: the rows printed 0 while their parts
   * read "not priced".
   */
  it("makes a row a floor where a part it holds has no price", () => {
    const picture = estimatePicture(
      basis({
        namespaces: [
          {
            namespace: "shop",
            workloads: 1,
            pods: 2,
            cpu: 500,
            memory: GIB,
            gpus: 0,
            storageBytes: 10 * GIB,
          },
        ],
      }),
      { ...prices, storage: null },
      ["shop"]
    );
    expect(picture.namespaces[0]).toMatchObject({
      atLeast: true,
      unpriced: ["storage"],
    });
    expect(picture.total!.atLeast).toBe(true);
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

  /**
   * Without the cluster's node list nothing says which priced nodes are its
   * own, or that none went unpriced: OpenCost's sum was shown as the
   * cluster's total, exact. There is no total and no idle, as with entered
   * prices; a scope's namespaces still add up. Fails if a total is made of
   * nodes nobody could list.
   */
  it("has no cluster total or idle where the nodes could not be listed", () => {
    const unlisted = basis({ nodes: null });
    const picture = readingPicture(unlisted, reading(), opencost, null);
    expect(picture.nodesChecked).toBe(false);
    expect(picture.cluster).toBeNull();
    expect(picture.total).toBeNull();
    expect(picture.idle).toBeNull();
    const shop = readingPicture(unlisted, reading(), opencost, ["shop"]);
    expect(shop.total?.perHour).toBeCloseTo(0.05);
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

  /**
   * OpenCost with no node prices prices no CPU or memory: a namespace that
   * runs pods has no total, and one OpenCost never named is still a row.
   */
  it("has no total for a namespace whose CPU and memory carry no price", () => {
    const picture = readingPicture(
      basis({
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
          {
            namespace: "bank",
            workloads: 1,
            pods: 1,
            cpu: 100,
            memory: GIB,
            gpus: 0,
            storageBytes: 0,
          },
        ],
      }),
      reading({ namespaces: { shop: { storage: 0 } } }),
      opencost,
      null
    );
    // Its storage is priced at 0 and it holds none: that prices none of
    // what it does hold, so it has no total, not a floor of 0.
    const shop = picture.namespaces.find((n) => n.namespace === "shop")!;
    expect(shop).toMatchObject({ perHour: null, atLeast: false });
    expect(shop.unpriced).toEqual(["cpu", "memory"]);
    const bank = picture.namespaces.find((n) => n.namespace === "bank")!;
    expect(bank.perHour).toBeNull();
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

  /**
   * On a cluster OpenCost has no price list for, no node carries a price.
   * Idle is the nodes' cost less what was allocated; with none of that
   * known it is not known, and 0 was the lie the page told.
   */
  it("has no idle where OpenCost prices no node", () => {
    const picture = readingPicture(
      basis({ nodes: [node("node-a"), node("node-b")] }),
      reading({ nodes: [], allocatedByNode: {} }),
      opencost,
      null
    );
    expect(picture.idle).toBeNull();
    expect(picture.nodes!.every((n) => n.idle === null)).toBe(true);
  });

  /** Some nodes priced: their idle is a floor. */
  it("calls idle at least where some nodes carry no price", () => {
    const picture = readingPicture(
      basis({ nodes: [node("node-a"), node("worker-7")] }),
      reading(),
      opencost,
      null
    );
    expect(picture.idle?.atLeast).toBe(true);
    expect(picture.idle?.perHour).toBeCloseTo(0.15);
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

describe("a Prometheus that prices another cluster's nodes too", () => {
  /**
   * A shared Prometheus holds staging's OpenCost series beside prod's.
   * Where prod's node list was read, its total, its node table and its idle
   * are prod's nodes only, and the others are named. Fails if a node the
   * cluster does not list was added to its total.
   */
  it("counts only the nodes the cluster lists, and names the rest", () => {
    const shared = reading({
      nodes: [
        { name: "node-a", perHour: 0.2, instanceType: "m5.large", spot: false },
        { name: "staging-1", perHour: 0.5, instanceType: null, spot: null },
      ],
      allocatedByNode: { "node-a": 0.05, "staging-1": 0.1 },
    });
    const picture = readingPicture(basis(), shared, opencost, null);
    expect(picture.cluster?.perHour).toBeCloseTo(0.2);
    expect(picture.nodes?.map((n) => n.name)).toEqual(["node-a"]);
    expect(picture.idle?.perHour).toBeCloseTo(0.15);
    expect(picture.foreignNodes).toEqual(["staging-1"]);
  });

  /**
   * Without the node list there is nothing to tell another cluster's
   * nodes by: none is called foreign, each priced node keeps its row as
   * OpenCost states it, and no total is made of them. Fails if a refused
   * node list drops the priced nodes, or sums them as the cluster's.
   */
  it("keeps every priced node's row, and makes no total, where the cluster's node list was not read", () => {
    const shared = reading({
      nodes: [
        { name: "node-a", perHour: 0.2, instanceType: "m5.large", spot: false },
        { name: "staging-1", perHour: 0.5, instanceType: null, spot: null },
      ],
    });
    const picture = readingPicture(
      basis({ nodes: null }),
      shared,
      opencost,
      null
    );
    expect(picture.nodes?.map((n) => n.name)).toEqual(["node-a", "staging-1"]);
    expect(picture.cluster).toBeNull();
    expect(picture.foreignNodes).toEqual([]);
  });
});

describe("what the supplier's series cover", () => {
  /**
   * A workload of two pods with series for one: the row was that pod's
   * cost, shown as the workload's and its namespace's. Both are floors.
   * Fails if a sum over some of a workload's pods reads as all of it.
   */
  it("makes a row a floor where its series cover fewer pods than run", () => {
    const partly = fold([[0.03, 0.02, null, null]]);
    partly.covered = [[1, 1, 0, 0]];
    const picture = readingPicture(
      basis(),
      reading({ workloads: partly }),
      opencost,
      null
    );
    expect(picture.workloads[0]).toMatchObject({ atLeast: true });
    expect(picture.namespaces[0]).toMatchObject({
      namespace: "shop",
      atLeast: true,
    });

    const whole = fold([[0.03, 0.02, null, null]]);
    whole.covered = [[2, 2, 0, 0]];
    const all = readingPicture(
      basis(),
      reading({ workloads: whole }),
      opencost,
      null
    );
    expect(all.workloads[0]!.atLeast).toBe(false);
    expect(all.namespaces[0]!.atLeast).toBe(false);
  });

  /**
   * The basis counted one pod and the workload scaled to two before the
   * series were read, which covered one: compared with the basis's count
   * the row read as whole. Fails if coverage is judged out of any count but
   * the read's own.
   */
  it("judges coverage out of the pods the same read listed", () => {
    const one = basis({ workloads: [{ ...workload("web"), pods: 1 }] });
    const scaled = fold([[0.03, 0.02, null, null]]);
    scaled.covered = [[1, 1, 0, 0]];
    scaled.pods = [2];
    const up = readingPicture(
      one,
      reading({ workloads: scaled }),
      opencost,
      null
    );
    expect(up.workloads[0]!.atLeast).toBe(true);
    expect(up.namespaces[0]!.atLeast).toBe(true);

    scaled.pods = [1];
    const same = readingPicture(
      one,
      reading({ workloads: scaled }),
      opencost,
      null
    );
    expect(same.workloads[0]!.atLeast).toBe(false);
  });
});

describe("whether no node carries a price", () => {
  /**
   * Where allocation by node was not asked the picture has no by-node
   * table, and "no node priced" read that as "not known", so the page gave
   * the reason for some nodes priced and offered no prices. It is counted
   * from the nodes the cluster lists. Fails if it hangs on the table.
   */
  it("is told from the cluster's nodes, not from the by-node table", () => {
    const none = readingPicture(
      basis(),
      reading({ nodes: [], allocatedByNode: null }),
      opencost,
      null
    );
    expect(none.nodes).toBeNull();
    expect(noNodePriced(none)).toBe(true);
    const some = readingPicture(
      basis(),
      reading({ allocatedByNode: null }),
      opencost,
      null
    );
    expect(noNodePriced(some)).toBe(false);
  });
});

describe("storage nobody could read", () => {
  /**
   * A namespace's claims were refused: its storage became 0 bytes, and the
   * row, priced in CPU and memory, read as whole. It is a floor, its
   * storage cell says it is not known, and so for its workloads; storage
   * read as 0 stays whole. Fails if unread storage counts as none.
   */
  it("makes a row a floor where its storage could not be read, and only then", () => {
    const shop = (storageBytes: number | null) =>
      estimatePicture(
        basis({
          namespaces: [
            {
              namespace: "shop",
              workloads: 1,
              pods: 2,
              cpu: 500,
              memory: GIB,
              gpus: 0,
              storageBytes,
            },
          ],
        }),
        prices,
        null
      );
    const unread = shop(null);
    expect(unread.namespaces[0]).toMatchObject({
      atLeast: true,
      unknown: ["storage"],
    });
    expect(unread.workloads[0]).toMatchObject({
      atLeast: true,
      unknown: ["storage"],
    });
    const none = shop(0);
    expect(none.namespaces[0]).toMatchObject({ atLeast: false, unknown: [] });
    expect(none.workloads[0]!.atLeast).toBe(false);
  });
});

describe("whether OpenCost prices this cluster's nodes", () => {
  /**
   * A shared Prometheus priced only staging's node: OpenCost "priced a
   * node", so entered prices were set aside, and then the staging node was
   * left out and this cluster's nodes had no price at all. Only this
   * cluster's nodes count, where they were listed. Fails if another
   * cluster's priced node keeps entered prices from standing in.
   */
  it("counts only the nodes this cluster lists", () => {
    const staging = reading({
      nodes: [
        { name: "staging-1", perHour: 0.5, instanceType: null, spot: null },
      ],
    });
    expect(pricesNoNode(staging, basis())).toBe(true);
    expect(pricesNoNode(reading(), basis())).toBe(false);
    expect(pricesNoNode(staging, basis({ nodes: null }))).toBe(false);
  });
});

describe("volumes nobody claims", () => {
  /** Sent as a count and a sum, priced as one: fails if their cost is lost with the list. */
  it("prices the sum of the volumes nobody claims", () => {
    const picture = estimatePicture(
      basis({ unclaimed: { count: 3, bytes: 30 * GIB } }),
      prices,
      null
    );
    expect(picture.unclaimed).toBeCloseTo((30 * 0.1) / HOURS_PER_MONTH, 6);
  });
});

describe("a namespace the supplier's own read was refused", () => {
  /**
   * The cost basis read `shop`, the supplier's read of the same pods was
   * refused a moment later: Rust kept the refusal in the fold, and the
   * picture dropped it, so the rows had no price and no reason. Fails if a
   * refusal in either read is left out of the picture's unread.
   */
  it("carries the refusal into what the picture could not read", () => {
    const refused = fold([[null, null, null, null]]);
    refused.unread = [
      {
        namespace: "shop",
        code: "PERMISSION_DENIED",
        message: "pods is forbidden",
        values: [null, null, null, null],
      },
    ];
    const picture = readingPicture(
      basis(),
      reading({ workloads: refused }),
      opencost,
      null
    );
    expect(picture.unread).toEqual([
      {
        namespace: "shop",
        code: "PERMISSION_DENIED",
        message: "pods is forbidden",
      },
    ]);
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

describe("whose row a Job's cost is", () => {
  /** The rule `cost_basis` folds a Job by: its controller, when that is a CronJob. */
  it("is its CronJob's where a CronJob controls it, and its own otherwise", () => {
    const owner = (kind: string, controller: boolean) => ({
      api_version: "batch/v1",
      kind,
      name: "backup",
      uid: "u",
      controller,
    });
    expect(cronJobOf({ ownerReferences: [owner("CronJob", true)] })).toEqual({
      group: "batch",
      kind: "CronJob",
      name: "backup",
    });
    expect(
      cronJobOf({ ownerReferences: [owner("CronJob", false)] })
    ).toBeNull();
    expect(cronJobOf({ ownerReferences: [] })).toBeNull();
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
