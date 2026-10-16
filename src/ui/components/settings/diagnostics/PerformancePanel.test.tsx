import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { perf } from "@/lib/perf";
import { perfSession } from "@/lib/perf-session";
import { PerformancePanel } from "./PerformancePanel";

afterEach(() => {
  vi.restoreAllMocks();
  perf.stop();
  perf.backend = undefined;
});

function recorded() {
  perf.start(0);
  perf.record({ kind: "ipc", name: "getResourceConnections", ms: 640, at: 1 });
  perf.record({ kind: "ipc", name: "getCurrentContext", ms: 4, at: 2 });
  perf.stop(3);
}

const rowOf = (name: string) => screen.getByText(name).closest("tr")!;

describe("PerformancePanel", () => {
  /** Without the backend's own time beside the window's, nothing says whether a slow call waited on the cluster or on the IPC and the webview. */
  it("puts the backend's time for a command beside the window's, and marks one it does not time", () => {
    recorded();
    perf.backend = {
      eventsEmitted: 0,
      eventBytes: 0,
      maxEventBytes: 0,
      watchChanges: 0,
      commands: {
        getResourceConnections: {
          count: 1,
          p50: 610,
          p95: 610,
          max: 610,
          maxApiCalls: 12,
        },
      },
    };

    render(<PerformancePanel />);

    expect(
      within(rowOf("getResourceConnections")).getByText("610 ms · 610 ms")
    ).toBeTruthy();
    expect(
      within(rowOf("getCurrentContext")).getByText("not timed")
    ).toBeTruthy();
  });

  /** A column of blanks before the backend has been asked would read as a backend that took no time. */
  it("draws no backend column until the backend's counters are in", () => {
    recorded();

    render(<PerformancePanel />);

    expect(screen.queryByText("in the backend, p50 · max")).toBeNull();
  });

  /**
   * Sam read the recorder while it ran, found no backend column and called
   * it missing: the backend is asked for its counters only at Stop. Fails
   * if a running recording hides the column instead of saying when it fills in.
   */
  it("shows the backend column while recording, saying it fills in at Stop", () => {
    vi.spyOn(perfSession, "current", "get").mockReturnValue({
      phase: "recording",
      error: null,
    });
    perf.start(0);
    perf.record({ kind: "ipc", name: "getClusterOverview", ms: 33, at: 1 });

    render(<PerformancePanel />);

    expect(screen.getByText("in the backend, p50 · max")).toBeTruthy();
    expect(
      within(rowOf("getClusterOverview")).getByText("at Stop")
    ).toBeTruthy();
  });
});
