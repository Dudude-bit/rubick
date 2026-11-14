import { describe, expect, it } from "vite-plus/test";

import type { WorkloadKey } from "@/generated/types";
import {
  efficiencyOf,
  overRequested,
  workloadEfficiency,
  type UsageReading,
} from "./efficiency";

const key: WorkloadKey = { namespace: "shop", kind: "Deployment", name: "web" };

describe("efficiency", () => {
  /** No sample is not 0% used: it is nothing measured. */
  it("is not measured where no sample came back", () => {
    expect(efficiencyOf(500, null, null)).toEqual({ state: "noSamples" });
  });

  /** Nothing requested has no ratio: dividing by it read as 100% or infinity. */
  it("has no ratio where nothing was requested", () => {
    expect(efficiencyOf(0, 20, 40)).toEqual({
      state: "unrequested",
      avg: 20,
      peak: 40,
    });
  });

  it("is the average and the peak over the request", () => {
    expect(efficiencyOf(500, 100, 400)).toMatchObject({
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
    expect(overRequested(efficiencyOf(1000, 100, 400))).toBe(true);
    expect(overRequested(efficiencyOf(1000, 100, 600))).toBe(false);
    expect(overRequested(efficiencyOf(1000, 100, null))).toBe(false);
    expect(overRequested(efficiencyOf(1000, null, null))).toBe(false);
    expect(overRequested(efficiencyOf(0, 100, 400))).toBe(false);
    expect(overRequested({ state: "failed", said: "timeout" })).toBe(false);
    expect(overRequested({ state: "noSupplier" })).toBe(false);
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

  it("reads a workload's four values positionally on the keys", () => {
    const reading: UsageReading = {
      state: "read",
      keys: [key],
      fold: {
        values: [[100, 400, null, null]],
        rest: [null, null, null, null],
        unplaced: [],
        unread: [],
        unlabelled: 0,
      },
    };
    const of = workloadEfficiency(reading, key, { cpu: 500, memory: 1024 });
    expect(of.cpu).toMatchObject({ state: "measured", ratio: 0.2 });
    expect(of.memory).toEqual({ state: "noSamples" });
  });
});
