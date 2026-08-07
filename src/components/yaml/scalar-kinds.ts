import { syntaxTree } from "@codemirror/language";
import { RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  ViewPlugin,
  type DecorationSet,
  type EditorView,
  type ViewUpdate,
} from "@codemirror/view";

/**
 * Telling `replicas: 3` from `image: nginx`, which the grammar does not.
 *
 * `@lezer/yaml` gives every plain scalar the same tag — `Literal` is
 * `tags.content` whether it holds a name, a number or a boolean — so a
 * highlight style alone cannot say that a count and a name are different kinds
 * of thing. This marks the ones YAML's core schema calls a number, a flag or a
 * null, which are the values a reader checks rather than reads.
 *
 * Only plain literals: a quoted `"true"` is a string in YAML and gets the
 * scalar colour, which is exactly the distinction the quotes are there to
 * make. Keys are excluded too — a mapping key spelled `true` is still the
 * thing that names the line.
 */

/** YAML 1.2 core schema, minus the quoted forms the node type already rules out. */
const CONSTANT =
  /^(?:[-+]?(?:0|[1-9][0-9]*)(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?|0[xX][0-9a-fA-F]+|0o[0-7]+|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN)|true|True|TRUE|false|False|FALSE|null|Null|NULL|~)$/;

const CONSTANT_MARK = Decoration.mark({ class: "cm-yaml-constant" });

function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const tree = syntaxTree(view.state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "Literal") return;
        // `Key/Literal` is the same node type as a value's; only its parent
        // says which side of the colon it is on.
        if (node.node.parent?.name === "Key") return;
        const text = view.state.doc.sliceString(node.from, node.to);
        if (CONSTANT.test(text)) builder.add(node.from, node.to, CONSTANT_MARK);
      },
    });
  }
  return builder.finish();
}

export const yamlConstants = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = build(view);
    }

    update(update: ViewUpdate) {
      // A viewport change because only the visible ranges are walked, so
      // scrolling brings in lines that have never been marked. And a change of
      // tree because the parse is time-sliced: a manifest long enough to matter
      // lands with a partial one, and nothing else fires when the rest arrives.
      if (
        update.docChanged ||
        update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = build(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations }
);

/** Exported for the test, which asserts the schema rather than the rendering. */
export const isYamlConstant = (text: string) => CONSTANT.test(text);
