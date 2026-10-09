import { describe, expect, it } from "vite-plus/test";

import { fitTabs } from "./tab-fit";

const WIDTHS = [80, 84, 64, 44];

describe("fitTabs", () => {
  /** Fails if a strip with room for every tab hides one behind a menu. */
  it("shows every tab when they all fit", () => {
    expect(
      fitTabs({ widths: WIDTHS, room: 320, gap: 16, menu: 50, open: 0 })
    ).toEqual([true, true, true, true]);
  });

  /**
   * Lena read "Проверка се" beside "ещё 6", which listed it too. Fails if a
   * tab that does not fit whole beside the menu is shown, or the tabs shown
   * stop being the first ones in order.
   */
  it("shows the tabs that fit whole beside the menu, in order", () => {
    expect(
      fitTabs({ widths: WIDTHS, room: 260, gap: 16, menu: 50, open: 0 })
    ).toEqual([true, true, false, false]);
  });

  /** Fails if the open tab is left to the menu while the strip could show it. */
  it("keeps the open tab in the strip, giving up the tabs before it that no longer fit", () => {
    expect(
      fitTabs({ widths: WIDTHS, room: 260, gap: 16, menu: 50, open: 3 })
    ).toEqual([true, false, false, true]);
  });

  /** Fails if a tab wider than the strip itself is drawn cut rather than left to the menu. */
  it("leaves to the menu an open tab the strip cannot hold at all", () => {
    expect(
      fitTabs({ widths: WIDTHS, room: 100, gap: 16, menu: 50, open: 1 })
    ).toEqual([false, false, false, false]);
  });
});
