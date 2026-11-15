import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { useRef } from "react";

import { useTableSelection } from "./use-table-selection";

function Page() {
  const ref = useRef<HTMLDivElement>(null);
  useTableSelection(ref);
  return (
    <div>
      <div ref={ref}>
        <span data-testid="cell">cell text</span>
      </div>
      <input aria-label="field" />
      <span data-testid="canvas">canvas</span>
      <button>copy</button>
    </div>
  );
}

const select = (node: Node) => {
  const range = document.createRange();
  range.selectNodeContents(node);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
};

afterEach(() => window.getSelection()?.removeAllRanges());

describe("a table's selection", () => {
  /** Ctrl+A painted every label and cell of the page. Fails if select-all outside a field is let through, or one inside a field is stopped. */
  it("refuses select-all outside a field and leaves it to a field", () => {
    render(<Page />);
    expect(fireEvent.keyDown(document.body, { key: "a", ctrlKey: true })).toBe(
      false
    );
    expect(
      fireEvent.keyDown(screen.getByLabelText("field"), {
        key: "a",
        ctrlKey: true,
      })
    ).toBe(true);
  });

  /** Blue boxes stayed on cells after a click on empty canvas. Fails if that click keeps the table's selection, or a click on a button drops it. */
  it("drops its selection on a click on the canvas but not on a control", () => {
    render(<Page />);
    select(screen.getByTestId("cell"));
    fireEvent.pointerDown(screen.getByText("copy"));
    expect(window.getSelection()!.isCollapsed).toBe(false);
    fireEvent.pointerDown(screen.getByTestId("canvas"));
    expect(window.getSelection()!.isCollapsed).toBe(true);
  });
});
