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

function Page({ notice, table = true }: { notice: boolean; table?: boolean }) {
  return (
    <>
      <HeldWhilePointed>
        {notice && <p role="status">The read failed</p>}
      </HeldWhilePointed>
      {table && (
        <table data-pointer-hold="">
          <tbody>
            <tr>
              <td>row</td>
            </tr>
          </tbody>
        </table>
      )}
      <p>elsewhere</p>
    </>
  );
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("a notice arriving above a table", () => {
  /**
   * A refusal notice inserted above the Pods table slid the rows 140 px
   * under a pointer that had stopped on one. Fails if the notice appears
   * while the pointer moves over, rests on or is pressed on the rows, or does
   * not appear once the pointer has left the table.
   */
  it("waits while the pointer is on the rows, even resting, and lands when it leaves", () => {
    const { rerender } = render(<Page notice={false} />);
    const row = screen.getByText("row");
    fireEvent.pointerMove(row);
    rerender(<Page notice />);
    expect(screen.queryByRole("status")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.queryByRole("status")).toBeNull();

    fireEvent.pointerMove(screen.getByText("elsewhere"));
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  /** Fails if a table that left the page keeps holding notices for a pointer that last touched it. */
  it("lets go when the table the pointer rested on is gone", () => {
    const { rerender } = render(<Page notice={false} />);
    fireEvent.pointerMove(screen.getByText("row"));
    rerender(<Page notice />);
    expect(screen.queryByRole("status")).toBeNull();
    rerender(<Page notice table={false} />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  /** Fails if a held-down press, which is a click in progress, lets the notice in. */
  it("stays held while the button is down on a row", () => {
    const { rerender } = render(<Page notice={false} />);
    const row = screen.getByText("row");
    fireEvent.pointerDown(row);
    rerender(<Page notice />);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.pointerUp(row);
    fireEvent.pointerMove(screen.getByText("elsewhere"));
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
