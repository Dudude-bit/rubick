import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const PRIMITIVES = [
  "src/components/ui/dialog.tsx",
  "src/components/ui/alert-dialog.tsx",
];

describe("every dialog panel is bounded by the window", () => {
  /**
   * A dialog is centred with `translate-y-[-50%]`, so a body the cluster
   * decides the length of — the pods a drain refused, the Services a connect
   * form matched — grows off **both** edges: the title and the ✕ leave the
   * top, the buttons the bottom, and nothing scrolls, because Radix locks the
   * page behind the panel and a `fixed` box cannot be scrolled into view by
   * any ancestor. Three call sites had bounded themselves by hand and the
   * rest had not, which is what makes it the primitive's job.
   *
   * Read as source text: the class string is the whole contract, and jsdom
   * computes no layout.
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
