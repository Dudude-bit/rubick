import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import {
  act,
  fireEvent,
  render as mount,
  screen,
} from "@testing-library/react";
import type { ReactElement } from "react";

import { TooltipProvider } from "@/components/ui/tooltip";

import { REPAINT_MS, stallWatch } from "@/lib/stall-watch";
import { StallIndicator } from "./StallIndicator";
import { STALL_WARN } from "./useStalls";

const render = (ui: ReactElement) =>
  mount(<TooltipProvider>{ui}</TooltipProvider>);

/** Past the watch's coalescing, so the indicator has heard of the stall. */
const repaint = () => act(() => vi.advanceTimersByTime(REPAINT_MS));

describe("StallIndicator", () => {
  beforeEach(() => {
    // `performance.now` stays real: it dates the stalls the window keeps.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // One process holds one watch, so a test that wants an empty one says so.
    stallWatch.reset();
  });

  afterEach(() => {
    // A repaint left pending on a clock that is then taken away never fires,
    // and the watch waits for it before scheduling another, for good.
    act(() => vi.runOnlyPendingTimers());
    vi.useRealTimers();
  });

  /**
   * The two rows are fed by the table and the command wrapper and by nothing
   * else: a log buffer or a watch batch can block the thread without
   * reaching either. Reading "None over a thousand rows" there was the app
   * being confident about a channel it never looked at, and then advising
   * the reader to narrow a scope that was not the cause. Fails if the empty
   * case goes back to answering for everything.
   *
   * `fireEvent`, not userEvent: userEvent settles on a zero-delay timer the
   * fake clock would never fire.
   */
  it("says what it did not count when both rows come back empty", () => {
    render(<StallIndicator />);
    stallWatch.noteStall(900);
    repaint();
    fireEvent.click(screen.getByRole("button", { name: "Why slow" }));
    expect(
      screen.getByText(/Log lines and watch batches are not counted/)
    ).toBeInTheDocument();
  });

  /** Nothing is drawn while nothing stalled; a stall names itself and what was on screen. */
  it("appears with a stall and says what was big at the time", () => {
    render(<StallIndicator />);
    expect(screen.queryByRole("button")).toBeNull();
    stallWatch.noteList("pods-table", "pods", 10_400);
    stallWatch.noteAnswer("list_pods", new Array(10_400).fill(0));
    stallWatch.noteStall(320);
    repaint();
    const button = screen.getByRole("button", { name: "Why slow" });
    expect(button).toHaveTextContent("1 UI stall");
    fireEvent.click(button);
    expect(screen.getByText(/10.?400 rows of pods/)).toBeInTheDocument();
    expect(screen.getByText(/list_pods/)).toBeInTheDocument();
    expect(screen.getByText(/1 stall, the longest 320 ms/)).toBeInTheDocument();
    stallWatch.forgetList("pods-table");
  });

  /**
   * Stalls are the app's, not the cluster's, and sat red beside the red
   * problem count. Fails if a short stall is drawn in a status colour.
   */
  it("draws a short stall in grey, not as a problem", () => {
    render(<StallIndicator />);
    stallWatch.noteStall(320);
    repaint();
    const button = screen.getByRole("button", { name: "Why slow" });
    expect(button.className).toContain("text-fg-fnt");
    expect(button.className).not.toMatch(/text-(err|warn)\b/);
  });

  /** Fails if a window that was hard to use stops saying so, or says it in red. */
  it("turns amber past the threshold, and never red", () => {
    render(<StallIndicator />);
    stallWatch.noteStall(STALL_WARN.longestMs + 100);
    repaint();
    const button = screen.getByRole("button", { name: "Why slow" });
    expect(button.className).toContain("text-warn");
    expect(button.className).not.toContain("text-err");
  });
});
