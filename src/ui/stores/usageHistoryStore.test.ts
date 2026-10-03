import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_SERIES,
  seriesKey,
  useUsageHistoryStore,
} from "@/stores/usageHistoryStore";

const poll = (t: number, cpu: number) => ({
  t,
  cpuMillicores: cpu,
  memoryBytes: null,
  restarts: null,
});

describe("usage history buffers", () => {
  beforeEach(() => {
    useUsageHistoryStore.getState().clear();
  });

  it("does not stitch a replaced pod onto the line of the one it replaced", () => {
    // A Deployment rolls; the new pod carries the same name for a moment
    // and is a different process with a different heap. Keying on the uid
    // is what stops one line being drawn straight across that break.
    const { record } = useUsageHistoryStore.getState();
    const before = seriesKey("Pod", "uid-old")!;
    const after = seriesKey("Pod", "uid-new")!;

    record(before, poll(1000, 100));
    record(before, poll(2000, 110));
    record(after, poll(3000, 4));

    const series = useUsageHistoryStore.getState().series;
    expect(series[before].samples).toHaveLength(2);
    expect(series[after].samples).toHaveLength(1);
    expect(series[after].samples[0].cpuMillicores).toBe(4);
    // The new pod's window must contain none of the old pod's readings.
    expect(series[after].samples.some((s) => s.cpuMillicores === 110)).toBe(
      false
    );
  });

  it("gives two pods with the same name in different namespaces their own window", () => {
    const { record } = useUsageHistoryStore.getState();
    record(seriesKey("Pod", "uid-a")!, poll(1000, 5));
    record(seriesKey("Pod", "uid-b")!, poll(1000, 50));
    const series = useUsageHistoryStore.getState().series;
    expect(Object.keys(series)).toHaveLength(2);
  });

  it("refuses a key for an object with no uid rather than falling back to a name", () => {
    expect(seriesKey("Pod", null)).toBeNull();
    expect(seriesKey("Pod", undefined)).toBeNull();
    expect(seriesKey("Pod", "")).toBeNull();
  });

  it("keeps a bounded number of series when a reader opens forty pods", () => {
    const { record } = useUsageHistoryStore.getState();
    for (let i = 0; i < 40; i++) {
      record(seriesKey("Pod", `uid-${i}`)!, poll(1000 + i, i));
    }
    const series = useUsageHistoryStore.getState().series;
    expect(Object.keys(series)).toHaveLength(MAX_SERIES);
    // The ones dropped are the ones written to longest ago.
    expect(series[seriesKey("Pod", "uid-39")!]).toBeDefined();
    expect(series[seriesKey("Pod", "uid-0")!]).toBeUndefined();
  });

  it("counts a repeated poll once", () => {
    const { record } = useUsageHistoryStore.getState();
    const key = seriesKey("Pod", "uid-x")!;
    record(key, poll(1000, 10));
    record(key, poll(1000, 10));
    expect(useUsageHistoryStore.getState().series[key].samples).toHaveLength(1);
  });
});
