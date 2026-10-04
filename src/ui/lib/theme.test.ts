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
