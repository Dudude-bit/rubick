import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

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
  render(<LogViewer {...props} />);
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
