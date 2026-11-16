import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { useEffect } from "react";

import { keepSelectAllToFields } from "./select-all-guard";

function Page() {
  useEffect(() => keepSelectAllToFields(), []);
  return (
    <div>
      <span data-testid="label">Pod page label</span>
      <input aria-label="field" />
      <div data-select-all="" tabIndex={0} data-testid="log" />
      <div className="cm-editor">
        <span data-testid="yaml">kind: Pod</span>
      </div>
    </div>
  );
}

const ctrlA = (target: Element | Document = document.body) =>
  fireEvent.keyDown(target, { key: "a", ctrlKey: true });

afterEach(() => window.getSelection()?.removeAllRanges());

describe("select-all outside a field", () => {
  /** Ctrl+A on a Pod page painted every label and value. Fails if select-all on a page with no table is let through, or Cmd+A is not held back the same way. */
  it("is refused on a page with no table, with Ctrl and with Cmd", () => {
    render(<Page />);
    expect(ctrlA()).toBe(false);
    expect(
      fireEvent.keyDown(screen.getByTestId("label"), {
        key: "A",
        metaKey: true,
      })
    ).toBe(false);
  });

  /** Fails if a field, the editor or a region that declares its own select-all loses it. */
  it("is left to a field, the editor and a region that declares its own", () => {
    render(<Page />);
    expect(ctrlA(screen.getByLabelText("field"))).toBe(true);
    expect(ctrlA(screen.getByTestId("log"))).toBe(true);
    expect(ctrlA(screen.getByTestId("yaml"))).toBe(true);
  });

  /** A read-only editor takes no focus, so the page's body gets the key. Fails if a selection inside the editor stops keeping select-all. */
  it("is left to the editor when the selection already sits in it", () => {
    render(<Page />);
    const range = document.createRange();
    range.selectNodeContents(screen.getByTestId("yaml"));
    window.getSelection()!.addRange(range);
    expect(ctrlA()).toBe(true);
  });

  /** Fails if other Ctrl shortcuts are swallowed along with select-all. */
  it("lets other shortcuts through", () => {
    render(<Page />);
    expect(fireEvent.keyDown(document.body, { key: "c", ctrlKey: true })).toBe(
      true
    );
    expect(
      fireEvent.keyDown(document.body, {
        key: "a",
        ctrlKey: true,
        shiftKey: true,
      })
    ).toBe(true);
  });
});
