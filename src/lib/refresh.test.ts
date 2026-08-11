import { describe, expect, it } from "vitest";

import { BACKOFF, REFRESH_INTERVALS, effectiveInterval } from "./refresh";

const on = { visible: true, focused: true, steadyRuns: 0 };
const base = REFRESH_INTERVALS.resourceList;

describe("what a query is allowed to re-read at", () => {
  it("re-reads at its rate while it is being watched and still moving", () => {
    expect(effectiveInterval(base, on)).toBe(base);
  });

  it("does not re-read at all when nobody is looking at it", () => {
    expect(effectiveInterval(base, { ...on, visible: false })).toBe(false);
  });

  it("leaves a watch-fed query alone, visible or not", () => {
    expect(effectiveInterval(false, on)).toBe(false);
    expect(effectiveInterval(false, { ...on, visible: false })).toBe(false);
  });

  it("holds its rate until the screen has been still for long enough", () => {
    for (let runs = 0; runs < BACKOFF.steadyAfter; runs++) {
      expect(effectiveInterval(base, { ...on, steadyRuns: runs })).toBe(base);
    }
  });

  it("doubles once the screen has stopped changing, and stops at the cap", () => {
    const at = (steadyRuns: number) =>
      effectiveInterval(base, { ...on, steadyRuns });
    expect(at(BACKOFF.steadyAfter)).toBe(base * 2);
    expect(at(BACKOFF.steadyAfter + 1)).toBe(base * 4);
    expect(at(BACKOFF.steadyAfter + 20)).toBe(BACKOFF.cap);
  });

  it("holds a visible but unfocused window at the cap", () => {
    expect(effectiveInterval(base, { ...on, focused: false })).toBe(
      BACKOFF.unfocusedFloor
    );
  });

  it("never speeds a slow rate up to meet the unfocused floor", () => {
    // `steady` is already at the cap. The floor is a ceiling on effort, not a
    // promise to re-read more often than the surface asked for.
    const steady = REFRESH_INTERVALS.steady;
    expect(effectiveInterval(steady, { ...on, focused: false })).toBe(steady);
  });
});

describe("a rate that is a recording's cadence", () => {
  it("keeps its spacing however still the numbers are", () => {
    const metrics = REFRESH_INTERVALS.metrics;
    const still = {
      ...on,
      recording: true,
      steadyRuns: BACKOFF.steadyAfter + 20,
    };
    expect(effectiveInterval(metrics, still)).toBe(metrics);
  });

  it("still stops dead when nobody is looking at the chart", () => {
    expect(
      effectiveInterval(REFRESH_INTERVALS.metrics, {
        ...on,
        recording: true,
        visible: false,
      })
    ).toBe(false);
  });
});
