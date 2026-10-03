import { describe, expect, it } from "vitest";

import {
  BIG_ANSWER_ROWS,
  BIG_LIST_ROWS,
  STALL_WINDOW_MS,
  StallWatch,
} from "./stall-watch";

describe("StallWatch", () => {
  /** A stall from two minutes ago is not why the app is slow now. */
  it("keeps the last minute of stalls and names the longest", () => {
    let now = 100_000;
    const watch = new StallWatch(() => now);
    watch.noteStall(80);
    now += 30_000;
    watch.noteStall(320);
    now += STALL_WINDOW_MS;
    watch.noteStall(60);
    const report = watch.report();
    expect(report.stalls.map((s) => s.ms)).toEqual([320, 60]);
    expect(report.longest?.ms).toBe(320);
  });

  /** An answer is remembered by its length and nothing else about it is looked at. */
  it("remembers only big answers, by row count, and the biggest of them", () => {
    const watch = new StallWatch(() => 1_000);
    watch.noteAnswer("list_pods", new Array(12_000).fill(0));
    watch.noteAnswer("list_services", new Array(30).fill(0));
    watch.noteAnswer("get_pod", { name: "a" });
    watch.noteAnswer("list_events", new Array(4_000).fill(0));
    expect(watch.report().largest).toEqual({
      name: "list_pods",
      rows: 12_000,
      at: 1_000,
    });
  });

  /**
   * A page's list answers `{ rows, unread }` now. Counted as an array only,
   * every big list in the app went past with "nothing over a thousand rows".
   */
  it("counts a scoped list by its rows", () => {
    const watch = new StallWatch(() => 1_000);
    watch.noteAnswer("list_deployments_in", {
      rows: new Array(5_000).fill(0),
      unread: [],
    });
    expect(watch.report().largest?.rows).toBe(5_000);
  });

  it("lists the big tables on screen, largest first, and forgets one that unmounts", () => {
    const watch = new StallWatch(() => 0);
    watch.noteList("pods", "pods", 10_400);
    watch.noteList("events", "events", 2_300);
    watch.noteList("nodes", "nodes", 12);
    expect(watch.report().lists.map((l) => [l.label, l.rows])).toEqual([
      ["pods", 10_400],
      ["events", 2_300],
    ]);
    watch.forgetList("pods");
    expect(watch.report().lists.map((l) => l.label)).toEqual(["events"]);
  });

  /**
   * Both thresholds are "this many or more". Written against the constants
   * so the boundary moves with them; the counts elsewhere in this file are
   * far enough from it to say nothing about which side of it counts.
   */
  it("counts a list and an answer at the threshold and not one row under it", () => {
    const watch = new StallWatch(() => 0);
    watch.noteList("at", "pods", BIG_LIST_ROWS);
    watch.noteList("under", "events", BIG_LIST_ROWS - 1);
    watch.noteAnswer("list_pods", new Array(BIG_ANSWER_ROWS).fill(0));
    watch.noteAnswer("list_events", new Array(BIG_ANSWER_ROWS - 1).fill(0));
    const report = watch.report();
    expect(report.lists.map((l) => l.rows)).toEqual([BIG_LIST_ROWS]);
    expect(report.largest?.name).toBe("list_pods");
  });

  /** A table that was big and is not any more is not a reason for anything. */
  it("stops naming a list once it falls back under the threshold", () => {
    const watch = new StallWatch(() => 0);
    watch.noteList("pods", "pods", 4_000);
    watch.noteList("pods", "pods", 12);
    expect(watch.report().lists).toEqual([]);
  });
});
