// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { translate } from "@/i18n";
import { columnHeader } from "@/i18n/column-header";
import type { T } from "@/i18n/useT";
import { headerFloor } from "./column-label";
import { textWidth, textWidths, widestText } from "./text-width";

const ru: T = (section, key, values) => translate("ru", section, key, values);

/** Lays text out at `px` a glyph, the way a real engine would answer the probe. */
const layOut = (px: number) =>
  vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      return { width: (this.textContent ?? "").length * px } as DOMRect;
    });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the width text is drawn at", () => {
  /** Fails if a floor goes back to guessing glyph widths where the engine can say what it drew. */
  it("is what the engine lays the text out at, in the face the cells use", () => {
    layOut(9);
    expect(textWidth("controlplane", "mono")).toBe(108);
    expect(widestText(["нет замера", "н/д"], "sans", 7.2)).toBe(90);
  });

  /** Fails if a header floor stops coming from its drawn words: Wave 7's 7px a glyph left "A…" and "Воз…". */
  it("floors a header at its drawn label and padding", () => {
    layOut(10);
    expect(headerFloor({ header: columnHeader("columns", "age") }, ru)).toBe(
      "Возраст".length * 10 + 20
    );
  });

  /** Fails if a test environment, which lays nothing out, reads as text of no width and lets a column shrink to nothing. */
  it("falls back to a width a glyph where nothing lays text out", () => {
    expect(textWidth("controlplane", "mono")).toBeNull();
    expect(widestText(["controlplane"], "mono", 7.2)).toBe(Math.ceil(12 * 7.2));
  });

  /**
   * Figures are tabular, so amounts that differ only in their digits are
   * one width; what is unknown is laid out together. Fails if a digit, or
   * a string, costs a probe of its own again.
   */
  it("lays out one probe per shape, all at once", () => {
    layOut(7);
    const append = vi.spyOn(Element.prototype, "append");
    const widths = textWidths(
      ["0.00167 EUR", "0.00523 EUR", "12%", "97%", "0.00167 EUR"],
      "mono"
    );
    expect(widths).toEqual([77, 77, 21, 21, 77]);
    const probes = append.mock.calls.filter(
      ([first]) => first instanceof HTMLSpanElement
    );
    expect(probes).toHaveLength(1);
    expect(probes[0]).toHaveLength(2);
  });

  /**
   * Each text laid out on its own was a layout of the whole document per
   * text: the new ones are measured together, and a mono face, whose glyphs
   * are one width, is not laid out at all.
   */
  it("lays out the texts it does not know in one pass, and a mono face in none", () => {
    layOut(8);
    const append = vi.spyOn(Element.prototype, "append");
    const probes = () =>
      append.mock.calls.filter(([first]) => first instanceof HTMLSpanElement);
    const words = Array.from({ length: 20 }, (_, i) => `reason ${i}`);
    expect(widestText(words, "sans", 7)).toBe("reason 10".length * 8);
    expect(probes()).toHaveLength(1);
    expect(widestText(["4.74", "1,234 ms"], "mono", 7.2)).toBe(
      Math.ceil(8 * 7.2)
    );
    expect(probes()).toHaveLength(1);
  });

  /**
   * The cache starts again past its size, and a call that asks for a
   * width it held and one it did not still gets both. Fails if the held
   * one comes back unknown, which shrinks its column to a guess per glyph.
   */
  it("keeps the widths a call already knew when the cache starts again", () => {
    layOut(5);
    Object.defineProperty(document, "fonts", {
      value: { status: "loaded" },
      configurable: true,
    });
    try {
      // Letters only: digits are one shape.
      const word = (i: number) =>
        [...i.toString(26)]
          .map((c) => String.fromCharCode(97 + parseInt(c, 26)))
          .join("");
      const held = Array.from({ length: 4096 }, (_, i) => `w${word(i)}`);
      textWidths(held, "sans");
      expect(textWidths([held[0]!, "a new label"], "sans")).toEqual([
        held[0]!.length * 5,
        "a new label".length * 5,
      ]);
    } finally {
      delete (document as { fonts?: unknown }).fonts;
    }
  });
});
