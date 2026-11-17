import { describe, expect, it } from "vite-plus/test";

import type { CostBasis, WorkloadBasis } from "@/generated/types";
import { estimatePicture } from "@/lib/cost";
import {
  overRequested,
  workloadEfficiency,
  type UsageReading,
} from "@/lib/efficiency";
import { basisOf, usageRead } from "./usage";

const MI = 1024 * 1024;

const workload = (
  name: string,
  cpu: number,
  memory: number
): WorkloadBasis => ({
  key: { namespace: "shop", group: "apps", kind: "Deployment", name },
  pods: 2,
  cpu,
  memory,
  gpus: 0,
  claimBytes: 0,
});

const basis = (workloads: WorkloadBasis[]): CostBasis => ({
  nodes: null,
  nodesUnread: null,
  heldUnread: null,
  namespaces: [],
  workloads,
  rest: null,
  waiting: 0,
  unread: [
    { namespace: "bank", code: "Forbidden", message: "pods is forbidden" },
  ],
  volumeBytes: null,
  volumeCount: null,
  unclaimed: null,
  volumesUnread: null,
  claimsUnread: [],
  servedFrom: "list" as CostBasis["servedFrom"],
});

/** A start long enough ago that every pod has run the whole day. */
const LONG_AGO = "2020-01-01T00:00:00Z";

/** cpuAvg, cpuPeak, memoryAvg, memoryPeak, per workload in the basis's order. */
const reading = (
  b: CostBasis,
  values: (number | null)[][],
  since: (string | null)[] = values.map(() => LONG_AGO)
): UsageReading => ({
  state: "read",
  keys: b.workloads.map((w) => w.key),
  fold: { values, rest: [], unplaced: [], unread: [], unlabelled: 0, since },
});

const shop = basis([
  workload("web", 2000, 512 * MI),
  workload("api", 500, 256 * MI),
  workload("cache", 1000, 4096 * MI),
  workload("fresh", 250, 128 * MI),
  workload("spiky", 1000, 1024 * MI),
  workload("edge", 1000, 1024 * MI),
]);
const day = reading(shop, [
  [200, 300, 200 * MI, 300 * MI],
  [300, 450, 150 * MI, 240 * MI],
  [800, 900, 1000 * MI, 1500 * MI],
  [null, null, null, null],
  [100, 800, 100 * MI, 900 * MI],
  [400, 450, 600 * MI, 700 * MI],
]);

const flagged = (read: ReturnType<typeof usageRead>) =>
  read.state === "read"
    ? read.workloads.filter((w) => w.verdict.says === "over").map((w) => w.name)
    : [];

describe("Audit's reading of requests against use", () => {
  /**
   * The Cost page draws a workload's efficiency from its picture's rows and
   * marks it over-requested where either resource is; Audit flags the
   * workloads its own reading says the same of. From one reading, the two
   * lists are one list. Fails if Audit judged with a threshold or a
   * function of its own, or read the rows' requests differently.
   */
  it("flags exactly the workloads the Cost page calls over-requested, from the same reading", () => {
    const picture = estimatePicture(
      shop,
      { cpu: 0.03, memory: 0.004, storage: null, gpu: null, currency: "" },
      null
    );
    const costCalls = picture.workloads
      .filter((row) => {
        const e = workloadEfficiency(day, row.key, row.requests);
        return overRequested(e.cpu) || overRequested(e.memory);
      })
      .map((row) => row.key.name);

    const audit = flagged(usageRead(shop, null, day));

    expect(costCalls).toEqual(["web", "cache", "edge"]);
    expect(audit).toEqual(costCalls);
  });

  /**
   * Each resource over the line is named with its request and its peak; a
   * workload with no sample says so instead of passing. Fails if an
   * unsampled workload read as within its requests.
   */
  it("names what is over, and says which workloads it holds no sample of", () => {
    const read = usageRead(shop, null, day);
    if (read.state !== "read") throw new Error(read.state);
    const by = Object.fromEntries(
      read.workloads.map((w) => [w.name, w.verdict])
    );
    expect(by.web).toEqual({
      says: "over",
      cpu: { requested: 2000, peak: 300 },
      memory: null,
    });
    expect(by.cache).toEqual({
      says: "over",
      cpu: null,
      memory: { requested: 4096 * MI, peak: 1500 * MI },
    });
    expect(by.api).toEqual({ says: "within" });
    expect(by.fresh).toEqual({ says: "noSamples" });
    expect(read.unread).toEqual([
      { namespace: "bank", message: "pods is forbidden" },
    ]);
    expect(read.window).toBe("24h");
  });

  /**
   * A workload rolled out two hours ago has a peak of two hours, which has
   * not met the day's busiest hour: neither page calls its request far
   * above use, and Audit says why it did not judge rather than passing it.
   * Fails if a young workload's low peak was flagged, or read as within.
   */
  it("judges no workload whose pods have not run a whole day", () => {
    const started = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const one = basis([workload("web", 2000, 512 * MI)]);
    const fresh = reading(one, [[200, 300, 200 * MI, 300 * MI]], [started]);
    const row = estimatePicture(
      one,
      { cpu: 0.03, memory: 0.004, storage: null, gpu: null, currency: "" },
      null
    ).workloads[0]!;
    const e = workloadEfficiency(fresh, row.key, row.requests);
    expect(overRequested(e.cpu)).toBe(false);

    const read = usageRead(one, null, fresh);
    if (read.state !== "read") throw new Error(read.state);
    expect(read.workloads[0]!.verdict).toEqual({
      says: "young",
      since: started,
    });
  });

  /**
   * Three minutes into a rollout Prometheus holds no sample yet; Audit says
   * the workload is young, as the Cost page does, not that its pods were
   * never sampled. Fails if a young workload with no samples read as
   * noSamples.
   */
  it("calls a workload with no samples yet young", () => {
    const started = new Date(Date.now() - 3 * 60_000).toISOString();
    const one = basis([workload("web", 2000, 512 * MI)]);
    const empty = reading(one, [[null, null, null, null]], [started]);
    const read = usageRead(one, null, empty);
    if (read.state !== "read") throw new Error(read.state);
    expect(read.workloads[0]!.verdict).toEqual({
      says: "young",
      since: started,
    });
  });

  /**
   * No Prometheus, a supplier still being probed, a failed read and a
   * requests list that did not come are each their own state; none is a
   * read with nothing over. Fails if any of them reached the backend as
   * "read".
   */
  it("keeps every way of not having read usage apart from a reading", () => {
    expect(usageRead(shop, null, { state: "noSupplier" })).toEqual({
      state: "noSupplier",
    });
    expect(usageRead(shop, null, { state: "reading" })).toEqual({
      state: "reading",
    });
    expect(usageRead(shop, null, { state: "failed", said: "timeout" })).toEqual(
      {
        state: "failed",
        said: "timeout",
      }
    );
    expect(usageRead(undefined, new Error("refused"), day)).toMatchObject({
      state: "failed",
    });
    expect(usageRead(undefined, null, day)).toEqual({ state: "reading" });
  });

  /**
   * One workload's answer reads only its own row, as its cost line does; a
   * workload the list does not hold requests nothing now, and is read as
   * such rather than left waiting for a reading nobody asked for.
   */
  it("cuts the requests list to one workload for its page", () => {
    const web = basisOf(shop, {
      kind: "Deployment",
      namespace: "shop",
      name: "web",
    });
    expect(web?.workloads.map((w) => w.key.name)).toEqual(["web"]);
    const idle = basisOf(shop, {
      kind: "Deployment",
      namespace: "shop",
      name: "idle",
    });
    expect(usageRead(idle, null, { state: "reading" })).toMatchObject({
      state: "read",
      workloads: [],
    });
    expect(
      basisOf(shop, { kind: "ClusterRole", namespace: null, name: "x" })
    ).toBeUndefined();
  });
});
