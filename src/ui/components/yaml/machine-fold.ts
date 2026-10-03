import { foldEffect, foldService, foldedRanges } from "@codemirror/language";
import type { EditorState, Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

import { isMachineDocument } from "@/components/resources/key-values";

/**
 * Folding the annotations a controller wrote, inside the document itself.
 *
 * The metadata block of every applied object carries
 * `kubectl.kubernetes.io/last-applied-configuration`, whose value is the
 * whole manifest on one line. In the editor it lands as line 7 and pushes
 * the actual spec off the screen. This is real folding — CodeMirror's own,
 * the same mechanism the gutter arrows drive — so the node is collapsed on
 * open and one click on the placeholder or the gutter puts it back. Nothing
 * is removed from the document and nothing is rewritten.
 *
 * The fold covers the *value* rather than the whole line, so the key that
 * says what was folded stays legible beside the placeholder.
 */

/** `  some.prefix/name: ` — the indent, the key (quoted or not) and the colon. */
const KEY_LINE = /^(\s*)(?:"([^"]*)"|'([^']*)'|([^\s#][^:]*?))\s*:(?:[ \t]+|$)/;

/** Annotation and label keys only, which keeps the rule off JSON fragments. */
const KEY_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** `|`, `>`, `|-`, `>2+` — the value is the indented block underneath. */
const BLOCK_HEADER = /^[|>][+-]?\d*\s*(?:#.*)?$/;

interface FoldRange {
  from: number;
  to: number;
}

function indentOf(text: string): number {
  return text.length - text.trimStart().length;
}

function unquote(text: string): string {
  const trimmed = text.trim();
  const first = trimmed[0];
  if ((first === '"' || first === "'") && trimmed.endsWith(first)) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** The range to fold on the line starting at `lineStart`, if it holds one. */
function machineDocumentAt(
  state: EditorState,
  lineStart: number
): FoldRange | null {
  const line = state.doc.lineAt(lineStart);
  const match = KEY_LINE.exec(line.text);
  if (!match) return null;

  const key = match[2] ?? match[3] ?? match[4];
  if (!KEY_SHAPE.test(key)) return null;

  const from = line.from + match[0].length;
  const inline = line.text.slice(match[0].length);

  if (BLOCK_HEADER.test(inline)) {
    const indent = match[1].length;
    let last = line;
    for (let n = line.number + 1; n <= state.doc.lines; n++) {
      const next = state.doc.line(n);
      // A blank line inside a block scalar is part of it; only a line that
      // dedents ends it.
      if (next.text.trim() !== "" && indentOf(next.text) <= indent) break;
      last = next;
    }
    if (last.number === line.number) return null;
    const body = state.doc.sliceString(line.to + 1, last.to);
    return isMachineDocument(key, body) ? { from, to: last.to } : null;
  }

  const value = unquote(inline);
  if (!value) return null;
  return isMachineDocument(key, value) ? { from, to: line.to } : null;
}

/**
 * Makes the gutter arrow appear on a machine annotation whose value sits on
 * one line. A scalar has no syntax node to fold, so without this the reader
 * could not reopen what was folded, nor fold it again after reading it.
 */
export const machineDocumentFolding: Extension = foldService.of((state, from) =>
  machineDocumentAt(state, from)
);

/** Collapses every machine annotation in the document, once, on open. */
export function foldMachineDocuments(view: EditorView): void {
  const { state } = view;
  const folded = foldedRanges(state);
  const effects = [];

  for (let n = 1; n <= state.doc.lines; n++) {
    const range = machineDocumentAt(state, state.doc.line(n).from);
    if (!range) continue;
    let done = false;
    folded.between(range.from, range.to, (from, to) => {
      if (from === range.from && to === range.to) {
        done = true;
        return false;
      }
    });
    if (!done) effects.push(foldEffect.of(range));
    n = state.doc.lineAt(range.to).number;
  }

  if (effects.length > 0) view.dispatch({ effects });
}
