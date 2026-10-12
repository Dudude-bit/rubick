// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { applyTheme, cachedTheme } from "./theme";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = "";
  document.documentElement.removeAttribute("style");
});

describe("the theme the window opens in", () => {
  /** The default theme is dark; a first launch must not open light. */
  it("is dark before any theme was ever applied", () => {
    expect(cachedTheme()).toBe("dark");
  });

  /**
   * The backend's setting arrives after the first render. Without the
   * cached one, a light-theme window opened dark and then jumped.
   */
  it("is the last one applied, read before the backend answers", () => {
    applyTheme("light");
    expect(cachedTheme()).toBe("light");
    const root = document.documentElement;
    expect(root.classList.contains("light")).toBe(true);
    expect(root.classList.contains("dark")).toBe(false);
    expect(root.style.colorScheme).toBe("light");
  });

  it("follows the system when asked to", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(prefers-color-scheme: dark)",
    }));
    applyTheme("system");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(cachedTheme()).toBe("system");
    vi.unstubAllGlobals();
  });
});

describe("a change of tone", () => {
  const css = readFileSync("src/ui/index.css", "utf8");
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
    ([, selector, body]) => ({
      selectors: selector
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split(",")
        .map((part) => part.trim()),
      body,
    })
  );
  const fades = (body: string) =>
    /transition(-property)?\s*:[^;]*\b(all|color|background|background-color|border|border-color|fill|stroke)\b/.test(
      body
    );

  /**
   * A fade's first frame is the old colour: a ready pod's dot stayed amber
   * for a repaint, and a switched window kept the last cluster's red accent
   * for over a second. Fails if any rule on `*` fades a colour again.
   */
  it("never fades a colour on every element", () => {
    const everything = rules.filter(({ selectors }) =>
      selectors.some((part) => /^\*(::before|::after)?$/.test(part))
    );
    expect(everything.length).toBeGreaterThan(0);
    for (const { selectors, body } of everything)
      expect(fades(body), selectors.join(", ")).toBe(false);
  });

  /**
   * Sam's Service went from red "no endpoints" to blue "coming up", and the
   * clock beside the blue words was still red. Fails if a theme switch stops
   * fading words and glyphs together with their backgrounds.
   */
  it("fades words, glyphs and backgrounds together only under a theme switch", () => {
    const themed = rules.find(({ selectors }) =>
      selectors.includes(".theme-fade *")
    );
    expect(themed?.body).toMatch(
      /transition-property:\s*background-color, border-color, color, fill, stroke;/
    );
    expect(themed?.body).toMatch(/transition-duration:\s*150ms/);
  });

  /** Fails if a hover affordance loses the background fade it had when every element faded. */
  it("keeps the background fade on what changes it on hover", () => {
    const hover = rules.find(({ selectors }) =>
      selectors.some((part) => part.includes('[class*="hover:bg-"]'))
    );
    expect(hover && fades(hover.body)).toBe(true);
  });

  /** The frames the window draws, one at a time, however long each takes. */
  const frames = () => {
    const queued: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) =>
      queued.push(run)
    );
    return () => queued.splice(0).forEach((run) => run(0));
  };

  /** Fails if a switch between themes does not fade, or the fade outlives it. */
  it("fades for the switch between themes alone, not on the first paint", () => {
    vi.useFakeTimers();
    const draw = frames();
    const root = document.documentElement;
    applyTheme("dark");
    expect(root.classList.contains("theme-fade")).toBe(false);

    applyTheme("light");
    expect(root.classList.contains("theme-fade")).toBe(true);
    draw();
    draw();
    vi.advanceTimersByTime(250);
    expect(root.classList.contains("theme-fade")).toBe(false);

    applyTheme("light");
    expect(root.classList.contains("theme-fade")).toBe(false);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /**
   * Dana's switch was a hard cut 1.2 s after the click: the fade was taken
   * away 200 ms after the switch, while the first frame in the new theme was
   * still being drawn, so no frame ever faded. Fails if the fade ends before
   * the switched frame is drawn, or a second switch is cut by the first's end.
   */
  it("keeps fading until the frame in the new theme is drawn, however late", () => {
    vi.useFakeTimers();
    const draw = frames();
    const root = document.documentElement;
    applyTheme("dark");
    applyTheme("light");
    vi.advanceTimersByTime(1200);
    expect(root.classList.contains("theme-fade")).toBe(true);
    draw();
    draw();
    vi.advanceTimersByTime(100);
    applyTheme("dark");
    vi.advanceTimersByTime(150);
    expect(root.classList.contains("theme-fade")).toBe(true);
    draw();
    draw();
    vi.advanceTimersByTime(250);
    expect(root.classList.contains("theme-fade")).toBe(false);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});

const hex = (hsl: string) => {
  const [h, s, l] = hsl.split(/\s+/).map(parseFloat);
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    const value = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(value * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
};

describe("the colour of the first frame", () => {
  /**
   * The native window, the page before its stylesheet, and the dark canvas
   * are one colour written in three files. A canvas changed in index.css
   * alone would flash the old colour on every launch.
   */
  it("is the dark canvas in the window config and the page", () => {
    const css = readFileSync("src/ui/index.css", "utf8");
    const dark = css.slice(css.indexOf(".dark {"));
    const canvas = /--canvas:\s*([\d.]+ [\d.]+% [\d.]+%)/.exec(dark)?.[1];
    expect(canvas).toBeTruthy();
    const expected = hex(canvas!);

    const config = JSON.parse(
      readFileSync("src/tauri/tauri.conf.json", "utf8")
    );
    expect(config.app.windows[0].backgroundColor).toBe(expected);

    const page = readFileSync("src/ui/index.html", "utf8");
    expect(page).toContain(`background-color: ${expected}`);
  });
});
