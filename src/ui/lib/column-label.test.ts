import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import { en as englishWords } from "@/i18n/catalogue";
import { columnHeader } from "@/i18n/column-header";
import { ru as russianWords } from "@/i18n/ru";
import type { T } from "@/i18n/useT";
import { columnFloor, headerFloor } from "./column-label";

const ru: T = (section, key, values) => translate("ru", section, key, values);

describe("the room a header needs", () => {
  /**
   * Lena's Pods table read "Готовн...", "Перезапу..." and "Возр..." with room
   * to spare. Fails if a floor stops covering the whole label, and the sort
   * mark beside it where the header is a sort control.
   */
  it("covers the whole label, and the sort mark of a sortable one", () => {
    expect(headerFloor({ header: columnHeader("columns", "age") }, ru)).toBe(
      Math.ceil("Возраст".length * 7 + 5 + 20)
    );
    expect(
      headerFloor(
        {
          header: () => null,
          meta: { label: { section: "columns", key: "restarts" } },
        },
        ru
      )
    ).toBe(Math.ceil("Перезапуски".length * 7 + 5 + 24 + 20));
  });

  /** Fails if a column with no words in its header claims room for some. */
  it("needs nothing for a header with no words", () => {
    expect(headerFloor({ header: () => null }, ru)).toBe(0);
  });
});

/**
 * Advance widths in thousandths of an em of Inter at weight 500, read from the
 * font file the app ships (`@fontsource-variable/inter`, wght axis at 500) for
 * every character in the `columns` labels of both catalogues.
 */
const ADVANCE: Record<string, number> = {
  " ": 267,
  "%": 993,
  ",": 303,
  "-": 462,
  ".": 303,
  "/": 370,
  A: 709,
  B: 657,
  C: 733,
  D: 722,
  E: 603,
  F: 589,
  G: 748,
  H: 745,
  I: 272,
  K: 688,
  L: 565,
  M: 913,
  N: 756,
  O: 767,
  P: 642,
  R: 648,
  S: 646,
  T: 653,
  U: 740,
  V: 709,
  W: 1003,
  Z: 641,
  a: 568,
  b: 618,
  c: 577,
  d: 618,
  e: 587,
  f: 379,
  g: 620,
  h: 602,
  i: 252,
  j: 252,
  k: 559,
  l: 252,
  m: 888,
  n: 602,
  o: 604,
  p: 618,
  q: 618,
  r: 387,
  s: 539,
  t: 340,
  u: 602,
  v: 575,
  w: 829,
  x: 557,
  y: 575,
  z: 559,
  А: 709,
  Б: 646,
  В: 657,
  Г: 580,
  Д: 835,
  Е: 603,
  З: 627,
  И: 756,
  К: 688,
  Л: 749,
  М: 913,
  Н: 745,
  О: 767,
  П: 745,
  Р: 642,
  С: 733,
  Т: 653,
  У: 650,
  Ф: 831,
  Х: 701,
  Ц: 736,
  Ч: 703,
  Ш: 968,
  Э: 733,
  а: 568,
  б: 599,
  в: 569,
  г: 441,
  д: 629,
  е: 587,
  ж: 828,
  з: 502,
  и: 602,
  й: 602,
  к: 556,
  л: 585,
  м: 784,
  н: 599,
  о: 604,
  п: 596,
  р: 618,
  с: 577,
  т: 480,
  у: 575,
  ф: 717,
  х: 557,
  ц: 617,
  ч: 585,
  ш: 835,
  щ: 854,
  ъ: 655,
  ы: 760,
  ь: 569,
  э: 577,
  ю: 851,
  я: 562,
  ё: 587,
};

const HEADER_PX = 11;
const CELL_PADDING_PX = 20;

const labelsOf = (words: { columns: Record<string, unknown> }) =>
  Object.values(words.columns).filter(
    (label): label is string =>
      typeof label === "string" && !label.includes("{")
  );

const widthOf = (label: string) =>
  [...label].reduce((sum, glyph) => {
    const advance = ADVANCE[glyph];
    if (advance === undefined) throw new Error(`no advance for ${glyph}`);
    return sum + (advance / 1000) * HEADER_PX;
  }, 0);

describe("a header is never cut", () => {
  /**
   * Dana read "Mem…" and Lena "С…" over a column drawn at its header's floor:
   * seven pixels a glyph is short for a word like "Memory" or "CPU". Fails if
   * any label in either language measures wider than the floor gives it.
   */
  it.each([
    ["English", englishWords],
    ["Russian", russianWords],
  ] as const)(
    "floors every %s column label above its measured width",
    (_language, words) => {
      const cut = labelsOf(words)
        .filter(
          (label) =>
            columnFloor({ header: label }, ru) - CELL_PADDING_PX <
            widthOf(label)
        )
        .map((label) => `${label} ${widthOf(label).toFixed(1)}`);
      expect(cut).toEqual([]);
    }
  );

  /** Fails if a column's declared floor stops being honoured beside a short header. */
  it("takes the wider of what the cells declare and what the header says", () => {
    expect(columnFloor({ header: "Age", meta: { floor: 200 } }, ru)).toBe(200);
    expect(columnFloor({ header: "Age", meta: { floor: 10 } }, ru)).toBe(
      headerFloor({ header: "Age" }, ru)
    );
  });
});
