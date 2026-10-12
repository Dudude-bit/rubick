// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const saveThemeConfig = vi.fn((_config: { theme: string }) =>
  Promise.resolve()
);
vi.mock("@/lib/commands", () => ({
  commands: {
    getThemeConfig: () => new Promise(() => {}),
    saveThemeConfig: (config: { theme: string }) => saveThemeConfig(config),
  },
}));
const toastError = vi.fn();
vi.mock("@/lib/toast-error", () => ({
  toastError: (title: string, error: unknown) => toastError(title, error),
}));

const { followTheme, useThemeStore } = await import("./themeStore");

afterEach(() => {
  useThemeStore.setState({ theme: "dark" });
  saveThemeConfig.mockReset();
  saveThemeConfig.mockImplementation(() => Promise.resolve());
  toastError.mockReset();
});

describe("a theme chosen from the menu", () => {
  /**
   * Dana's switch landed about 1.2 s after the click: the window was
   * repainted from an effect, after the whole app rendered again. Fails if
   * the click that chose a theme returns with the window still in the old one.
   */
  it("is painted in the click that chose it", async () => {
    vi.stubGlobal("requestAnimationFrame", () => 0);
    const stop = followTheme();
    const saved = useThemeStore.getState().setTheme("light");
    expect(document.documentElement.classList.contains("light")).toBe(true);
    stop();
    void useThemeStore.getState().setTheme("dark");
    expect(document.documentElement.classList.contains("light")).toBe(true);
    await saved;
    vi.unstubAllGlobals();
  });

  /**
   * The window is in the new theme before the disk has it, so a save that
   * fails would otherwise only show at the next start, in the old one.
   * Fails if a failed save says nothing.
   */
  it("says so when its save fails", async () => {
    saveThemeConfig.mockRejectedValue({ code: "CONFIG", message: "disk full" });
    await useThemeStore.getState().setTheme("light");
    expect(toastError).toHaveBeenCalledOnce();
    expect(toastError.mock.calls[0][0]).toBe(
      "Theme not saved, so the next start opens in the previous one"
    );
    expect(useThemeStore.getState().theme).toBe("light");
  });

  /**
   * Saves run in the background now, and two that ran side by side could
   * land in either order. Fails if a second switch is written before the
   * first save answers, or the disk ends on any theme but the last chosen.
   */
  it("is saved after the one before it, and the last choice last", async () => {
    const answers: Array<() => void> = [];
    saveThemeConfig.mockImplementation(
      () => new Promise<void>((resolve) => answers.push(resolve))
    );
    const done = useThemeStore.getState().setTheme("light");
    void useThemeStore.getState().setTheme("system");
    void useThemeStore.getState().setTheme("dark");
    expect(saveThemeConfig.mock.calls.map(([config]) => config.theme)).toEqual([
      "light",
    ]);
    answers[0]();
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    answers[1]();
    await done;
    expect(saveThemeConfig.mock.calls.map(([config]) => config.theme)).toEqual([
      "light",
      "dark",
    ]);
  });
});
