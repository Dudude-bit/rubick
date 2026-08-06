import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

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
};

/**
 * Structure carried by weight and by three greys, the way the rest of the
 * app carries it. `--info` is kept for anchors, aliases and explicit tags,
 * which are the only parts of a manifest that change what a later line
 * means — the one thing in a YAML document worth a colour.
 */
const HIGHLIGHT = HighlightStyle.define([
  {
    tag: t.definition(t.propertyName),
    color: "hsl(var(--fg))",
    fontWeight: "500",
  },
  { tag: [t.content, t.string, t.attributeValue], color: "hsl(var(--fg-mid))" },
  {
    tag: [t.special(t.string), t.keyword, t.meta],
    color: "hsl(var(--fg-mut))",
  },
  {
    tag: [t.separator, t.punctuation, t.squareBracket, t.brace, t.lineComment],
    color: "hsl(var(--fg-fnt))",
  },
  { tag: [t.labelName, t.typeName], color: "hsl(var(--info))" },
]);

export function editorTheme(dark: boolean): Extension {
  return [EditorView.theme(SPEC, { dark }), syntaxHighlighting(HIGHLIGHT)];
}
