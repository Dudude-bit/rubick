import { describe, it, expect } from "vitest";
import {
  appendCapped,
  backfillPerContainer,
  EMPTY_BUFFER,
  orderByTimestamp,
} from "./log-buffer";
import type { StreamedLogLine } from "../types";

const line = (id: number, epoch = id) =>
  ({ id, epoch, message: `m${id}` }) as StreamedLogLine;
const lines = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => line(from + i));

describe("orderByTimestamp", () => {
  it("returns the input untouched when it is already ordered", () => {
    // The single-container case, which is still the common one: every
    // window arrives ordered and the sort would be pure waste.
    const pending = lines(0, 5);
    expect(orderByTimestamp(pending)).toBe(pending);
  });

  it("puts two containers' lines into timestamp order", () => {
    const a = { ...line(1), epoch: 300 } as StreamedLogLine;
    const b = { ...line(2), epoch: 100 } as StreamedLogLine;
    const c = { ...line(3), epoch: 200 } as StreamedLogLine;

    expect(orderByTimestamp([a, b, c]).map((l) => l.epoch)).toEqual([
      100, 200, 300,
    ]);
  });

  it("breaks a tie by arrival order and never reorders equal stamps", () => {
    // Two containers reporting the same millisecond is normal, and the
    // id is a total order, so the result does not depend on the sort
    // implementation being stable.
    const first = { ...line(7), epoch: 500 } as StreamedLogLine;
    const second = { ...line(8), epoch: 500 } as StreamedLogLine;
    const early = { ...line(9), epoch: 100 } as StreamedLogLine;

    expect(orderByTimestamp([second, first, early]).map((l) => l.id)).toEqual([
      9, 7, 8,
    ]);
  });

  it("does not mutate the window it was given", () => {
    const pending = [line(2, 200), line(1, 100)];
    orderByTimestamp(pending);
    expect(pending.map((l) => l.id)).toEqual([2, 1]);
  });
});

describe("appendCapped", () => {
  it("returns a new array so React sees the change", () => {
    const prev = { lines: lines(0, 3), dropped: 0 };
    const next = appendCapped(prev, lines(3, 2), 100);

    expect(next.lines).not.toBe(prev.lines);
    expect(prev.lines).toHaveLength(3);
    expect(next.lines.map((l) => l.id)).toEqual([0, 1, 2, 3, 4]);
    expect(next.dropped).toBe(0);
  });

  it("drops from the head once the cap is reached, keeping the newest", () => {
    const next = appendCapped(
      { lines: lines(0, 100), dropped: 0 },
      lines(100, 10),
      100
    );

    expect(next.lines).toHaveLength(100);
    expect(next.lines[0].id).toBe(10);
    expect(next.lines[99].id).toBe(109);
  });

  it("counts what it dropped, so the viewer can stop being silently lossy", () => {
    let buffer = appendCapped(EMPTY_BUFFER, lines(0, 100), 100);
    expect(buffer.dropped).toBe(0);

    buffer = appendCapped(buffer, lines(100, 10), 100);
    expect(buffer.dropped).toBe(10);

    buffer = appendCapped(buffer, lines(110, 25), 100);
    expect(buffer.dropped).toBe(35);
  });

  it("keeps only the tail of a window that is itself over the cap", () => {
    const next = appendCapped(
      { lines: lines(0, 5), dropped: 0 },
      lines(100, 120),
      100
    );

    expect(next.lines).toHaveLength(100);
    expect(next.lines[0].id).toBe(120);
    expect(next.dropped).toBe(25);
  });

  it("is a no-op on an empty window", () => {
    const prev = { lines: lines(0, 3), dropped: 4 };
    expect(appendCapped(prev, [], 100)).toBe(prev);
  });
});

describe("backfillPerContainer", () => {
  it("splits the cap across the containers being streamed", () => {
    // Asking five containers for 5 000 each would fetch 25 000 lines to
    // keep 5 000, and report a dropped head on a pane just opened.
    expect(backfillPerContainer(5000, 5)).toBe(1000);
    expect(backfillPerContainer(5000, 1)).toBe(5000);
    expect(backfillPerContainer(1000, 3)).toBe(334);
  });

  it("always asks for at least one line", () => {
    expect(backfillPerContainer(1, 40)).toBe(1);
    expect(backfillPerContainer(0, 0)).toBe(1);
  });
});
