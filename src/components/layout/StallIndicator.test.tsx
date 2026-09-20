import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { stallWatch } from "@/lib/stall-watch";
import { StallIndicator } from "./StallIndicator";

describe("StallIndicator", () => {
  beforeEach(() => {
    vi.useRealTimers();
    // One process holds one watch, so a test that wants an empty one says so.
    stallWatch.reset();
  });

  /**
   * The two rows are fed by the table and the command wrapper and by nothing
   * else: a log buffer or a watch batch can block the thread without
   * reaching either. Reading "None over a thousand rows" there was the app
   * being confident about a channel it never looked at, and then advising
   * the reader to narrow a scope that was not the cause. Fails if the empty
   * case goes back to answering for everything.
   */
  it("says what it did not count when both rows come back empty", async () => {
    const { rerender } = render(<StallIndicator />);
    stallWatch.noteStall(900);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    rerender(<StallIndicator />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Why slow" })
    );
    expect(
      await screen.findByText(/Log lines and watch batches are not counted/)
    ).toBeInTheDocument();
  });

  /** Nothing is drawn while nothing stalled; a stall names itself and what was on screen. */
  it("appears with a stall and says what was big at the time", async () => {
    const { rerender } = render(<StallIndicator />);
    expect(screen.queryByRole("button")).toBeNull();
    stallWatch.noteList("pods-table", "pods", 10_400);
    stallWatch.noteAnswer("list_pods", new Array(10_400).fill(0));
    stallWatch.noteStall(320);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    rerender(<StallIndicator />);
    const button = await screen.findByRole("button", { name: "Why slow" });
    expect(button).toHaveTextContent("1 stall");
    await userEvent.click(button);
    expect(await screen.findByText(/10.?400 rows of pods/)).toBeInTheDocument();
    expect(screen.getByText(/list_pods/)).toBeInTheDocument();
    expect(screen.getByText(/1 stall, the longest 320 ms/)).toBeInTheDocument();
    stallWatch.forgetList("pods-table");
  });
});
