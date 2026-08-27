import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { forceParsing } from "@codemirror/language";
import { yaml as yamlLanguage } from "@codemirror/lang-yaml";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { editorTheme, SYNTAX_HUES } from "./editor-theme";
import { isYamlConstant } from "./scalar-kinds";

const css = readFileSync("src/index.css", "utf8");
const light = css.slice(css.indexOf(":root {"), css.indexOf(".dark {"));
const dark = css.slice(css.indexOf(".dark {"));

function hsl(block: string, role: string): [number, number, number] {
  const match = new RegExp(`${role}:\\s*([\\d.]+) ([\\d.]+)% ([\\d.]+)%`).exec(
    block
  );
  if (!match) throw new Error(`${role} is not an hsl triple`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function percent(block: string, role: string): number {
  const match = new RegExp(`${role}:\\s*([\\d.]+)%`).exec(block);
  if (!match) throw new Error(`${role} is not a percentage`);
  return Number(match[1]);
}

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

function contrast(
  a: [number, number, number],
  b: [number, number, number]
): number {
  const luminance = (colour: [number, number, number]) => {
    const [r, g, bl] = colour.map((v) =>
      v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
    );
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Degrees around the ring, the short way. */
const apart = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
};

describe("the YAML syntax palette", () => {
  it.each([
    ["dark", dark],
    ["light", light],
  ])("reads as body text against the %s canvas", (_name, block) => {
    const canvas = rgb(hsl(block, "--canvas"));
    const s = percent(block, "--syn-s");
    const l = percent(block, "--syn-l");
    for (const hue of SYNTAX_HUES) {
      // Not merely 4.5:1 — a scalar is most of what is on the screen, and it
      // replaced `--fg-mid`, so falling short of that grey would trade a
      // legibility complaint for a legibility regression.
      const fgMid = rgb(hsl(block, "--fg-mid"));
      expect(contrast(rgb([hue, s, l]), canvas)).toBeGreaterThanOrEqual(
        0.8 * contrast(fgMid, canvas)
      );
    }
  });

  it.each([
    ["dark", dark],
    ["light", light],
  ])("keeps the grammar above AA on the %s canvas", (_name, block) => {
    // The colon between a key and its value is load-bearing at 12px. It used
    // to be `--fg-fnt`, which is 3.8:1 on light and fails.
    const canvas = rgb(hsl(block, "--canvas"));
    expect(
      contrast(rgb(hsl(block, "--fg-mut")), canvas)
    ).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    ["dark", dark],
    ["light", light],
  ])("stays off the %s status hues", (_name, block) => {
    // A manifest that borrows the warning or the error hue reads as a report
    // card on an object that is merely being displayed.
    for (const hue of SYNTAX_HUES) {
      for (const role of ["--ok", "--warn", "--err", "--info"]) {
        expect(apart(hue, hsl(block, role)[0])).toBeGreaterThanOrEqual(40);
      }
    }
  });
});

/**
 * The constant colour survives only as long as its span stays *inside* the
 * highlighter's. Both are mark decorations over the same range, so they render
 * as nested spans, and the inner element's own `color` wins outright — no
 * selector written for the outer one can reach the inner. Nothing about the
 * colours says which way the nesting goes; only `Prec.highest` does.
 */
describe("a constant against the scalar colour on the same text", () => {
  it("renders inside the highlighter's span, not around it", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      state: EditorState.create({
        doc: "spec:\n  readOnly: true\n  image: nginx\n",
        extensions: [yamlLanguage(), editorTheme(true)],
      }),
      parent,
    });
    // The grammar parses in time slices, and `yamlConstants` only marks what
    // the tree already holds. Alone this document parses before the next line
    // runs; under a loaded suite it does not, and the assertion then reads a
    // half-parsed document as a missing decoration. Waiting for the parse is
    // what makes this test about nesting rather than about scheduling.
    forceParsing(view, view.state.doc.length);
    const constant = view.contentDOM.querySelector(".cm-yaml-constant");
    expect(constant?.textContent).toBe("true");
    expect(constant?.firstElementChild).toBeNull();
    view.destroy();
    parent.remove();
  });
});

/**
 * The grammar tags every plain scalar `content`, so what counts as a number,
 * a flag or a null is decided here rather than by the parser.
 */
describe("plain scalars the core schema calls constants", () => {
  it.each([
    "3",
    "0",
    "-1",
    "8080",
    "1.5",
    "1e3",
    "0x1f",
    "0o755",
    "true",
    "True",
    "FALSE",
    "null",
    "~",
    ".inf",
    ".nan",
  ])("marks %s", (text) => expect(isYamlConstant(text)).toBe(true));

  it.each([
    "nginx",
    "busybox:1.36",
    "1.36-alpine",
    "IfNotPresent",
    "3s",
    "v1",
    "10.42.0.235",
    "",
    "truthy",
  ])("leaves %s alone", (text) => expect(isYamlConstant(text)).toBe(false));
});
