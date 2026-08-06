import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ----- Mocks -----

const listeners: Record<
  string,
  ((event: { payload: unknown }) => void) | undefined
> = {};

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (event: string, handler: (e: { payload: unknown }) => void) => {
      listeners[event] = handler;
      return () => {
        delete listeners[event];
      };
    }
  ),
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    streamPodLogs: vi.fn(async () => "stream-id-1"),
    stopLogStream: vi.fn(async () => undefined),
    logStreamSubscribed: vi.fn(async () => undefined),
    getPodLogs: vi.fn(async () => []),
  },
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { commands } from "@/lib/commands";
import type { StreamLogConfig } from "@/generated/types";
import { useDisplaySettingsStore } from "@/stores/displaySettingsStore";
import { LogViewer } from "./LogViewer";

const props = {
  podName: "log-demo-7f9",
  namespace: "default",
  containers: ["app"],
};

function fireFailure(kind: "gone" | "broken", message: string) {
  listeners["stream-failed"]!({
    payload: { stream_id: "stream-id-1", kind, message },
  });
}

async function renderStreaming() {
  // The status bar reaches for a Tooltip the moment there is a line to
  // describe the format of, which the app supplies at the root.
  render(
    <TooltipProvider>
      <LogViewer {...props} />
    </TooltipProvider>
  );
  await waitFor(() => {
    expect(listeners["stream-failed"]).toBeDefined();
  });
}

describe("LogViewer when a live stream dies", () => {
  beforeEach(() => {
    for (const k of Object.keys(listeners)) delete listeners[k];
    vi.clearAllMocks();
  });

  it("shows the failure instead of the empty state", async () => {
    await renderStreaming();

    // Before the failure, the pane is in its "attached, nothing yet"
    // state — the state that used to cover a broken stream too.
    expect(screen.getByText(/No output yet/)).toBeInTheDocument();

    fireFailure(
      "broken",
      "The log stream from default/log-demo-7f9 broke — connection reset."
    );

    await waitFor(() => {
      expect(screen.getByTestId("log-stream-failure")).toBeInTheDocument();
    });
    expect(screen.queryByText(/No output yet/)).not.toBeInTheDocument();
  });

  it("offers a reconnect for a connection that broke", async () => {
    await renderStreaming();

    fireFailure("broken", "connection reset by peer");

    await waitFor(() => {
      expect(screen.getByTestId("log-stream-failure")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Lost the log stream from log-demo-7f9\/app/)
    ).toBeInTheDocument();
    expect(screen.getByText("connection reset by peer")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Reconnect/ })
    ).toBeInTheDocument();
  });

  it("says a deleted pod is gone and offers no pointless retry", async () => {
    await renderStreaming();

    fireFailure(
      "gone",
      "default/log-demo-7f9 stopped streaming — container app is no longer running."
    );

    await waitFor(() => {
      expect(screen.getByTestId("log-stream-failure")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Stream ended — log-demo-7f9\/app is gone/)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/container app is no longer running/)
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Reconnect/ }),
      "a deleted pod cannot be reconnected to"
    ).not.toBeInTheDocument();
  });

  it("marks the dead container in the legend, not just above the list", async () => {
    await renderStreaming();

    // A container that stopped and a container that is merely quiet both end
    // at a number; the legend is where the reader looks to tell them apart.
    expect(screen.getByTestId("log-legend")).toHaveTextContent("app");
    expect(screen.getByTestId("log-legend")).not.toHaveTextContent("ended");

    fireFailure("gone", "container app is no longer running.");

    await waitFor(() => {
      expect(screen.getByTestId("log-legend")).toHaveTextContent("ended");
    });
  });

  it("keeps the density strip out of the way until there is a shape", async () => {
    await renderStreaming();

    // Not an empty 34px box that reads as a rendering fault.
    expect(screen.getByText(/Nothing to map yet/)).toBeInTheDocument();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("names every toolbar control", async () => {
    await renderStreaming();

    // The five unlabelled icon buttons this replaced were a quiz, not a
    // toolbar. Nothing here may be reachable by icon alone.
    for (const control of screen.getAllByRole("button")) {
      const name =
        control.textContent?.trim() ||
        control.getAttribute("aria-label") ||
        control.getAttribute("title");
      expect(name, `an unnamed control: ${control.outerHTML}`).toBeTruthy();
    }
  });
});

/** One batch, as the backend emits it. Released after the reorder window. */
function fireBatch(
  lines: Array<{ at: number; level: string | null; message: string }>
) {
  act(() => {
    listeners["log-batch"]!({
      payload: {
        stream_id: "stream-id-1",
        lines: lines.map(({ at, level, message }) => ({
          message,
          timestamp: new Date(at).toISOString(),
          level,
          format: "plain",
          fields: null,
          raw: message,
        })),
      },
    });
  });
}

const START = Date.parse("2026-08-06T12:00:00.000Z");

describe("a chip promoted to intake", () => {
  beforeEach(() => {
    for (const k of Object.keys(listeners)) delete listeners[k];
    vi.clearAllMocks();
  });

  async function withChips(...typed: string[]) {
    await renderStreaming();
    fireBatch(
      Array.from({ length: 40 }, (_, i) => ({
        at: START + i * 100,
        level: "warn",
        message: `line ${i}`,
      }))
    );
    const input = screen.getByLabelText("Filter the log");
    const user = userEvent.setup();
    for (const term of typed) {
      await user.type(input, `${term}{Enter}`);
    }
    return user;
  }

  /** What the status bar says the buffer holds. */
  const kept = () =>
    screen.getByText(/^of .* kept$/).parentElement?.textContent ?? "";

  const configs = () =>
    vi
      .mocked(commands.streamPodLogs)
      .mock.calls.map(([config]) => config as StreamLogConfig);

  it("restarts the stream with the term, and keeps every line it holds", async () => {
    const user = await withChips("level>=warn");

    await waitFor(() => expect(kept()).toMatch(/^40/));
    expect(configs()).toHaveLength(1);
    expect(configs()[0].intake).toEqual([]);

    await user.click(
      screen.getByRole("button", {
        name: /Keep only lines matching level≥warn/,
      })
    );

    await waitFor(() => expect(configs()).toHaveLength(2), { timeout: 3000 });
    const restarted = configs()[1];
    expect(restarted.intake).toEqual([
      { kind: "level", op: "≥", value: "warn" },
    ]);
    // Nothing is thrown away by promoting, so nothing is asked for again
    // either: a backfill would hand back the tail the buffer still holds.
    expect(restarted.tailLines).toBe(0);
    expect(kept(), "the buffer is not cleared by promoting").toMatch(/^40/);
  });

  it("makes three flips one restart", async () => {
    const user = await withChips("level>=warn", "boom");

    await user.click(
      screen.getByRole("button", {
        name: /Keep only lines matching level≥warn/,
      })
    );
    await user.click(
      screen.getByRole("button", { name: /Keep only lines matching boom/ })
    );
    await user.click(
      screen.getByRole("button", {
        name: /Stop discarding lines that do not match boom/,
      })
    );

    await waitFor(() => expect(configs()).toHaveLength(2), { timeout: 3000 });
    expect(configs()[1].intake).toEqual([
      { kind: "level", op: "≥", value: "warn" },
    ]);
    // And no fourth: the settle window closed once.
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(configs()).toHaveLength(2);
  });
});

describe("the density strip", () => {
  beforeEach(() => {
    for (const k of Object.keys(listeners)) delete listeners[k];
    vi.clearAllMocks();
    // The mode is a remembered preference, so one test's choice would
    // otherwise be the next one's starting state.
    useDisplaySettingsStore.setState({ densityStrip: "full" });
  });

  async function renderWithShape() {
    await renderStreaming();
    // Twenty seconds of quiet with one burst of errors in the middle of it.
    fireBatch(
      Array.from({ length: 120 }, (_, i) => ({
        at: START + i * 167,
        level: i >= 60 && i < 70 ? "error" : "info",
        message: `line ${i}`,
      }))
    );
    await waitFor(() =>
      expect(screen.getByRole("listbox")).toBeInTheDocument()
    );
    return screen.getByRole("listbox");
  }

  it("slices the buffer and says how, in words as well as bars", async () => {
    const strip = await renderWithShape();

    // 20 seconds of lines, sliced fine enough to be a map: gapless, so
    // the slice count is the span over the slice and not the batch count.
    expect(within(strip).getAllByRole("option").length).toBeGreaterThan(3);

    // Bar heights are worth nothing to a screen reader, so the same
    // findings are stated outright.
    expect(
      screen.getByText(/Density of the log over time: \d+ slices of/)
    ).toBeInTheDocument();
    expect(screen.getByText(/Errors in \d+ slice/)).toBeInTheDocument();
    expect(
      screen.getByText(/Left and right arrows move between slices/)
    ).toBeInTheDocument();
  });

  it("never leaves an error visible only as a colour", async () => {
    const strip = await renderWithShape();

    // In the header, as a count.
    expect(screen.getByText(/10 errors in \d+ slice/)).toBeInTheDocument();
    // And on the slice itself, as its accessible name.
    expect(
      within(strip)
        .getAllByRole("option")
        .filter((slice) =>
          /errors/.test(slice.getAttribute("aria-label") ?? "")
        ).length
    ).toBeGreaterThan(0);
  });

  it("keeps the map when it is collapsed to a band", async () => {
    const user = userEvent.setup();
    const strip = await renderWithShape();
    const slices = within(strip).getAllByRole("option").length;

    await user.click(
      screen.getByRole("button", { name: /Collapse the density strip/ })
    );

    // Same listbox, same slices, same spoken summary: the collapse takes
    // away the chart and nothing that navigates.
    expect(screen.getByTestId("log-density-strip")).toHaveAttribute(
      "data-mode",
      "band"
    );
    const banded = screen.getByRole("listbox");
    expect(within(banded).getAllByRole("option")).toHaveLength(slices);
    expect(
      screen.getByText(/Left and right arrows move between slices/)
    ).toBeInTheDocument();
    // What it does give up: the chart's own words.
    expect(screen.queryByText(/click to jump · drag to filter/)).toBeNull();

    await user.click(
      screen.getByRole("button", { name: /Expand the density strip/ })
    );
    expect(screen.getByTestId("log-density-strip")).toHaveAttribute(
      "data-mode",
      "full"
    );
  });

  it("hides the strip only from the menu, which is also the way back", async () => {
    const user = userEvent.setup();
    await renderWithShape();

    await user.click(screen.getByRole("button", { name: "More log actions" }));
    await user.click(screen.getByRole("menuitemradio", { name: "Hidden" }));

    await waitFor(() =>
      expect(screen.queryByTestId("log-density-strip")).toBeNull()
    );
    expect(screen.queryByRole("listbox")).toBeNull();

    await user.click(screen.getByRole("button", { name: "More log actions" }));
    await user.click(screen.getByRole("menuitemradio", { name: "Full" }));

    await waitFor(() =>
      expect(screen.getByTestId("log-density-strip")).toBeInTheDocument()
    );
  });

  it("says so instead of drawing one bar over everything", async () => {
    await renderStreaming();
    fireBatch(
      Array.from({ length: 30 }, (_, i) => ({
        at: START + i,
        level: "info",
        message: `line ${i}`,
      }))
    );

    await waitFor(() =>
      expect(
        screen.getByText(/too short a stretch to slice/)
      ).toBeInTheDocument()
    );
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
