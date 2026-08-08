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
    // One id per container, so a test can kill one stream and leave the
    // rest attached. The single-container pod most tests use keeps the
    // original id.
    streamPodLogs: vi.fn(async (config: { container: string }) =>
      config.container === "app" ? "stream-id-1" : `stream-${config.container}`
    ),
    stopLogStream: vi.fn(async () => undefined),
    logStreamSubscribed: vi.fn(async () => undefined),
    getPodLogs: vi.fn(async () => []),
  },
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { commands } from "@/lib/commands";
import type {
  ContainerInfo,
  StreamLogConfig,
  TerminationInfo,
} from "@/generated/types";
import type { StreamFailureKind } from "@/lib/stream-failure";
import { useDisplaySettingsStore } from "@/stores/displaySettingsStore";
import { LogViewer } from "./LogViewer";

function container(
  name: string,
  overrides: Partial<ContainerInfo> = {}
): ContainerInfo {
  return {
    name,
    image: "busybox:1.36",
    ready: true,
    phase: "app",
    state: { type: "running" },
    lastTerminated: null,
    restartCount: 0,
    ports: [],
    env: [],
    envFrom: [],
    ...overrides,
  };
}

const props = {
  podName: "log-demo-7f9",
  namespace: "default",
  containers: [container("app")],
};

function fireFailure(
  kind: StreamFailureKind,
  message: string,
  streamId = "stream-id-1"
) {
  listeners["stream-failed"]!({
    payload: { stream_id: streamId, kind, message },
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

  it("says how the container died, not only that it is gone", async () => {
    const termination: TerminationInfo = {
      exitCode: 1,
      signal: null,
      reason: "Error",
      message: null,
      startedAt: null,
      finishedAt: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
    };
    render(
      <TooltipProvider>
        <LogViewer
          {...props}
          containers={[
            container("app", {
              ready: false,
              state: { type: "waiting", reason: "CrashLoopBackOff" },
              lastTerminated: termination,
              restartCount: 653,
            }),
          ]}
        />
      </TooltipProvider>
    );
    await waitFor(() => {
      expect(listeners["stream-failed"]).toBeDefined();
    });

    fireFailure("gone", "container app is no longer running.");

    await waitFor(() => {
      expect(screen.getByTestId("log-stream-termination")).toBeInTheDocument();
    });
    // The exit code, the reason, when, and how often — all of it was in
    // the pod status while the pane said only "no longer running".
    expect(screen.getByTestId("log-stream-termination")).toHaveTextContent(
      "It exited Error · exit 1, 4m ago · 653 restarts so far."
    );
  });

  // "There is no earlier run" and "we could not fetch it" arrive on the
  // same channel and the apiserver phrases the first as a 400 ending in
  // "not found". Read as a failure it would offer Reconnect for a
  // question that has no answer however many times it is asked.
  it("reads a missing previous run as an absence, not as a broken stream", async () => {
    await renderStreaming();

    fireFailure(
      "no-previous-run",
      "There is no previous run of app to show — it has not restarted."
    );

    const notice = await screen.findByTestId("log-stream-failure");
    expect(notice).toHaveTextContent("No previous run of app");
    expect(notice).not.toHaveTextContent("Lost the log stream");
    expect(
      within(notice).queryByRole("button", { name: /reconnect/i })
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("log-legend")).toHaveTextContent(
      "no earlier run"
    );
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

/**
 * The pane used to open on a fifth of a five-container log, because the
 * Deployment page handed it `containers[0]` as a starting filter. Nothing
 * near the reader said so: the legend dimmed four chips and the count sat
 * in the far corner of the footer.
 */
describe("what the pane shows on open", () => {
  beforeEach(() => {
    for (const k of Object.keys(listeners)) delete listeners[k];
    vi.clearAllMocks();
  });

  it("hides no container", async () => {
    render(
      <TooltipProvider>
        <LogViewer
          {...props}
          containers={[
            container("app"),
            container("sidecar"),
            container("proxy"),
          ]}
        />
      </TooltipProvider>
    );
    await waitFor(() => {
      expect(screen.getByTestId("log-legend")).toBeInTheDocument();
    });
    for (const chip of within(screen.getByTestId("log-legend")).getAllByRole(
      "button"
    )) {
      expect(chip).toHaveAttribute("aria-pressed", "true");
    }
  });

  it("says so beside the log when grouping is what emptied it", async () => {
    await renderStreaming();
    fireBatch(
      Array.from({ length: 60 }, (_, i) => ({
        at: START + i * 100,
        level: "info",
        message: "the same thing, again",
      }))
    );

    await waitFor(() => {
      expect(screen.getByTestId("log-grouped-notice")).toBeInTheDocument();
    });
    expect(screen.getByTestId("log-grouped-notice")).toHaveTextContent(
      "This row stands for 60 lines"
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Show every line" })
    );
    expect(screen.queryByTestId("log-grouped-notice")).not.toBeInTheDocument();
  });
});

/**
 * The pod that is stuck in init is the whole reason this exists. Its app
 * container has never started, so the pane that opens on everything
 * opens on nothing, while the log that says why sits on a container the
 * viewer did not know existed, on a run it could not ask for.
 */
describe("LogViewer on a pod held in init", () => {
  const stuck = [
    container("wait-for-db", {
      phase: "init",
      state: {
        type: "terminated",
        termination: {
          exitCode: 0,
          signal: null,
          reason: "Completed",
          message: null,
          startedAt: null,
          finishedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
        },
      },
    }),
    container("migrate", {
      phase: "init",
      ready: false,
      state: { type: "waiting", reason: "CrashLoopBackOff" },
      restartCount: 9,
      lastTerminated: {
        exitCode: 1,
        signal: null,
        reason: "Error",
        message: null,
        startedAt: null,
        finishedAt: new Date(Date.now() - 40 * 1000).toISOString(),
      },
    }),
    container("app", {
      ready: false,
      state: { type: "waiting", reason: "PodInitializing" },
    }),
  ];

  beforeEach(() => {
    for (const k of Object.keys(listeners)) delete listeners[k];
    vi.clearAllMocks();
  });

  async function renderStuck() {
    render(
      <TooltipProvider>
        <LogViewer {...props} containers={stuck} />
      </TooltipProvider>
    );
    await waitFor(() => {
      expect(screen.getByTestId("log-legend")).toBeInTheDocument();
    });
  }

  it("opens on the failing init container's previous run", async () => {
    await renderStuck();

    const configs = vi
      .mocked(commands.streamPodLogs)
      .mock.calls.map(([config]) => config as StreamLogConfig);
    // Every container still streams — hiding one is a view filter and
    // nothing more — but all of them read the earlier run, because the
    // pane can only be reading one run at a time and say which.
    expect(configs.map((c) => c.container).sort()).toEqual([
      "app",
      "migrate",
      "wait-for-db",
    ]);
    expect(configs.every((c) => c.previous)).toBe(true);

    const chips = within(screen.getByTestId("log-legend")).getAllByRole(
      "button"
    );
    const pressed = chips
      .filter((chip) => chip.getAttribute("aria-pressed") === "true")
      .map((chip) => chip.textContent);
    expect(pressed).toHaveLength(1);
    expect(pressed[0]).toContain("migrate");
  });

  it("says which container and which run, where the reader is looking", async () => {
    await renderStuck();
    const notice = screen.getByTestId("log-focus-notice");
    expect(notice).toHaveTextContent("Opened on migrate alone");
    expect(notice).toHaveTextContent("the pod is stuck in init");
    expect(notice).toHaveTextContent(
      "These are the lines of the run that failed, not of the current one."
    );
    expect(
      screen.getByRole("button", { name: "Show the current run" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show every container" })
    ).toBeInTheDocument();
  });

  it("reopens the streams on the current run when asked", async () => {
    await renderStuck();
    vi.mocked(commands.streamPodLogs).mockClear();

    await userEvent.click(
      screen.getByRole("button", { name: "Show the current run" })
    );

    await waitFor(() => {
      expect(commands.streamPodLogs).toHaveBeenCalled();
    });
    const configs = vi
      .mocked(commands.streamPodLogs)
      .mock.calls.map(([config]) => config as StreamLogConfig);
    expect(configs.every((c) => c.previous)).toBe(false);
    expect(screen.queryByTestId("log-focus-notice")).not.toBeInTheDocument();
  });

  it("keeps a container's missing earlier run to one line in the legend", async () => {
    await renderStuck();
    // `app` has never restarted, so asking for its previous run comes
    // back empty. `migrate` is reading perfectly well beside it, so this
    // is a fact about one container and belongs on its chip — banners
    // for it would bury the log they were describing.
    fireFailure("no-previous-run", "There is no previous run of app to show.");

    await waitFor(() => {
      expect(
        within(screen.getByTestId("log-legend")).getByText("· no earlier run")
      ).toBeInTheDocument();
    });
    expect(screen.queryByTestId("log-stream-failure")).not.toBeInTheDocument();
    expect(screen.queryByTestId("log-no-earlier-run")).not.toBeInTheDocument();
  });

  it("banners only the container in view, not the ones behind the legend", async () => {
    await renderStuck();
    for (const [name, id] of [
      ["wait-for-db", "stream-wait-for-db"],
      ["app", "stream-id-1"],
    ] as const) {
      fireFailure(
        "no-previous-run",
        `There is no previous run of ${name} to show.`,
        id
      );
    }

    // Soloed onto the one container that has nothing earlier: one
    // banner, for it. `app` is hidden and failed the same way, and a
    // banner about a container the reader cannot see is noise.
    await userEvent.keyboard("1");
    await waitFor(() => {
      expect(screen.getAllByTestId("log-stream-failure")).toHaveLength(1);
    });
    expect(screen.getByTestId("log-stream-failure")).toHaveTextContent(
      "No previous run of wait-for-db"
    );
    expect(
      screen.getByRole("button", { name: "Show the current run" })
    ).toBeInTheDocument();
  });

  it("does not call a finished step's stream ending a disappearance", async () => {
    await renderStuck();
    await userEvent.click(
      screen.getByRole("button", { name: "Show the current run" })
    );
    await waitFor(() => {
      expect(commands.streamPodLogs).toHaveBeenCalled();
    });

    // `wait-for-db` succeeded. Reading it to the end is the read
    // finishing, and "is gone" over a step that worked is alarm for
    // nothing — the legend says "ended", the notice says the log is whole.
    fireFailure(
      "gone",
      "container wait-for-db is no longer running.",
      "stream-wait-for-db"
    );
    await userEvent.keyboard("1");

    await waitFor(() => {
      expect(screen.getByTestId("log-finished-notice")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("log-stream-failure")).not.toBeInTheDocument();
    expect(screen.getByTestId("log-legend")).toHaveTextContent("ended");
  });

  it("says a container that never started has nothing to say, not that the stream broke", async () => {
    await renderStuck();
    // The apiserver answers a stream for a `PodInitializing` container
    // with 300 characters of `BadRequest (ErrorResponse { ... })`. The
    // pod's own status has the reason in one word.
    fireFailure(
      "broken",
      'ApiError: container "app" in pod "init-demo" is waiting to start: PodInitializing: BadRequest (ErrorResponse { status: "Failure" })'
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Show every container" })
    );

    const notice = await screen.findByTestId("log-stream-failure");
    expect(notice).toHaveTextContent("app has not started");
    expect(notice).toHaveTextContent("PodInitializing");
    expect(notice).not.toHaveTextContent("ErrorResponse");
  });

  it("says it once, with the way out, when nothing in view has an earlier run", async () => {
    await renderStuck();
    await userEvent.click(
      screen.getByRole("button", { name: "Show every container" })
    );

    // Three containers that have never restarted, and the pane is empty
    // because of it. Three banners is not three answers, it is one
    // answer three times over the log it is hiding.
    for (const name of ["wait-for-db", "migrate"]) {
      fireFailure(
        "no-previous-run",
        `There is no previous run of ${name} to show.`,
        `stream-${name}`
      );
    }
    fireFailure("no-previous-run", "There is no previous run of app to show.");

    await waitFor(() => {
      expect(screen.getByTestId("log-no-earlier-run")).toBeInTheDocument();
    });
    expect(screen.getByTestId("log-no-earlier-run")).toHaveTextContent(
      "none of them has restarted"
    );
    expect(screen.queryByTestId("log-stream-failure")).not.toBeInTheDocument();
  });
});

/**
 * Isolating one of five containers cost four clicks, one per container
 * to mute. Solo is the mute/solo pair from every audio tool: the same
 * gesture takes everything else off and puts it back.
 */
describe("soloing a container", () => {
  const many = [
    container("app"),
    container("proxy", { phase: "sidecar" }),
    container("web"),
  ];

  beforeEach(() => {
    for (const k of Object.keys(listeners)) delete listeners[k];
    vi.clearAllMocks();
  });

  async function renderMany() {
    render(
      <TooltipProvider>
        <LogViewer {...props} containers={many} />
      </TooltipProvider>
    );
    await waitFor(() => {
      expect(screen.getByTestId("log-legend")).toBeInTheDocument();
    });
    return within(screen.getByTestId("log-legend"));
  }

  const pressedNames = (legend: ReturnType<typeof within>): (string | null)[] =>
    legend
      .getAllByRole("button")
      .filter(
        (chip: HTMLElement) => chip.getAttribute("aria-pressed") === "true"
      )
      .map((chip: HTMLElement) => chip.textContent);

  it("takes everything else off on a double-click, and back on again", async () => {
    const legend = await renderMany();
    const proxy = legend.getByRole("button", { name: /proxy/ });

    await userEvent.dblClick(proxy);
    expect(pressedNames(legend)).toHaveLength(1);

    await userEvent.dblClick(proxy);
    expect(pressedNames(legend)).toHaveLength(3);
  });

  it("solos by position from the keyboard, and 0 brings them back", async () => {
    const legend = await renderMany();

    await userEvent.keyboard("3");
    const soloed = pressedNames(legend);
    expect(soloed).toHaveLength(1);
    expect(soloed[0]).toContain("web");

    await userEvent.keyboard("0");
    expect(pressedNames(legend)).toHaveLength(3);
  });

  it("leaves a digit typed into the query alone", async () => {
    const legend = await renderMany();
    // The query box is the one place in this pane where a digit is a
    // digit; a shortcut that fires there would make it untypeable.
    await userEvent.click(
      screen.getByRole("combobox", { name: "Filter the log" })
    );
    await userEvent.keyboard("2");

    expect(pressedNames(legend)).toHaveLength(3);
  });
});

/**
 * An init container that finished twenty minutes ago looks exactly like
 * an app container that has gone quiet, down to Follow sitting there
 * doing nothing.
 */
describe("reading a container whose run is over", () => {
  beforeEach(() => {
    for (const k of Object.keys(listeners)) delete listeners[k];
    vi.clearAllMocks();
  });

  it("holds finished init lines out of a running pod and offers them", async () => {
    render(
      <TooltipProvider>
        <LogViewer
          {...props}
          containers={[
            container("prepare", {
              phase: "init",
              state: {
                type: "terminated",
                termination: {
                  exitCode: 0,
                  signal: null,
                  reason: "Completed",
                  message: null,
                  startedAt: null,
                  finishedAt: new Date(
                    Date.now() - 21 * 60 * 1000
                  ).toISOString(),
                },
              },
            }),
            container("proxy", { phase: "sidecar" }),
            container("app"),
          ]}
        />
      </TooltipProvider>
    );
    await waitFor(() => {
      expect(screen.getByTestId("log-focus-notice")).toBeInTheDocument();
    });
    expect(screen.getByTestId("log-focus-notice")).toHaveTextContent(
      "ran before the pod started"
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Interleave them anyway" })
    );
    expect(screen.queryByTestId("log-focus-notice")).not.toBeInTheDocument();

    // Soloed, the pane says the log is finished rather than letting the
    // reader wonder why Follow is doing nothing.
    await userEvent.dblClick(
      within(screen.getByTestId("log-legend")).getByRole("button", {
        name: /prepare/,
      })
    );
    expect(screen.getByTestId("log-finished-notice")).toHaveTextContent(
      "so this log is complete and will not grow"
    );
  });
});
