import { describe, expect, it } from "vitest";

import { clampPeekWidth } from "./peek-width";
import { PEEK_WIDTH_MAX, PEEK_WIDTH_MIN } from "@/stores/displaySettingsStore";

const WIDE = 1920;

describe("clampPeekWidth", () => {
  it("leaves a sane width alone", () => {
    expect(clampPeekWidth(640, WIDE)).toBe(640);
  });

  it("refuses a sliver", () => {
    expect(clampPeekWidth(40, WIDE)).toBe(PEEK_WIDTH_MIN);
    expect(clampPeekWidth(-100, WIDE)).toBe(PEEK_WIDTH_MIN);
  });

  it("refuses to swallow the window", () => {
    expect(clampPeekWidth(5000, WIDE)).toBe(PEEK_WIDTH_MAX);
  });

  // The list behind the panel is the reason the peek is non-modal; it has to
  // survive the resize.
  it("leaves room for the list on a narrow window", () => {
    expect(clampPeekWidth(900, 1000)).toBe(760);
    expect(clampPeekWidth(PEEK_WIDTH_MAX, 800)).toBe(560);
  });

  it("never returns a panel wider than the window itself", () => {
    for (const viewport of [320, 500, 640]) {
      expect(clampPeekWidth(PEEK_WIDTH_MAX, viewport)).toBeLessThanOrEqual(
        viewport
      );
    }
  });

  it("rounds to whole pixels", () => {
    expect(clampPeekWidth(640.4, WIDE)).toBe(640);
  });
});
