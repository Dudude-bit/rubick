import { describe, it, expect } from "vite-plus/test";
import {
  appendCapped,
  historyRoom,
  lostLines,
  backfillPerContainer,
  emptyBuffer,
  fieldSuggestions,
  MAX_TRACKED_VALUES,
  orderByTimestamp,
  type LogBuffer,
} from "./log-buffer";
import type { StreamedLogLine } from "../types";

const line = (id: number, epoch = id) =>
  ({
    id,
    epoch,
    message: `m${id}`,
    container: "app",
    level: "info",
  }) as StreamedLogLine;
const lines = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => line(from + i));

const buffered = (lines: StreamedLogLine[], dropped = 0): LogBuffer =>
  appendCapped({ ...emptyBuffer(), dropped }, lines, lines.length);

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
    const prev = buffered(lines(0, 3));
    const next = appendCapped(prev, lines(3, 2), 100);

    expect(next.lines).not.toBe(prev.lines);
    expect(prev.lines).toHaveLength(3);
    expect(next.lines.map((l) => l.id)).toEqual([0, 1, 2, 3, 4]);
    expect(next.dropped).toBe(0);
  });

  it("drops from the head once the cap is reached, keeping the newest", () => {
    const next = appendCapped(buffered(lines(0, 100)), lines(100, 10), 100);

    expect(next.lines).toHaveLength(100);
    expect(next.lines[0].id).toBe(10);
    expect(next.lines[99].id).toBe(109);
  });

  it("counts what it dropped, so the viewer can stop being silently lossy", () => {
    let buffer = appendCapped(emptyBuffer(), lines(0, 100), 100);
    expect(buffer.dropped).toBe(0);

    buffer = appendCapped(buffer, lines(100, 10), 100);
    expect(buffer.dropped).toBe(10);

    buffer = appendCapped(buffer, lines(110, 25), 100);
    expect(buffer.dropped).toBe(35);
  });

  it("keeps only the tail of a window that is itself over the cap", () => {
    const next = appendCapped(buffered(lines(0, 5)), lines(100, 120), 100);

    expect(next.lines).toHaveLength(100);
    expect(next.lines[0].id).toBe(120);
    expect(next.dropped).toBe(25);
  });

  it("is a no-op on an empty window", () => {
    const prev = buffered(lines(0, 3), 4);
    expect(appendCapped(prev, [], 100)).toBe(prev);
  });
});

const fielded = (
  id: number,
  container: string,
  fields: Record<string, string>
) => ({ ...line(id), container, fields }) as StreamedLogLine;

/**
 * A lane attached again reads back what it wrote while it was down: lines
 * older than what the other lanes have put in the buffer since.
 */
describe("a window a lane read back", () => {
  const from = (container: string, id: number, epoch: number) =>
    ({ ...line(id, epoch), container }) as StreamedLogLine;
  const READ_BACK = true;
  const epochs = (buffer: LogBuffer) => buffer.lines.map((l) => l.epoch);
  const held = () =>
    buffered([10, 20, 30, 40, 50].map((epoch, id) => from("web", id, epoch)));

  /**
   * Appended, the lines stood after newer ones with older stamps: the pane
   * read out of order and the rate over its tail was a negative span.
   * Fails if a read-back line stands anywhere but where its timestamp says,
   * or ahead of a held line of the same instant.
   */
  it("stands where its timestamps say, after held lines of the same instant", () => {
    const back = [25, 30, 45, 60].map((epoch, i) =>
      from("api", 100 + i, epoch)
    );
    const next = appendCapped(held(), back, 100, null, READ_BACK);

    expect(epochs(next)).toEqual([10, 20, 25, 30, 30, 40, 45, 50, 60]);
    expect(next.lines[3].container).toBe("web");
    expect(next.lines[4].container).toBe("api");
    expect(next.merged).toBe(1);
  });

  /**
   * Lanes a window apart land a few milliseconds out of order all day, and
   * every reader of the buffer counts on those going to the tail. Fails if
   * a late window that is not a read-back is moved, or counted as a merge.
   */
  it("still goes to the tail when it is only late", () => {
    const next = appendCapped(held(), [from("api", 100, 45)], 100);

    expect(epochs(next)).toEqual([10, 20, 30, 40, 50, 45]);
    expect(next.merged).toBe(0);
  });

  /** Fails if a read-back with nothing older than the tail counts as a merge: a reader of the tail would start over for nothing. */
  it("is an append when nothing in it is older than the tail", () => {
    const next = appendCapped(held(), [from("api", 100, 50)], 100, null, true);

    expect(epochs(next)).toEqual([10, 20, 30, 40, 50, 50]);
    expect(next.merged).toBe(0);
  });

  /**
   * One lane's catch-up took the head, and with it other lanes' lines newer
   * than the ones it brought, under a notice that says "older lines".
   * Fails if anything but the oldest lines goes, whoever wrote them, if the
   * loss is not counted, or if the index still counts a line that went.
   */
  it("costs the oldest lines when it overflows the cap, and says how many", () => {
    const back = [5, 15, 25, 35].map((epoch, i) => from("api", 100 + i, epoch));
    const next = appendCapped(held(), back, 6, null, READ_BACK);

    expect(epochs(next)).toEqual([20, 25, 30, 35, 40, 50]);
    expect(next.dropped).toBe(3);
    expect(next.fields.values.get("container")).toEqual(
      new Map([
        ["web", 4],
        ["api", 2],
      ])
    );
  });

  /**
   * A window that fills the cap on its own replaces the buffer: right for a
   * backfill, and for a read-back it threw away every other lane's lines,
   * the newest included. Fails if a read-back as long as the cap does that.
   */
  it("does not replace the lines other lanes wrote after it", () => {
    const back = [1, 2, 3, 4, 45].map((epoch, i) =>
      from("api", 100 + i, epoch)
    );
    const next = appendCapped(held(), back, 5, null, READ_BACK);

    expect(epochs(next)).toEqual([20, 30, 40, 45, 50]);
    expect(next.dropped).toBe(5);
  });

  /** Fails if lines newer than the read-back are spared the cap while a kept interval holds the head. */
  it("takes what the cap is owed from the lines after it when the head is kept", () => {
    const frozen = { from: 10, to: 30 };
    const next = appendCapped(held(), [from("api", 100, 25)], 1, frozen, true);

    expect(epochs(next)).toEqual([10, 20, 25, 30, 50]);
    expect(next.dropped).toBe(1);
  });

  /** Fails if a kept interval's lines go to make room for a read-back. */
  it("leaves a frozen interval alone", () => {
    const frozen = { from: 10, to: 20 };
    const back = [15, 35].map((epoch, i) => from("api", 100 + i, epoch));
    const next = appendCapped(held(), back, 3, frozen, READ_BACK);

    expect(epochs(next)).toEqual([10, 15, 20, 35, 40, 50]);
    expect(next.frozenLines).toBe(3);
    expect(next.dropped).toBe(1);
  });
});

describe("a frozen interval", () => {
  const frozen = { from: 5, to: 9 };

  /** The point of freezing: the stream goes on and the held lines stay put. */
  it("keeps the frozen lines through eviction and evicts around them", () => {
    let buffer = appendCapped(emptyBuffer(), lines(0, 20), 20, frozen);
    expect(buffer.frozenLines).toBe(5);
    buffer = appendCapped(buffer, lines(20, 30), 20, frozen);
    const ids = buffer.lines.map((line) => line.id);
    expect(ids.slice(0, 5)).toEqual([5, 6, 7, 8, 9]);
    expect(ids).toHaveLength(25);
    expect(ids.slice(5)).toEqual(lines(30, 20).map((line) => line.id));
    expect(buffer.dropped).toBe(25);
    expect(buffer.frozenLines).toBe(5);
  });

  /** The cap is a budget for the live lines; the frozen ones sit outside it, never above it. */
  it("holds at most the cap of live lines beside the frozen ones", () => {
    let buffer = appendCapped(emptyBuffer(), lines(0, 20), 20, frozen);
    for (let n = 20; n < 200; n += 7) {
      buffer = appendCapped(buffer, lines(n, 7), 20, frozen);
      expect(buffer.lines.length - buffer.frozenLines).toBeLessThanOrEqual(20);
      expect(
        buffer.lines.filter((line) => line.epoch >= 5 && line.epoch <= 9)
      ).toHaveLength(5);
    }
  });

  /** A line arriving inside the interval is inside it, however late it came. */
  it("counts a late line inside the interval as frozen", () => {
    let buffer = appendCapped(emptyBuffer(), lines(0, 10), 10, frozen);
    buffer = appendCapped(buffer, [line(100, 7)], 10, frozen);
    expect(buffer.frozenLines).toBe(6);
    expect(buffer.lines.length).toBe(11);
  });

  /** Thawing hands the lines back to the cap, which takes them on the spot. */
  it("evicts down to the cap the moment the interval is thawed", () => {
    let buffer = appendCapped(emptyBuffer(), lines(0, 20), 20, frozen);
    buffer = appendCapped(buffer, lines(20, 20), 20, frozen);
    expect(buffer.lines).toHaveLength(25);
    buffer = appendCapped(buffer, [], 20, null);
    expect(buffer.lines).toHaveLength(20);
    expect(buffer.frozenLines).toBe(0);
    expect(buffer.lines[0].id).toBe(20);
    expect(buffer.dropped).toBe(20);
  });

  /** Moving the interval recounts what is held, so the status bar's number is never the old interval's. */
  it("recounts when the interval moves", () => {
    let buffer = appendCapped(emptyBuffer(), lines(0, 20), 20, frozen);
    buffer = appendCapped(buffer, [], 20, { from: 0, to: 2 });
    expect(buffer.frozenLines).toBe(3);
    expect(buffer.frozen).toEqual({ from: 0, to: 2 });
  });

  /** The index describes what is retained, frozen lines included, and not what the cap alone would keep. */
  it("keeps frozen lines in the field index", () => {
    let buffer = appendCapped(emptyBuffer(), lines(0, 20), 20, frozen);
    buffer = appendCapped(buffer, lines(20, 40), 20, frozen);
    expect(buffer.fields.keys.get("container")).toBe(25);
  });
});

describe("the field index", () => {
  it("offers level and container first, then the loudest parsed keys", () => {
    const buffer = appendCapped(
      emptyBuffer(),
      [
        fielded(1, "app", { component: "ingest", upstream: "db" }),
        fielded(2, "app", { component: "ingest" }),
        fielded(3, "sidecar", { component: "api" }),
      ],
      100
    );

    expect(fieldSuggestions(buffer.fields).map((f) => f.key)).toEqual([
      "level",
      "container",
      "component",
      "upstream",
    ]);
  });

  it("counts values so the popover can rank them", () => {
    const buffer = appendCapped(
      emptyBuffer(),
      [
        fielded(1, "app", { component: "ingest" }),
        fielded(2, "app", { component: "ingest" }),
        fielded(3, "sidecar", { component: "api" }),
      ],
      100
    );

    const component = fieldSuggestions(buffer.fields).find(
      (f) => f.key === "component"
    )!;
    expect(component.lines).toBe(3);
    expect(component.values).toEqual([
      { value: "ingest", lines: 2 },
      { value: "api", lines: 1 },
    ]);

    const container = fieldSuggestions(buffer.fields).find(
      (f) => f.key === "container"
    )!;
    expect(container.values).toEqual([
      { value: "app", lines: 2 },
      { value: "sidecar", lines: 1 },
    ]);
  });

  it("uncounts what eviction dropped, so the index describes what is left", () => {
    // The whole reason it is accumulated rather than recounted: nothing
    // walks the buffer, so the head leaving has to say so on its way out.
    let buffer = appendCapped(
      emptyBuffer(),
      [
        fielded(1, "app", { component: "ingest" }),
        fielded(2, "sidecar", { component: "api" }),
      ],
      2
    );
    buffer = appendCapped(
      buffer,
      [fielded(3, "sidecar", { component: "api" })],
      2
    );

    expect(buffer.fields.keys.get("component")).toBe(2);
    expect(buffer.fields.values.get("component")).toEqual(
      new Map([["api", 2]])
    );
    expect(buffer.fields.values.get("container")).toEqual(
      new Map([["sidecar", 2]])
    );
  });

  it("stops listing a key with one value per line, and says how many lines", () => {
    // `request_id`: listing its values is ten thousand buttons nobody
    // reads, so past the cap only the line count survives.
    const buffer = appendCapped(
      emptyBuffer(),
      Array.from({ length: MAX_TRACKED_VALUES + 10 }, (_, i) =>
        fielded(i, "app", { request_id: `r${i}` })
      ),
      1000
    );

    const wide = fieldSuggestions(buffer.fields).find(
      (f) => f.key === "request_id"
    )!;
    expect(wide.wide).toBe(true);
    expect(wide.values).toEqual([]);
    expect(wide.lines).toBe(MAX_TRACKED_VALUES + 10);
  });

  /**
   * `pod` and `container` are the lane identity, not parsed fields: the
   * legend draws a chip per value and reads its count from here. Dropped
   * at the cap, every chip's count reads zero and a pod that has left the
   * list vanishes with its lines still in the buffer — which a DaemonSet
   * on sixty nodes reaches on its first read.
   */
  it("never stops counting the lanes, however many pods a workload has", () => {
    const buffer = appendCapped(
      emptyBuffer(),
      Array.from({ length: MAX_TRACKED_VALUES + 10 }, (_, i) => ({
        ...line(i),
        pod: `api-${i}`,
        container: `c${i}`,
      })) as StreamedLogLine[],
      1000
    );

    expect(buffer.fields.values.get("pod")?.size).toBe(MAX_TRACKED_VALUES + 10);
    expect(buffer.fields.values.get("container")?.size).toBe(
      MAX_TRACKED_VALUES + 10
    );
    expect(buffer.fields.values.get("pod")?.get("api-0")).toBe(1);
  });

  it("never offers the key the message itself was parsed out of", () => {
    const buffer = appendCapped(
      emptyBuffer(),
      [fielded(1, "app", { msg: "hello", severity: "high", trace: "abc" })],
      100
    );

    expect(fieldSuggestions(buffer.fields).map((f) => f.key)).toEqual([
      "level",
      "container",
      "trace",
    ]);
  });

  it("hands back a fresh index object so a memo on it re-runs", () => {
    const first = appendCapped(emptyBuffer(), lines(0, 2), 100);
    const second = appendCapped(first, lines(2, 2), 100);
    expect(second.fields).not.toBe(first.fields);
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

describe("how much room history gets beside the live lines", () => {
  /**
   * The cap counts what it may evict. Frozen lines are what it may not, and
   * the status bar already says so — counting them twice made freezing an
   * interval wipe the history the reader had just fetched, with the bar
   * blaming the live stream for filling the buffer.
   */
  it("measures the cap against the lines the cap can evict", () => {
    expect(historyRoom(20_000, 17_000, 0)).toBe(3_000);
    expect(historyRoom(20_000, 22_000, 5_000)).toBe(3_000);
  });

  /** A buffer genuinely full of evictable lines leaves no room, as before. */
  it("leaves none when the evictable lines fill the cap", () => {
    expect(historyRoom(5_000, 5_000, 0)).toBe(0);
    expect(historyRoom(5_000, 9_000, 1_000)).toBe(0);
  });
});

describe("where the buffer lost lines", () => {
  /**
   * Three readers said "older lines have been dropped" off `dropped > 0`
   * alone — the notice, the strip's axis and its spoken summary. With an
   * interval frozen that is the wrong end: eviction steps over the frozen
   * lines and takes what is around them, so the reader looking before the
   * left edge for the missing lines finds the frozen block instead.
   */
  it("calls the loss a head only while nothing is frozen", () => {
    const frozen = { from: 1_000, to: 2_000 };
    expect(lostLines(0, null)).toBe("none");
    expect(lostLines(0, frozen)).toBe("none");
    expect(lostLines(40, null)).toBe("head");
    expect(lostLines(40, frozen)).toBe("aroundKept");
  });
});
