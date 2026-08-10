import { describe, expect, it } from "vitest";
import {
  appendSample,
  bucketize,
  chartMax,
  latestValue,
  limitInView,
  linePath,
  restartIndices,
  yOf,
  watchedFor,
  type UsageSample,
} from "@/lib/usage-history";

const sample = (
  t: number,
  cpu: number | null,
  restarts: number | null = null
): UsageSample => ({
  t,
  cpuMillicores: cpu,
  memoryBytes: null,
  restarts,
});

describe("appendSample", () => {
  it("ignores a timestamp it already holds", () => {
    // Several components read the same metrics query, so the same poll
    // arrives more than once and must count as one reading.
    const first = appendSample([], sample(1000, 10));
    const again = appendSample(first, sample(1000, 99));
    expect(again).toBe(first);
    expect(again).toHaveLength(1);
  });

  it("ignores a sample older than the newest one held", () => {
    const series = appendSample(
      appendSample([], sample(2000, 10)),
      sample(1000, 5)
    );
    expect(series).toHaveLength(1);
    expect(series[0].t).toBe(2000);
  });

  it("drops the oldest reading once the buffer is full", () => {
    let series: readonly UsageSample[] = [];
    for (let i = 0; i < 5; i++)
      series = appendSample(series, sample(i * 1000, i), 3);
    expect(series).toHaveLength(3);
    expect(series[0].cpuMillicores).toBe(2);
    expect(series[2].cpuMillicores).toBe(4);
  });
});

describe("bucketize", () => {
  it("keeps the largest reading in a bucket, never the average", () => {
    // A mean would hide the thirty seconds that got a container OOM-killed,
    // which is the one reading anybody opens this chart for.
    const samples = [
      sample(0, 10),
      sample(1000, 900),
      sample(2000, 10),
      sample(3000, 20),
    ];
    const points = bucketize(samples, "cpuMillicores", 2);
    expect(points[0].v).toBe(900);
    expect(points[0].v).not.toBe(455);
  });

  it("stamps a bucket with the moment of its peak, not the bucket midpoint", () => {
    const points = bucketize(
      [sample(0, 10), sample(1000, 900), sample(2000, 10), sample(3000, 20)],
      "cpuMillicores",
      2
    );
    expect(points[0].t).toBe(1000);
  });

  it("leaves a bucket with no reading empty rather than zero", () => {
    // A burst of polls, then a long silence — the app was on another tab.
    // The quiet stretch is unknown, not idle.
    const samples = [
      ...[0, 1000, 2000, 3000, 4000, 5000].map((t) => sample(t, 10)),
      sample(600_000, 20),
    ];
    const points = bucketize(samples, "cpuMillicores", 5);
    const empty = points.filter((point) => point.v === null);
    expect(empty.length).toBeGreaterThan(0);
    expect(points.every((point) => point.v !== 0)).toBe(true);
  });

  it("gives one bucket per reading while there are fewer readings than buckets", () => {
    // The first minutes: the line should have the resolution it was polled
    // at, not be spread across empty slots that read as gaps.
    const points = bucketize(
      [sample(0, 10), sample(2000, 20)],
      "cpuMillicores",
      120
    );
    expect(points).toHaveLength(2);
    expect(points.every((point) => point.v !== null)).toBe(true);
  });

  it("marks the bucket where the restart count went up", () => {
    const points = bucketize(
      [
        sample(0, 10, 0),
        sample(1000, 10, 0),
        sample(2000, 5, 1),
        sample(3000, 6, 1),
      ],
      "cpuMillicores",
      4
    );
    expect(restartIndices(points)).toEqual([2]);
  });
});

describe("chartMax", () => {
  it("makes the limit the scale, so line height is closeness to the ceiling", () => {
    const points = bucketize(
      [sample(0, 90), sample(1000, 96)],
      "cpuMillicores"
    );
    expect(chartMax(points, 128)).toBe(128);
    expect(limitInView(128, 128)).toBe(true);
  });

  it("keeps a breach on screen instead of clipping the one event worth seeing", () => {
    const points = bucketize(
      [sample(0, 40), sample(1000, 260)],
      "cpuMillicores"
    );
    expect(chartMax(points, 200)).toBe(260);
  });

  it("draws an idle object near the floor rather than blowing it up to fill the band", () => {
    // 0.4m against a 100m limit. Scaling to the series' own peak would put
    // an idle sidecar's line near the top, which a glance reads as busy.
    const points = bucketize(
      [sample(0, 0.3), sample(1000, 0.4)],
      "cpuMillicores"
    );
    const max = chartMax(points, 100);
    expect(max).toBe(100);
    expect(
      yOf(0.4, max, { width: 600, height: 42, topPad: 4 })
    ).toBeGreaterThan(40);
  });

  it("scales to what was used when nothing declares a limit", () => {
    const points = bucketize(
      [sample(0, 40), sample(1000, 90)],
      "cpuMillicores"
    );
    expect(chartMax(points, null)).toBeCloseTo(112.5, 1);
  });
});

describe("linePath", () => {
  it("breaks the line at a gap instead of bridging it", () => {
    // A straight segment across missing data claims nothing happened there,
    // and nobody knows that.
    const points = [
      { t: 0, v: 10, restart: false },
      { t: 1, v: null, restart: false },
      { t: 2, v: 20, restart: false },
    ];
    const path = linePath(points, 100, { width: 600, height: 42, topPad: 4 });
    expect(path.match(/M/g)).toHaveLength(2);
  });
});

describe("latestValue", () => {
  it("looks past a trailing gap for the last real reading", () => {
    expect(
      latestValue([
        { t: 0, v: 12, restart: false },
        { t: 1, v: null, restart: false },
      ])
    ).toBe(12);
  });
});

describe("watchedFor", () => {
  it("counts seconds in the first minute, when the reader is checking it works", () => {
    expect(watchedFor([sample(0, 1), sample(12000, 2)])).toBe("12s");
  });

  it("counts minutes after that", () => {
    expect(watchedFor([sample(0, 1), sample(4 * 60000, 2)])).toBe("4m");
  });

  it("measures the readings held, not the time since the page opened", () => {
    // If the metrics query stops answering the caption must stop growing.
    expect(watchedFor([sample(0, 1), sample(30000, 2)])).toBe("30s");
  });
});
