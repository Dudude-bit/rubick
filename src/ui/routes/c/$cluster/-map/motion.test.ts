import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

/** Every rule of `src/ui/index.css` as its selector and body, comments dropped. */
const rules = [
  ...readFileSync("src/ui/index.css", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .matchAll(/([^{}]+)\{([^{}]*)\}/g),
].map(([, selector, body]) => ({ selector: selector.trim(), body }));

describe("the map's flowing dashes", () => {
  /**
   * The hovered edge's rule outranks the pause, and an `animation`
   * shorthand there resets the play state to running: a hovered edge went
   * on moving in a window that had lost focus. Fails if any rule over the
   * edges, or any rule that starts the dashes whatever it selects, sets the
   * play state by name or through a shorthand, in any order,
   * other than the pause and `animation: none`.
   */
  it("are started in longhands, so only the pause sets their play state", () => {
    const starts = /animation(-name)?:[^;}]*\bmap-flow\b/;
    const edges = rules.filter(
      (rule) =>
        /\.map-flow|react-flow__edge/.test(rule.selector) ||
        starts.test(rule.body)
    );
    expect(
      edges.some((rule) => /animation-name:\s*map-flow/.test(rule.body))
    ).toBe(true);
    for (const rule of edges) {
      for (const [, value] of rule.body.matchAll(
        /(?:^|[;{\s])animation:\s*([^;}]+)/g
      ))
        expect(value.trim(), rule.selector).toBe("none");
      for (const [, value] of rule.body.matchAll(
        /animation-play-state:\s*([^;}]+)/g
      ))
        expect(value.trim(), rule.selector).toBe("paused");
    }
    const pauses = rules
      .filter((rule) => /animation-play-state:\s*paused/.test(rule.body))
      .map((rule) => rule.selector)
      .join(" ");
    expect(pauses).toContain("[data-paused]");
    expect(pauses).toContain("[data-unfocused]");
  });
});
