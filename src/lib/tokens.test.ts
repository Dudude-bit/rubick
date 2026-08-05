import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("src/index.css", "utf8");

const ROLES = [
  "--canvas",
  "--hair",
  "--hover",
  "--sel",
  "--fg",
  "--fg-mid",
  "--fg-mut",
  "--fg-fnt",
  "--ok",
  "--warn",
  "--err",
  "--info",
];

describe("role tokens", () => {
  it("defines every role in the dark theme", () => {
    const dark = css.slice(css.indexOf(".dark {"));
    for (const role of ROLES) expect(dark).toContain(role);
  });

  it("defines every role in the light theme", () => {
    const light = css.slice(css.indexOf(":root {"), css.indexOf(".dark {"));
    for (const role of ROLES) expect(light).toContain(role);
  });

  it("uses the exact approved dark canvas", () => {
    expect(css).toContain("--canvas: 220 8% 11%");
  });

  it("carries alpha in the hairline variable itself, per theme", () => {
    const light = css.slice(css.indexOf(":root {"), css.indexOf(".dark {"));
    const dark = css.slice(css.indexOf(".dark {"));
    expect(light).toContain("--hair: 34 20% 30% / 0.12");
    expect(dark).toContain("--hair: 0 0% 100% / 0.07");
  });
});
