import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const PRIMITIVES = [
  "src/components/ui/dialog.tsx",
  "src/components/ui/alert-dialog.tsx",
];

describe("every dialog panel is bounded by the window", () => {
  /**
   * A dialog is centred, so a body the cluster decides the length of grows
   * off **both** edges and takes the ✕ and the buttons with it — and nothing
   * scrolls, because Radix locks the page behind the panel and a `fixed` box
   * cannot be scrolled into view. Three call sites had bounded themselves by
   * hand and the rest had not. Read as source text: jsdom computes no layout.
   */
  it.each(PRIMITIVES)("%s keeps its content reachable", (path) => {
    const panel = readFileSync(path, "utf8")
      .split("\n")
      .find((line) => line.includes("fixed left-[50%] top-[50%]"));
    expect(panel, `${path} has no centred panel class`).toBeDefined();
    expect(panel).toContain("max-h-[calc(100vh-2rem)]");
    expect(panel).toContain("overflow-y-auto");
    expect(panel).toContain("scrollbar-thin");
  });
});
