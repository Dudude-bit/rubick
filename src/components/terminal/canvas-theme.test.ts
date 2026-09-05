import { afterEach, describe, expect, it, vi } from "vitest";

import { readCanvasTheme } from "./canvas-theme";

const TOKENS: Record<string, string> = {
  "--canvas": "220 8% 13%",
  ...Object.fromEntries(
    Array.from({ length: 16 }, (_, i) => [`--ansi-${i}`, `${i * 20} 50% 50%`])
  ),
};

/**
 * A `getComputedStyle` that answers a re-read of one element with the colour
 * it gave the first time — which is what a browser does, and what a single
 * reused probe element trips over.
 */
function stubComputedStyle(colourFor: (asked: number) => string) {
  const answered = new WeakMap<Element, string>();
  let asked = 0;
  vi.stubGlobal("getComputedStyle", (element: Element) => {
    if (element === document.documentElement) {
      return {
        getPropertyValue: (name: string) => TOKENS[name] ?? "",
      } as unknown as CSSStyleDeclaration;
    }
    if (!answered.has(element)) {
      answered.set(element, colourFor(asked));
      asked += 1;
    }
    return { color: answered.get(element) } as unknown as CSSStyleDeclaration;
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reading the terminal palette out of the theme tokens", () => {
  /**
   * Resolving all seventeen colours through one probe element returns the
   * first one seventeen times, because the computed style a browser hands
   * back does not follow an inline colour overwritten in the same task. Every
   * ANSI slot became the canvas colour and a shell printing in colour printed
   * nothing visible. Each colour needs its own element.
   */
  it("gives every slot its own colour and not the first one sixteen times", () => {
    stubComputedStyle((asked) => `rgb(${asked}, 0, 0)`);

    const { background, ansi } = readCanvasTheme();

    expect(background).toBe("rgb(0, 0, 0)");
    expect(ansi).toHaveLength(16);
    expect(new Set(ansi).size).toBe(16);
  });

  /**
   * The failure above is silent: sixteen well-formed colour strings, all of
   * them the background. Handing xterm none of them leaves it its own
   * palette, which is the wrong colours rather than no colours at all.
   */
  it("refuses a palette whose every slot is the background colour", () => {
    stubComputedStyle(() => "rgb(30, 32, 36)");

    const { background, ansi } = readCanvasTheme();

    expect(background).toBe("rgb(30, 32, 36)");
    expect(ansi).toEqual([]);
  });
});
