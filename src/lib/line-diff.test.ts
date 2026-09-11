import { describe, expect, it } from "vitest";

import { computeLineDiff, type DiffLine } from "./line-diff";

/** Both sides, rebuilt from the diff: the one property every diff must keep. */
function rebuild(lines: DiffLine[]) {
  return {
    original: lines
      .filter((line) => line.type !== "added")
      .map((line) => line.content)
      .join("\n"),
    modified: lines
      .filter((line) => line.type !== "removed")
      .map((line) => line.content)
      .join("\n"),
  };
}

const A = [
  "apiVersion: v1",
  "kind: ConfigMap",
  "metadata:",
  "  name: a",
  "data:",
  '  x: "1"',
  '  y: "2"',
].join("\n");
const B = [
  "apiVersion: v1",
  "kind: ConfigMap",
  "metadata:",
  "  name: a",
  "  labels:",
  "    team: shop",
  "data:",
  '  x: "1"',
  '  y: "3"',
].join("\n");

describe("the line diff", () => {
  it("rebuilds both sides from what it drew", () => {
    const lines = computeLineDiff(A, B);
    expect(rebuild(lines)).toEqual({ original: A, modified: B });
  });

  it("marks an insertion and a change as such, and nothing else", () => {
    const lines = computeLineDiff(A, B);
    expect(
      lines.filter((l) => l.type === "added").map((l) => l.content)
    ).toEqual(["  labels:", "    team: shop", '  y: "3"']);
    expect(
      lines.filter((l) => l.type === "removed").map((l) => l.content)
    ).toEqual(['  y: "2"']);
    expect(lines.filter((l) => l.type === "unchanged")).toHaveLength(6);
  });

  it("calls identical texts unchanged and an empty side all one kind", () => {
    expect(computeLineDiff(A, A).every((l) => l.type === "unchanged")).toBe(
      true
    );
    expect(computeLineDiff("", "a\nb").map((l) => l.type)).toEqual([
      "removed",
      "added",
      "added",
    ]);
    expect(computeLineDiff("a\nb", "").map((l) => l.type)).toEqual([
      "removed",
      "removed",
      "added",
    ]);
  });

  /**
   * The reason for the algorithm: an edit of three lines in a long file is
   * three passes, not a table over the whole of it. Timed loosely, because
   * the point is that it finishes at all in the frame budget the plan sets.
   */
  it("diffs a long manifest with a small edit within the frame budget", () => {
    const long = Array.from(
      { length: 4000 },
      (_, i) => `  key${i}: value${i}`
    ).join("\n");
    const edited = long
      .replace("key2000: value2000", "key2000: changed")
      .replace("key3999: value3999", "key3999: value3999\n  extra: yes");
    const started = performance.now();
    const lines = computeLineDiff(long, edited);
    const took = performance.now() - started;
    expect(rebuild(lines)).toEqual({ original: long, modified: edited });
    expect(lines.filter((l) => l.type !== "unchanged")).toHaveLength(3);
    expect(took).toBeLessThan(100);
  });
});
