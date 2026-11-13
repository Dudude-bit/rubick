// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vite-plus/test";

import { hangingIndent, hangingIndentStyle } from "./hanging-indent";

describe("hanging indent", () => {
  /** A wrapped YAML line must continue under its own text; fails if the indent stops following the line's leading spaces. */
  it("hangs a line by its own indentation plus two columns", () => {
    expect(hangingIndentStyle("a: b")).toContain("text-indent: -2ch");
    expect(hangingIndentStyle("    key: value")).toContain("text-indent: -6ch");
  });

  /** Fails if the extension stops decorating the lines of a document. */
  it("styles every line of the document it is mounted on", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      state: EditorState.create({
        doc: "a:\n  b: c",
        extensions: [hangingIndent],
      }),
      parent,
    });
    const styles = [...view.dom.querySelectorAll(".cm-line")].map((line) =>
      line.getAttribute("style")
    );
    view.destroy();
    expect(styles.length).toBeGreaterThan(0);
    expect(styles.every((style) => style?.includes("text-indent"))).toBe(true);
  });
});
