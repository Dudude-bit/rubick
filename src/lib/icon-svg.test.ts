import { describe, expect, it } from "vitest";
import { Box, CircleDashed } from "lucide-react";

import { iconSvg } from "./icon-svg";

describe("iconSvg", () => {
  /**
   * The drawing is read from lucide's own element rather than rendered, so
   * an upgrade that moves it would leave every icon in a shared report an
   * empty square. This is the test that notices.
   */
  it("carries the icon's own drawing, not an empty frame", () => {
    const svg = iconSvg(Box);
    expect(svg).toMatch(/^<svg [^>]*viewBox="0 0 24 24"/);
    expect(svg).toContain('<path d="M21 8a2 2 0 0 0-1-1.73l-7-4');
    expect(svg).not.toContain("key=");
  });

  it("draws the shapes that are not paths too", () => {
    expect(iconSvg(CircleDashed)).toContain("<path ");
  });
});
