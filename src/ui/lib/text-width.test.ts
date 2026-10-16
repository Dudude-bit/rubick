// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { translate } from "@/i18n";
import { columnHeader } from "@/i18n/column-header";
import type { T } from "@/i18n/useT";
import { headerFloor } from "./column-label";
import { textWidth, widestText } from "./text-width";

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
});
