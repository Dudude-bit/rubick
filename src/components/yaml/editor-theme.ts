import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Prec, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

import { yamlConstants } from "./scalar-kinds";

/**
 * CodeMirror, rendered in this app's palette instead of its own.
 *
 * The editor arrived with One Dark on dark and white-on-white on light, so a
 * manifest was a raised slab — `rgb(40,44,52)` on a `rgb(30,32,36)` canvas —
 * carrying salmon keys and green strings, on a canvas that has no surfaces
 * and spends colour only on anomalies. Seventeen tabs are this editor, so it
 * is worth mapping properly rather than only repainting the background: a
 * fifth of the app cannot be the one place the design system stops.
 *
 * Every colour here is a role token read at use time, so one spec serves
 * both palettes and a theme switch needs no rebuild of the extension. The
 * `dark` flag is still passed, because CodeMirror's own base theme branches
 * on it for the selection and cursor layers it draws itself.
 */

/**
 * Which colour says what, inside a document.
 *
 * Everywhere else this app spends colour only on anomalies, and that rule
 * cannot carry over here: a manifest has no anomalies to mark, every line of
 * it is equally true. Rendered under it a document came out as two greys and a
 * third too faint to read — a key at 16:1, its value at 9:1 and the colon
 * between them at 3.8:1, which is what "just dark text and slightly dark text"
 * meant, and is below AA besides. The rule inside a document is instead:
 *
 *   Colour separates the object from the format that carries it, and the
 *   status hues take no part in it.
 *
 * The format stays achromatic, graded by how much of it the reader needs. The
 * key is what they scan for and keeps the full foreground and the weight. The
 * colons, dashes and brackets are grammar and take `--fg-mut`, which is as
 * quiet as a token standing between a key and its value may go and still clear
 * 4.5:1 on both canvases. A comment is not part of the object at all and is the
 * one thing here a reader may skip, so it keeps `--fg-fnt`, in italics.
 *
 * The object's own words carry the hue, at two strengths of meaning. A plain
 * scalar — nearly always a name, an image, a path or a policy — takes
 * `SCALAR_HUE`. A number, a flag or a null is a value you check rather than
 * read and takes `CONSTANT_HUE`; the grammar cannot tell those from any other
 * plain literal, so `yamlConstants` marks them itself. Anchors, aliases and
 * tags keep `--info`, because they are the only construct in YAML whose
 * meaning reaches past its own line — a different claim from "this is a
 * value", and the one thing here worth the app's referential colour.
 *
 * Both hues sit in the arc between `--info` and `--err` and stand at least 40°
 * off either, so a manifest can never be misread as a status report.
 */
const SCALAR_HUE = 258;
const CONSTANT_HUE = 316;

/** Exported so the calibration above is asserted rather than asserted-to. */
export const SYNTAX_HUES = [SCALAR_HUE, CONSTANT_HUE];

const syntax = (hue: number) => `hsl(${hue} var(--syn-s) var(--syn-l))`;

const SPEC = {
  "&": {
    // The whole point: the manifest sits on the page, not on a card.
    backgroundColor: "transparent",
    color: "hsl(var(--fg-mid))",
    fontSize: "12px",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily:
      "'JetBrains Mono Variable', 'JetBrains Mono', Consolas, monospace",
    lineHeight: "1.5",
  },
  ".cm-content": { padding: "6px 0", caretColor: "hsl(var(--fg))" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    borderRight: "none",
    color: "hsl(var(--fg-fnt))",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 4px" },
  ".cm-activeLine": { backgroundColor: "hsl(var(--hover))" },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "hsl(var(--fg-mut))",
  },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "hsl(var(--fg))" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "hsl(var(--sel))" },
  ".cm-selectionMatch": { backgroundColor: "hsl(var(--sel))" },
  // A folded node is a thing you click, so it reads as a control rather
  // than as an ellipsis someone typed.
  ".cm-foldPlaceholder": {
    backgroundColor: "hsl(var(--sel))",
    border: "none",
    borderRadius: "3px",
    color: "hsl(var(--fg-mut))",
    margin: "0 2px",
    padding: "0 6px",
  },
  ".cm-foldGutter .cm-gutterElement": { color: "hsl(var(--fg-fnt))" },
  ".cm-panels, .cm-tooltip": {
    backgroundColor: "hsl(var(--raise))",
    border: "1px solid hsl(var(--hair))",
    color: "hsl(var(--fg))",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "hsl(var(--sel))",
    color: "hsl(var(--fg))",
  },
  ".cm-searchMatch": { backgroundColor: "hsl(var(--sel))" },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "hsl(var(--info) / 0.28)",
  },
  ".cm-yaml-constant": { color: syntax(CONSTANT_HUE) },
};

const HIGHLIGHT = HighlightStyle.define([
  {
    tag: t.definition(t.propertyName),
    color: "hsl(var(--fg))",
    fontWeight: "500",
  },
  {
    tag: [t.content, t.string, t.attributeValue],
    color: syntax(SCALAR_HUE),
  },
  { tag: [t.labelName, t.typeName], color: "hsl(var(--info))" },
  {
    tag: [
      t.separator,
      t.punctuation,
      t.squareBracket,
      t.brace,
      t.special(t.string),
      t.keyword,
      t.meta,
    ],
    color: "hsl(var(--fg-mut))",
  },
  {
    tag: t.lineComment,
    color: "hsl(var(--fg-fnt))",
    fontStyle: "italic",
  },
]);

export function editorTheme(dark: boolean): Extension {
  return [
    EditorView.theme(SPEC, { dark }),
    syntaxHighlighting(HIGHLIGHT),
    // Highest, so the constant's span nests *inside* the highlighter's rather
    // than around it. Two marks over one range render as two nested spans, and
    // the inner one's own `color` beats anything the outer would pass down —
    // no selector on the outer span can reach the inner element, so specificity
    // is not a way out of it. Precedence is what decides which is which, and
    // this is the only reason it is set.
    Prec.highest(yamlConstants),
  ];
}
