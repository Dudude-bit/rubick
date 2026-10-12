// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@/lib/commands", () => ({
  commands: {
    getThemeConfig: () => new Promise(() => {}),
    saveThemeConfig: () => new Promise(() => {}),
  },
}));

const { followTheme, useThemeStore } = await import("./themeStore");

afterEach(() => useThemeStore.setState({ theme: "dark" }));

describe("a theme chosen from the menu", () => {
  /**
   * Dana's switch landed about 1.2 s after the click: the window was
   * repainted from an effect, after the whole app rendered again. Fails if
   * the click that chose a theme returns with the window still in the old one.
   */
  it("is painted in the click that chose it", () => {
    vi.stubGlobal("requestAnimationFrame", () => 0);
    const stop = followTheme();
    void useThemeStore.getState().setTheme("light");
    expect(document.documentElement.classList.contains("light")).toBe(true);
    stop();
    void useThemeStore.getState().setTheme("dark");
    expect(document.documentElement.classList.contains("light")).toBe(true);
    vi.unstubAllGlobals();
  });
});
