import { describe, expect, it } from "vite-plus/test";

import type { WorkloadKey } from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import {
  EFFICIENCY_WINDOW,
  efficiencyOf,
  overRequested,
  windowWords,
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
      since: DAY_OLD,
      whole: true,
    });
  });

  /**
   * A workload three minutes old has no sample yet, which is not the same
   * as a day without one: it says when its youngest pod started. Fails if
   * a young workload's empty reading lost its start.
   */
  it("says when the youngest pod started where no sample came back yet", () => {
    expect(efficiencyOf(500, null, null, TWO_HOURS_OLD, NOW)).toEqual({
      state: "noSamples",
      since: TWO_HOURS_OLD,
      whole: false,
    });
  });

  /** Nothing requested has no ratio: dividing by it read as 100% or infinity. */
  it("has no ratio where nothing was requested", () => {
    expect(efficiencyOf(0, 20, 40, DAY_OLD, NOW)).toEqual({
      state: "unrequested",
      avg: 20,
      peak: 40,
      peakAtMost: false,
      podsRead: null,
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

  /**
   * The usage read was refused this namespace's pods after the rows were
   * listed: its rows carry no values, which read as "no samples". They say
   * the refusal. Fails if a refused namespace reads as unsampled.
   */
  it("says a refused namespace was refused, not unsampled", () => {
    const reading: UsageReading = {
      state: "read",
      keys: [key],
      fold: {
        values: [[null, null, null, null]],
        rest: [null, null, null, null],
        unplaced: [],
        unread: [
          {
            namespace: "shop",
            code: "PERMISSION_DENIED",
            message: "pods is forbidden",
            values: [null, null, null, null],
          },
        ],
        unlabelled: 0,
        covered: [],
        pods: [],
        since: [null],
      },
    };
    expect(
      workloadEfficiency(reading, key, { cpu: 1, memory: 1 }, NOW)
    ).toEqual({
      cpu: { state: "failed", said: "pods is forbidden" },
      memory: { state: "failed", said: "pods is forbidden" },
    });
  });

  /**
   * What a reading covers is judged when it was read: counted at render, a
   * reading of 23 hours of a pod's life grew into a whole day an hour
   * later, and its low peak was called a request far above use. Fails if
   * a reading's span is counted to the clock rather than to its own time.
   */
  it("judges a reading's span at the time it was read", () => {
    const since = new Date(Date.now() - 25 * 3_600_000).toISOString();
    const readAt = Date.parse(since) + 23 * 3_600_000;
    const reading: UsageReading = {
      state: "read",
      keys: [key],
      fold: {
        values: [[100, 400, 10, 20]],
        rest: [null, null, null, null],
        unplaced: [],
        unread: [],
        unlabelled: 0,
        covered: [[1, 1, 1, 1]],
        pods: [1],
        since: [since],
      },
      at: readAt,
    };
    const of = workloadEfficiency(reading, key, { cpu: 1000, memory: 100 });
    expect(of.cpu).toMatchObject({ state: "measured", whole: false });
    expect(overRequested(of.cpu)).toBe(false);
  });

  /**
   * A peak is read per pod, and several pods' peaks summed are no lower
   * than the workload's: a bound. Fails if a sum over several pods reads
   * as the peak, or one pod's as a bound.
   */
  it("marks a peak summed over several pods as a bound", () => {
    const reading: UsageReading = {
      state: "read",
      keys: [key],
      fold: {
        values: [[100, 400, 10, 20]],
        rest: [null, null, null, null],
        unplaced: [],
        unread: [],
        unlabelled: 0,
        covered: [[2, 2, 1, 1]],
        pods: [2],
        since: [DAY_OLD],
      },
    };
    const of = workloadEfficiency(
      reading,
      key,
      { cpu: 1000, memory: 100 },
      NOW
    );
    expect(of.cpu).toMatchObject({ state: "measured", peakAtMost: true });
    expect(of.memory).toMatchObject({ state: "measured", peakAtMost: false });
  });

  /**
   * Two of its three pods were read: their peaks summed were called "at
   * most" the workload's, though the third may have peaked higher than
   * both, and a low sum was called a request far above use. Fails if a sum
   * over some of its pods reads as a bound, or is judged.
   */
  it("says which pods a sum over some of them was read from, and judges none", () => {
    const fold = (covered: number[], pods: number): UsageReading => ({
      state: "read",
      keys: [key],
      fold: {
        values: [[100, 200, 10, 20]],
        rest: [null, null, null, null],
        unplaced: [],
        unread: [],
        unlabelled: 0,
        covered: [covered],
        pods: [pods],
        since: [DAY_OLD],
      },
    });
    const requests = { cpu: 1000, memory: 100 };
    const some = workloadEfficiency(fold([2, 2, 2, 1], 3), key, requests, NOW);
    expect(some.cpu).toMatchObject({
      state: "measured",
      peakAtMost: false,
      podsRead: { read: 2, of: 3 },
    });
    expect(some.memory).toMatchObject({ podsRead: { read: 1, of: 3 } });
    expect(overRequested(some.cpu)).toBe(false);

    const one = workloadEfficiency(fold([1, 1, 1, 1], 1), key, requests, NOW);
    expect(one.cpu).toMatchObject({ peakAtMost: false, podsRead: null });
    expect(overRequested(one.cpu)).toBe(true);
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
        covered: [],
        pods: [],
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
    expect(of.memory).toEqual({
      state: "noSamples",
      since: TWO_HOURS_OLD,
      whole: false,
    });
  });
});

describe("the usage window in words", () => {
  const tIn =
    (locale: "en" | "ru"): T =>
    (section, key, values) =>
      translate(locale, section, key, values);

  /**
   * A PromQL token is not a word of either language. Fails if Audit's line
   * or the Cost columns read "за последние 24h".
   */
  it("says the window in the reader's language", () => {
    expect(windowWords(EFFICIENCY_WINDOW, tIn("en"))).toBe("24 hours");
    expect(windowWords(EFFICIENCY_WINDOW, tIn("ru"))).toBe("24 часа");
    expect(windowWords("7d", tIn("ru"))).toBe("7 дней");
    expect(windowWords("whenever", tIn("en"))).toBe("whenever");
    expect(
      tIn("ru")("audit", "usageRead", {
        window: windowWords(EFFICIENCY_WINDOW, tIn("ru")),
      })
    ).toContain("за последние 24 часа");
  });
});
