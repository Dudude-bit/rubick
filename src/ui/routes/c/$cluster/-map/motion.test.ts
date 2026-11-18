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
   * on moving in a window that had lost focus. Fails if a rule that starts
   * the dashes sets the play state, by name or through the shorthand.
   */
  it("are started in longhands, so only the pause sets their play state", () => {
    const moving = rules.filter((rule) =>
      /animation(-name)?:\s*map-flow/.test(rule.body)
    );
    expect(moving.length).toBeGreaterThan(0);
    for (const rule of moving) {
      expect(rule.body).not.toMatch(/animation:\s/);
      expect(rule.body).not.toMatch(/animation-play-state/);
    }
    const pauses = rules
      .filter((rule) => /animation-play-state:\s*paused/.test(rule.body))
      .map((rule) => rule.selector)
      .join(" ");
    expect(pauses).toContain("[data-paused]");
    expect(pauses).toContain("[data-unfocused]");
  });
});
