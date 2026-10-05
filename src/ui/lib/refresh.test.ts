import { describe, expect, it } from "vite-plus/test";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { SLOW_READ_MS } from "./read-deadline";
import {
  BACKOFF,
  REFRESH_INTERVALS,
  effectiveInterval,
  overdue,
} from "./refresh";

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

describe("a rate slower than the cap", () => {
  /**
   * The cap is a ceiling on backing off, not a speed limit: clamping a
   * five-minute rate to it asked an unserved metrics API every thirty
   * seconds. Fails if a slow rate is pulled up to the cap.
   */
  it("keeps its own spacing however long the screen stays still", () => {
    expect(
      effectiveInterval(300_000, {
        visible: true,
        focused: true,
        steadyRuns: 12,
      })
    ).toBe(300_000);
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

describe("the count the shell keeps on every screen", () => {
  /**
   * The sidebar badge and the status bar read Needs attention on every
   * screen. Fails if their rate drops under a minute, is pulled up to the
   * backoff cap or the unfocused floor, or keeps running in a hidden window.
   */
  it("is asked once a minute at most, and not at all while hidden", () => {
    const shell = REFRESH_INTERVALS.shell;
    expect(shell).toBeGreaterThanOrEqual(60_000);
    expect(shell).toBeGreaterThan(REFRESH_INTERVALS.slow);
    expect(effectiveInterval(shell, on)).toBe(shell);
    expect(effectiveInterval(shell, { ...on, focused: false })).toBe(shell);
    expect(effectiveInterval(shell, { ...on, steadyRuns: 40 })).toBe(shell);
    expect(effectiveInterval(shell, { ...on, visible: false })).toBe(false);
  });
});

describe("an answer older than its rate", () => {
  const at = 1_000_000;

  /**
   * Fails if an answer within its interval and a slow read's grace is
   * called overdue, which would flicker every count built on it, or if one
   * past that is still taken for a reading of now.
   */
  it("is overdue only past its interval and a slow read's grace", () => {
    expect(overdue(at, 60_000, at + 60_000 + SLOW_READ_MS)).toBe(false);
    expect(overdue(at, 60_000, at + 60_000 + SLOW_READ_MS + 1)).toBe(true);
  });

  /** Hidden or watch-fed, nothing is due; never answered is "reading", not late. */
  it("is never overdue off a timer or before a first answer", () => {
    expect(overdue(at, false, at + 3_600_000)).toBe(false);
    expect(overdue(0, 60_000, at)).toBe(false);
  });
});

describe("an answer only an admin can change", () => {
  /**
   * The backend holds "metrics not installed" for the overview as long as
   * this rate waits to ask again. Fails if one side's number moves alone.
   */
  it("matches src/contracts/unserved-retry.json", () => {
    const shared = JSON.parse(
      readFileSync(
        resolve(process.cwd(), "src/contracts/unserved-retry.json"),
        "utf8"
      )
    ) as { unservedRetrySeconds: number };
    expect(REFRESH_INTERVALS.unserved).toBe(shared.unservedRetrySeconds * 1000);
  });
});
