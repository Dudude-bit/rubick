import { describe, expect, it } from "vite-plus/test";

import { fitStrip, fitTabs, squeeze } from "./tab-fit";

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

  /**
   * Dana clicked Events and the shell tab left the strip, so her next click
   * landed on cart-crjnn. Fails if opening a tab that is already in the
   * strip changes which tabs the strip shows.
   */
  it("moves nothing when the tab opened is already in the strip", () => {
    const before = [true, false, false, true];
    expect(
      fitTabs({
        widths: WIDTHS,
        room: 260,
        gap: 16,
        menu: 50,
        open: 0,
        shown: before,
      })
    ).toEqual(before);
  });

  /** Fails if a tab picked from the menu pushes out more of the strip than it needs, or the wrong end of it. */
  it("gives up only the last tab in the strip for one picked from the menu", () => {
    expect(
      fitTabs({
        widths: [60, 60, 60, 60, 60],
        room: 300,
        gap: 4,
        menu: 50,
        open: 4,
        shown: [true, true, true, false, false],
      })
    ).toEqual([true, true, false, false, true]);
  });
});

describe("squeeze", () => {
  /**
   * "team-check…" sat beside a 180px object name. Fails if a part shorter
   * than the length the long ones are cut to is cut at all.
   */
  it("cuts the longest parts first, to one length, and leaves the short ones whole", () => {
    expect(
      squeeze(
        [
          { natural: 80, floor: 40 },
          { natural: 180, floor: 72 },
          { natural: 120, floor: 72 },
        ],
        300
      )
    ).toEqual([80, 110, 110]);
  });

  /** Fails if a part is drawn under its floor when the room runs out. */
  it("stops every part at its floor", () => {
    expect(
      squeeze(
        [
          { natural: 180, floor: 72 },
          { natural: 50, floor: 50 },
        ],
        40
      )
    ).toEqual([72, 50]);
  });
});

describe("fitStrip", () => {
  const tab = (chrome: number, ...parts: [number, number][]) => ({
    chrome,
    parts: parts.map(([natural, floor]) => ({ natural, floor })),
  });

  /**
   * Lena at 1024: "payments…rf746" open, and the tab beside it read
   * "team-check… / Обзор" with blank room before its close button. Fails if
   * the short namespace is cut while the long object name still has
   * characters to give, or a shown tab is drawn wider than its own label.
   */
  it("cuts the long object name and leaves the short namespace whole", () => {
    const { shown, widths } = fitStrip({
      tabs: [tab(60, [40, 40], [180, 72]), tab(60, [80, 80], [35, 35])],
      room: 400,
      gap: 4,
      menu: 60,
      open: 0,
      cap: 416,
    });
    expect(shown).toEqual([true, true]);
    expect(widths[1]).toEqual([80, 35]);
    expect(widths[0][1]).toBeLessThan(180);
    expect(widths[0][1]).toBeGreaterThanOrEqual(72);
    expect(60 + 40 + widths[0][1] + 4 + 60 + 80 + 35).toBeLessThanOrEqual(400);
  });

  /** Fails if a tab is drawn wider than the cap however long its label. */
  it("holds a tab to the cap", () => {
    const { widths } = fitStrip({
      tabs: [tab(60, [80, 80], [500, 72])],
      room: 2000,
      gap: 4,
      menu: 60,
      open: 0,
      cap: 416,
    });
    expect(60 + widths[0][0] + widths[0][1]).toBeLessThanOrEqual(416);
    expect(widths[0][0]).toBe(80);
  });

  /** Fails if a tab that only fits with its short names cut is kept in the strip rather than named in the menu. */
  it("sends to the menu a tab that would need a short name cut", () => {
    const { shown, widths } = fitStrip({
      tabs: [
        tab(60, [80, 80], [50, 50]),
        tab(60, [80, 80], [50, 50]),
        tab(60, [80, 80], [50, 50]),
      ],
      room: 500,
      gap: 4,
      menu: 60,
      open: 0,
      cap: 416,
    });
    expect(shown).toEqual([true, true, false]);
    expect(widths.slice(0, 2)).toEqual([
      [80, 50],
      [80, 50],
    ]);
  });
});
