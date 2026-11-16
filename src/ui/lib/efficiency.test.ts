import { describe, expect, it } from "vite-plus/test";

import type { WorkloadKey } from "@/generated/types";
import {
  efficiencyOf,
  overRequested,
  workloadEfficiency,
  type UsageReading,
} from "./efficiency";

const key: WorkloadKey = {
  namespace: "shop",
  group: "apps",
  kind: "Deployment",
  name: "web",
};

const NOW = Date.parse("2026-11-15T12:00:00Z");
const DAY_OLD = "2026-11-14T06:00:00Z";
const TWO_HOURS_OLD = "2026-11-15T10:00:00Z";

describe("efficiency", () => {
  /** No sample is not 0% used: it is nothing measured. */
  it("is not measured where no sample came back", () => {
    expect(efficiencyOf(500, null, null, DAY_OLD, NOW)).toEqual({
      state: "noSamples",
    });
  });

  /** Nothing requested has no ratio: dividing by it read as 100% or infinity. */
  it("has no ratio where nothing was requested", () => {
    expect(efficiencyOf(0, 20, 40, DAY_OLD, NOW)).toEqual({
      state: "unrequested",
      avg: 20,
      peak: 40,
      since: DAY_OLD,
      whole: true,
    });
  });

  it("is the average and the peak over the request", () => {
    expect(efficiencyOf(500, 100, 400, DAY_OLD, NOW)).toMatchObject({
      state: "measured",
      ratio: 0.2,
      peakRatio: 0.8,
    });
  });

  /**
   * Only a measured peak can call a request far above use. A workload
   * nobody measured, or one that requests nothing, is never judged: Audit
   * reads this, and a rule firing on "could not look" is the third state
   * collapsing.
   */
  it("calls a request far above use only from a measured peak", () => {
    expect(overRequested(efficiencyOf(1000, 100, 400, DAY_OLD, NOW))).toBe(
      true
    );
    expect(overRequested(efficiencyOf(1000, 100, 600, DAY_OLD, NOW))).toBe(
      false
    );
    expect(overRequested(efficiencyOf(1000, 100, null, DAY_OLD, NOW))).toBe(
      false
    );
    expect(overRequested(efficiencyOf(1000, null, null, DAY_OLD, NOW))).toBe(
      false
    );
    expect(overRequested(efficiencyOf(0, 100, 400, DAY_OLD, NOW))).toBe(false);
    expect(overRequested({ state: "failed", said: "timeout" })).toBe(false);
    expect(overRequested({ state: "noSupplier" })).toBe(false);
  });

  /**
   * A peak read over the two hours since a rollout has not met the day's
   * busiest hour, so it judges nothing; a workload whose pods' start is not
   * known is not taken to have run the day. Fails if a young workload's
   * low peak called its request far above use.
   */
  it("judges a request only over a whole day of its youngest pod", () => {
    const young = efficiencyOf(1000, 100, 400, TWO_HOURS_OLD, NOW);
    expect(young).toMatchObject({ state: "measured", whole: false });
    expect(overRequested(young)).toBe(false);
    expect(overRequested(efficiencyOf(1000, 100, 400, null, NOW))).toBe(false);
    expect(overRequested(efficiencyOf(1000, 100, 400, DAY_OLD, NOW))).toBe(
      true
    );
  });

  /** Where the reading itself is missing, both resources say why. */
  it("carries the reading's own state to both resources", () => {
    const failed: UsageReading = { state: "failed", said: "timed out" };
    expect(workloadEfficiency(failed, key, { cpu: 1, memory: 1 })).toEqual({
      cpu: failed,
      memory: failed,
    });
    expect(
      workloadEfficiency({ state: "noSupplier" }, key, { cpu: 1, memory: 1 })
        .cpu
    ).toEqual({ state: "noSupplier" });
  });

  /** The values and the youngest pod's start are both the key's, by position. */
  it("reads a workload's four values and its youngest pod's start positionally on the keys", () => {
    const reading: UsageReading = {
      state: "read",
      keys: [{ ...key, name: "api" }, key],
      fold: {
        values: [
          [900, 950, null, null],
          [100, 400, null, null],
        ],
        rest: [null, null, null, null],
        unplaced: [],
        unread: [],
        unlabelled: 0,
        since: [DAY_OLD, TWO_HOURS_OLD],
      },
    };
    const of = workloadEfficiency(
      reading,
      key,
      { cpu: 500, memory: 1024 },
      NOW
    );
    expect(of.cpu).toMatchObject({
      state: "measured",
      ratio: 0.2,
      since: TWO_HOURS_OLD,
      whole: false,
    });
    expect(of.memory).toEqual({ state: "noSamples" });
  });
});
