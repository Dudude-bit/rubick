import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (file: string) =>
  readFileSync(join("src", "components", "resources", file), "utf8");

describe("the frame the usage and traffic bands are drawn in", () => {
  /**
   * The traffic chart kept its own copy of the band's height, margin and
   * width hook, while the placeholder that holds its place while it loads
   * reads the usage chart's: changing one copy left a chart and its
   * placeholder at two heights, with nothing failing.
   */
  it.each(["usage-band.tsx", "traffic-chart.tsx", "usage-chart.tsx"])(
    "is not redeclared in %s",
    (file) => {
      const code = source(file);
      expect(code).not.toMatch(/const (BAND_H|MARGIN|ASSUMED_W)\b/);
      expect(code).not.toMatch(/function useBandWidth\b/);
      expect(code).toMatch(/from "\.\/band-frame"/);
    }
  );
});
