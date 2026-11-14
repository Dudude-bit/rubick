// @vitest-environment jsdom
import { describe, expect, it } from "vite-plus/test";

import { mapSvg, type SvgColours } from "./svg";

const colours: SvgColours = {
  canvas: "hsl(40 30% 98%)",
  raise: "hsl(0 0% 100%)",
  fg: "hsl(32 16% 11%)",
  faint: "hsl(32 8% 49%)",
  hair: "hsl(34 20% 30%)",
  tones: {
    ok: "hsl(148 55% 29%)",
    warn: "hsl(30 80% 37%)",
    err: "hsl(4 66% 45%)",
    mute: "hsl(32 8% 49%)",
    unknown: "hsl(32 8% 49%)",
  },
};

describe("the map as an image", () => {
  /** An export that drops a node, or prints a name with markup in it as markup, is a picture of some other cluster. */
  it("draws every node it is handed by its name, escaped", () => {
    const svg = mapSvg({
      colours,
      groups: [
        {
          group: {
            id: "shop",
            label: "shop",
            collapsed: false,
            tone: "ok",
            summary: null,
          },
          box: { x: 0, y: 0, width: 400, height: 120 },
          summary: "",
        },
      ],
      nodes: [
        {
          node: {
            id: "a",
            group: "shop",
            kind: "Deployment",
            label: "cart<v2>",
            tone: "err",
          },
          at: { x: 16, y: 40 },
          width: 208,
          height: 46,
        },
        {
          node: {
            id: "b",
            group: "shop",
            kind: "Secret",
            label: "token",
            tone: "unknown",
          },
          at: { x: 260, y: 40 },
          width: 208,
          height: 46,
        },
      ],
      edges: [
        {
          edge: { id: "a>b", from: "a", to: "b", tone: "unknown" },
          from: { x: 224, y: 63 },
          to: { x: 260, y: 63 },
        },
      ],
    });
    expect(svg).toContain("cart&lt;v2&gt;");
    expect(svg).toContain(">token<");
    expect(svg).toContain(`stroke="${colours.tones.err}"`);
    expect(svg.match(/stroke-dasharray/g)).toHaveLength(2);
    expect(
      new DOMParser()
        .parseFromString(svg, "image/svg+xml")
        .querySelector("parsererror")
    ).toBeNull();
  });
});
