import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * A dialog is centred with `translate-y-[-50%]`, so a body the cluster
 * decides the length of — the pods a drain refused, the Services a connect
 * form matched, a message a controller wrote — grows off **both** edges of
 * the window. The title and the ✕ leave the top, the buttons leave the
 * bottom, and nothing scrolls: Radix locks the page behind the panel, and a
 * `position: fixed` box cannot be scrolled into view by any ancestor.
 *
 * Three call sites had each bounded themselves by hand (`max-h-[80vh]`,
 * `h-[85vh]`, `h-[600px]`) and the rest had not, which is what made it a
 * property of the primitive rather than of any one dialog.
 *
 * Read as source text on purpose: the class string is the whole contract,
 * and rendering it in jsdom would assert nothing, since jsdom computes no
 * layout and Tailwind's classes are not stylesheets here.
 */

const PRIMITIVES = [
  "src/components/ui/dialog.tsx",
  "src/components/ui/alert-dialog.tsx",
];

describe("every dialog panel is bounded by the window", () => {
  it.each(PRIMITIVES)("%s keeps its content reachable", (path) => {
    const source = readFileSync(path, "utf8");
    const panel = source
      .split("\n")
      .find((line) => line.includes("fixed left-[50%] top-[50%]"));
    expect(panel, `${path} has no centred panel class`).toBeDefined();
    // A ceiling, so it cannot grow past the window…
    expect(panel).toContain("max-h-[calc(100vh-2rem)]");
    // …and a way to reach what does not fit, styled like every other
    // scroller in the app rather than the platform's default.
    expect(panel).toContain("overflow-y-auto");
    expect(panel).toContain("scrollbar-thin");
  });
});
