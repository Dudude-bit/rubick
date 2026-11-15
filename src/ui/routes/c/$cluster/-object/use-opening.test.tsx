import { act, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vite-plus/test";

import { useOpening } from "./use-opening";

function Harness({ draws }: { draws: boolean }) {
  const [opened, setOpened] = useState(false);
  const { opening, begin } = useOpening(opened);
  return (
    <>
      <button onClick={() => begin(() => draws && setOpened(true))}>
        Scale
      </button>
      <button onClick={() => setOpened(false)}>close</button>
      <output>{opening ? "pending" : "idle"}</output>
    </>
  );
}

describe("a button whose dialog takes a moment to draw", () => {
  /**
   * The Scale button showed only its pressed tint for up to a
   * second. Fails if the button is not marked pending from the press until
   * the dialog is open, or stays pending once it is.
   */
  it("is pending from the press until the dialog is open", () => {
    const { rerender } = render(<Harness draws={false} />);
    expect(screen.getByRole("status", { hidden: true })).toHaveTextContent(
      "idle"
    );
    act(() => screen.getByText("Scale").click());
    expect(screen.getByRole("status", { hidden: true })).toHaveTextContent(
      "pending"
    );
    rerender(<Harness draws />);
    act(() => screen.getByText("Scale").click());
    expect(screen.getByRole("status", { hidden: true })).toHaveTextContent(
      "idle"
    );
    act(() => screen.getByText("close").click());
    expect(screen.getByRole("status", { hidden: true })).toHaveTextContent(
      "idle"
    );
  });
});
