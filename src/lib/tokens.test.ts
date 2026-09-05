import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { CLUSTER_HUES } from "./cluster-identity";
import { contrast as contrastOf, type Rgb } from "./color";

const css = readFileSync("src/index.css", "utf8");
const light = css.slice(css.indexOf(":root {"), css.indexOf(".dark {"));
const dark = css.slice(css.indexOf(".dark {"));

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

/** `--fg: 220 6% 93%` -> [220, 6, 93]. */
function hsl(block: string, role: string): [number, number, number] {
  const match = new RegExp(`${role}:\\s*([\\d.]+) ([\\d.]+)% ([\\d.]+)%`).exec(
    block
  );
  if (!match) throw new Error(`${role} is not an hsl triple`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** `--ident-s: 58%` -> 58. Saturation and lightness stand on their own. */
function percent(block: string, role: string): number {
  const match = new RegExp(`${role}:\\s*([\\d.]+)%`).exec(block);
  if (!match) throw new Error(`${role} is not a percentage`);
  return Number(match[1]);
}

function alpha(block: string, role: string): number {
  const match = new RegExp(`${role}:[^;]*/\\s*([\\d.]+)`).exec(block);
  if (!match) throw new Error(`${role} carries no alpha`);
  return Number(match[1]);
}

describe("role tokens", () => {
  it.each([
    ["dark", dark],
    ["light", light],
  ])("defines every role in the %s theme", (_name, block) => {
    for (const role of ROLES) expect(block).toContain(role);
  });

  // Values are calibrated against screenshots and are expected to move.
  // What must not move is the shape of the system, so these assert
  // relationships rather than transcribing the constants — a test that
  // pins a literal only protects against editing it.
  it.each([
    ["dark", dark],
    ["light", light],
  ])("keeps the foreground ramp monotonic in the %s theme", (_n, block) => {
    const toward = (l: number) =>
      hsl(block, "--canvas")[2] > 50 ? l : 100 - l;
    const ramp = ["--fg", "--fg-mid", "--fg-mut", "--fg-fnt"].map((role) =>
      toward(hsl(block, role)[2])
    );
    // Each step must fade toward the canvas, or two roles are interchangeable
    // and the hierarchy they exist to express has collapsed.
    for (let i = 1; i < ramp.length; i++) {
      expect(ramp[i]).toBeGreaterThan(ramp[i - 1]);
    }
  });

  it.each([
    ["dark", dark],
    ["light", light],
  ])("carries alpha in the %s hairline, hover and selection", (_n, block) => {
    // Alpha belongs inside the variable: the same role has to be a light
    // wash on dark and a dark wash on light, which a single opacity
    // modifier at the call site cannot express.
    expect(alpha(block, "--hair")).toBeGreaterThan(0);
    // A row must read as more selected than merely hovered.
    expect(alpha(block, "--sel")).toBeGreaterThan(alpha(block, "--hover"));
  });

  it("lifts the overlay surface off the dark canvas", () => {
    // Light does the opposite — its canvas is already near-white, so the
    // lift comes from pure white plus the shadow.
    expect(hsl(dark, "--raise")[2]).toBeGreaterThan(hsl(dark, "--canvas")[2]);
    expect(hsl(light, "--raise")[2]).toBeGreaterThanOrEqual(
      hsl(light, "--canvas")[2]
    );
  });

  it("keeps the two themes on opposite sides of mid grey", () => {
    expect(hsl(dark, "--canvas")[2]).toBeLessThan(50);
    expect(hsl(light, "--canvas")[2]).toBeGreaterThan(50);
  });
});

/** HSL in the same units the CSS uses, to sRGB in 0..1. */
function rgb([h, s, l]: [number, number, number]): [number, number, number] {
  const sat = s / 100;
  const light = l / 100;
  const a = sat * Math.min(light, 1 - light);
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    return light - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [channel(0), channel(8), channel(4)];
}

const contrast = (a: Rgb, b: Rgb) =>
  contrastOf(a.map((v) => v * 255) as Rgb, b.map((v) => v * 255) as Rgb);

describe("the hues a cluster can be painted", () => {
  // The whole reason a chosen colour is a hue and not a colour is that the
  // saturation and lightness it is worn at belong to the theme. That only
  // buys anything if every hue on offer survives both of them — a swatch
  // picked on the dark canvas that vanishes on the near-white one is
  // exactly the failure this arrangement exists to prevent.
  it.each([
    ["dark", dark],
    ["light", light],
  ])("stays legible against the %s canvas", (_name, block) => {
    const canvas = rgb(hsl(block, "--canvas"));
    const s = percent(block, "--ident-s");
    const l = percent(block, "--ident-l");
    for (const hue of CLUSTER_HUES) {
      expect(contrast(rgb([hue, s, l]), canvas)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
