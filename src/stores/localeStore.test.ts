import { beforeEach, describe, expect, it, vi } from "vitest";

describe("switching language", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  /**
   * The Russian catalogue is loaded on demand now, and `translate` falls back
   * to English for a language it has no catalogue for. A switch recorded
   * before the catalogue arrived would draw the next screen in English with
   * nothing saying why.
   */
  it("switches only once the language's catalogue has arrived", async () => {
    const i18n = await import("@/i18n");
    const { useLocaleStore } = await import("./localeStore");
    expect(i18n.isLoaded("ru")).toBe(false);

    const loadedWhenSwitched: boolean[] = [];
    useLocaleStore.subscribe((state) => {
      if (state.choice === "ru") loadedWhenSwitched.push(i18n.isLoaded("ru"));
    });
    await useLocaleStore.getState().setChoice("ru");

    expect(loadedWhenSwitched).toEqual([true]);
    expect(i18n.translate("ru", "action", "cancel")).not.toBe(
      i18n.translate("en", "action", "cancel")
    );
  });

  /** The picker lists a language by whether it has one, not whether it is loaded yet. */
  it("offers a language before its catalogue is loaded", async () => {
    const i18n = await import("@/i18n");
    expect(i18n.isLoaded("ru")).toBe(false);
    expect(i18n.isTranslated("ru")).toBe(true);
    expect(i18n.isTranslated("de")).toBe(false);
  });
});
