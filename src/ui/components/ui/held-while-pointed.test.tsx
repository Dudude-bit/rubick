import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { HeldWhilePointed } from "./held-while-pointed";

function Page({ notice }: { notice: boolean }) {
  return (
    <>
      <HeldWhilePointed>
        {notice && <p role="status">The read failed</p>}
      </HeldWhilePointed>
      <table data-pointer-hold="">
        <tbody>
          <tr>
            <td>row</td>
          </tr>
        </tbody>
      </table>
      <p>elsewhere</p>
    </>
  );
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("a notice arriving above a table", () => {
  /**
   * A refusal notice inserted above the Pods table slid the rows 100 px
   * under the pointer and the click landed on another row. Fails if the
   * notice appears while the pointer is moving over the rows or pressed on
   * one, or does not appear once the pointer is still, has left, or is up.
   */
  it("waits while the pointer moves over the rows and lands when it stops or leaves", () => {
    const { rerender } = render(<Page notice={false} />);
    const row = screen.getByText("row");
    fireEvent.pointerMove(row);
    rerender(<Page notice />);
    expect(screen.queryByRole("status")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(900);
    });
    expect(screen.getByRole("status")).toBeInTheDocument();

    fireEvent.pointerMove(row);
    rerender(<Page notice={false} />);
    expect(screen.getByRole("status")).toBeInTheDocument();
    fireEvent.pointerMove(screen.getByText("elsewhere"));
    expect(screen.queryByRole("status")).toBeNull();
  });

  /** Fails if a held-down press, which is a click in progress, lets the notice in after the pointer stops. */
  it("stays held for as long as the button is down on a row", () => {
    const { rerender } = render(<Page notice={false} />);
    const row = screen.getByText("row");
    fireEvent.pointerDown(row);
    rerender(<Page notice />);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.pointerUp(row);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  /** Fails if a pointer that is nowhere near a table holds a notice back. */
  it("shows a notice at once when the pointer is not over a table", () => {
    const { rerender } = render(<Page notice={false} />);
    fireEvent.pointerMove(screen.getByText("elsewhere"));
    rerender(<Page notice />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });
});
