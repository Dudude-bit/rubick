import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const PRIMITIVES = [
  "src/ui/components/ui/dialog.tsx",
  "src/ui/components/ui/alert-dialog.tsx",
];

describe("every dialog panel is bounded by the window", () => {
  /**
   * A body the cluster decides the length of grew off the window's edge and
   * took the ✕ and the buttons with it, and nothing scrolls, because Radix
   * locks the page behind the panel. Read as source text: jsdom computes no
   * layout.
   */
  it.each(PRIMITIVES)("%s keeps its content reachable", (path) => {
    const panel = readFileSync(path, "utf8")
      .split("\n")
      .find((line) => line.includes("fixed left-[50%] top-[12vh]"));
    expect(panel, `${path} has no panel class`).toBeDefined();
    expect(panel).toContain("max-h-[calc(88vh-2rem)]");
    expect(panel).toContain("overflow-y-auto");
    expect(panel).toContain("scrollbar-lane");
  });

  /**
   * A centred dialog moved its buttons under the pointer whenever an answer
   * was written into it; anchored at the top it grows downward only. A grid
   * column that cannot shrink let one long path push the input and Delete
   * past the dialog's edge. Fails if either comes back.
   */
  it.each(PRIMITIVES)(
    "%s grows downward and lets its content shrink",
    (path) => {
      const panel = readFileSync(path, "utf8")
        .split("\n")
        .find((line) => line.includes("fixed left-[50%] top-[12vh]"));
      expect(panel).toContain("translate-y-0");
      expect(panel).not.toContain("top-[50%]");
      expect(panel).toContain("grid-cols-[minmax(0,1fr)]");
    }
  );
});
