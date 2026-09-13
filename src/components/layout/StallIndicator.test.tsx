import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { stallWatch } from "@/lib/stall-watch";
import { StallIndicator } from "./StallIndicator";

describe("StallIndicator", () => {
  beforeEach(() => {
    vi.useRealTimers();
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
