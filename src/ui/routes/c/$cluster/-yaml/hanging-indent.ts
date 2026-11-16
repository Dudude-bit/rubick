import { RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";

const HANG = 2;

export function hangingIndentStyle(line: string): string {
  const indent = (/^ */.exec(line)?.[0].length ?? 0) + HANG;
  return `padding-left: calc(${indent}ch + 6px); text-indent: -${indent}ch`;
}

function decorate(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  let last = -1;
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to;) {
      const line = view.state.doc.lineAt(pos);
      if (line.from > last) {
        builder.add(
          line.from,
          line.from,
          Decoration.line({
            attributes: { style: hangingIndentStyle(line.text) },
          })
        );
        last = line.from;
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

export const hangingIndent = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = decorate(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = decorate(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations }
);
