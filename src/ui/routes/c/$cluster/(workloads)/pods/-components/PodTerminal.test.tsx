import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { act, render, screen, waitFor } from "@testing-library/react";

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
    openPodShell: vi.fn(async () => "term-1"),
    closeTerminal: vi.fn(async () => undefined),
    getPod: vi.fn(async () => ({
      containers: [{ name: "app", state: { type: "running" } }],
      status: { phase: "Running" },
    })),
  },
}));

// The real one is an xterm-backed lazy chunk; none of that is under test.
// It measures itself unless a test holds the measurement back.
const pane = vi.hoisted(() => ({
  measure: null as null | (() => void),
  holdSize: false,
}));
vi.mock("@/components/terminal/Terminal", async () => {
  const { useEffect } = await import("react");
  return {
    Terminal: ({
      sessionId,
      onSize,
    }: {
      sessionId: string | null;
      onSize?: (cols: number, rows: number) => void;
    }) => {
      useEffect(() => {
        pane.measure = () => onSize?.(132, 41);
        if (!pane.holdSize) pane.measure();
      }, [onSize]);
      return (
        <div data-testid="terminal-stub" data-session-id={sessionId ?? ""} />
      );
    },
  };
});

import { commands } from "@/lib/commands";
import { PodTerminal } from "./PodTerminal";

const props = {
  podName: "log-demo-7f9",
  namespace: "default",
  containerName: "app",
};

function fireFailure(kind: "gone" | "broken", message: string) {
  listeners["stream-failed"]!({
    payload: { stream_id: "term-1", kind, message },
  });
}

async function renderConnected() {
  render(<PodTerminal {...props} />);
  await waitFor(() => {
    expect(commands.openPodShell).toHaveBeenCalled();
    expect(listeners["stream-failed"]).toBeDefined();
  });
  await waitFor(() => {
    expect(screen.getByTestId("terminal-stub")).toHaveAttribute(
      "data-session-id",
      "term-1"
    );
  });
}

describe("PodTerminal when the session dies after openPodShell returned", () => {
  beforeEach(() => {
    for (const k of Object.keys(listeners)) delete listeners[k];
    vi.clearAllMocks();
  });

  it("falls into the reconnect banner when the upgrade is rejected", async () => {
    // The k3d reproduction: openPodShell hands back an id, the
    // WebSocket upgrade is answered with a 500 a moment later. Before
    // `stream-failed` existed this left a blank pane and no reason.
    await renderConnected();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    fireFailure(
      "broken",
      "Could not open the shell: failed to upgrade to a WebSocket connection: 500."
    );

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/No shell on log-demo-7f9\/app/)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/failed to upgrade to a WebSocket connection: 500/)
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Reconnect/ })
    ).toBeInTheDocument();
    expect(screen.getByTestId("terminal-stub")).toHaveAttribute(
      "data-session-id",
      ""
    );
  });

  it("says the container is gone and offers no reconnect", async () => {
    await renderConnected();

    fireFailure(
      "gone",
      'There is no container left to attach to: pods "log-demo-7f9" not found.'
    );

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/log-demo-7f9\/app is no longer available/)
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Reconnect/ }),
      "a container that is gone cannot be reconnected to"
    ).not.toBeInTheDocument();
  });

  it("ignores a failure belonging to another session", async () => {
    await renderConnected();

    listeners["stream-failed"]!({
      payload: {
        stream_id: "some-other-session",
        kind: "broken",
        message: "not ours",
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId("terminal-stub")).toHaveAttribute(
        "data-session-id",
        "term-1"
      );
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

/** What the backend sends when the shell's process exits. */
function closed(sessionId: string) {
  act(() =>
    listeners["terminal-closed"]?.({
      payload: { session_id: sessionId, status: null },
    })
  );
}

describe("a shell the reader exited", () => {
  beforeEach(() => {
    for (const k of Object.keys(listeners)) delete listeners[k];
    vi.clearAllMocks();
  });

  /** Fails if the pane goes on calling an exited shell connected. */
  it("keeps the session id until the backend says it ended", async () => {
    await renderConnected();

    closed("term-2");
    expect(screen.getByTestId("terminal-stub")).toHaveAttribute(
      "data-session-id",
      "term-1"
    );
  });

  /**
   * Leaving the page is leaving the shell. Fails if the pane goes away and
   * the session is left for nobody to close.
   */
  it("closes its session when it goes away", async () => {
    const { unmount } = render(<PodTerminal {...props} />);
    await waitFor(() =>
      expect(screen.getByTestId("terminal-stub")).toHaveAttribute(
        "data-session-id",
        "term-1"
      )
    );

    unmount();

    expect(commands.closeTerminal).toHaveBeenCalledWith("term-1");
  });
});

describe("a shell opened at the pane's size", () => {
  beforeEach(() => {
    for (const k of Object.keys(listeners)) delete listeners[k];
    vi.clearAllMocks();
    pane.holdSize = false;
  });

  /**
   * Lena's Shell opened on three prompts: busybox draws one more for each
   * resize, and the pane's size used to follow the shell. Fails if the
   * shell is opened before, or without, the size the pane measured.
   */
  it("waits for the pane to measure itself and opens at that size", async () => {
    pane.holdSize = true;
    render(<PodTerminal {...props} />);
    await waitFor(() => expect(pane.measure).not.toBeNull());
    expect(commands.openPodShell).not.toHaveBeenCalled();

    act(() => pane.measure!());

    await waitFor(() =>
      expect(commands.openPodShell).toHaveBeenCalledWith(
        "default",
        "log-demo-7f9",
        "app",
        null,
        132,
        41
      )
    );
  });

  /**
   * The page was left while the shell was still opening. Fails if the id
   * that answers afterwards is kept by nobody and the shell left running.
   */
  it("closes a session that answers after the pane went away", async () => {
    let answer!: (id: string) => void;
    vi.mocked(commands.openPodShell).mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve))
    );
    const { unmount } = render(<PodTerminal {...props} />);
    await waitFor(() => expect(commands.openPodShell).toHaveBeenCalled());

    unmount();
    await act(async () => answer("term-late"));

    expect(commands.closeTerminal).toHaveBeenCalledWith("term-late");
  });
});
