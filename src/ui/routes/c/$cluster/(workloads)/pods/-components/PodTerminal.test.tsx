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

vi.mock("@/stores/clusterStore", () => ({
  useClusterStore: () => "k3d-k8s-gui-dev",
}));

// The real one is an xterm-backed lazy chunk; none of that is under test.
vi.mock("@/components/terminal/Terminal", () => ({
  Terminal: ({ sessionId }: { sessionId: string | null }) => (
    <div data-testid="terminal-stub" data-session-id={sessionId ?? ""} />
  ),
}));

import { commands } from "@/lib/commands";
import { useTerminalSessionStore } from "@/stores/terminalSessionStore";
import { renderWithRouter } from "@/test/render";
import { TerminalsTab } from "../../../-shell/activity/TerminalsTab";
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
    useTerminalSessionStore.getState().clearAll();
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
    useTerminalSessionStore.getState().clearAll();
  });

  /**
   * Marco typed `exit`: the Shell tab said Ended while Activity > Terminals
   * listed the session "connected", the footer kept "1 terminal" and the
   * tab dot stayed green until the tab's ×. Fails if the session the
   * backend closed stays in the store every one of those reads.
   */
  it("leaves Activity, the footer count and the tab mark the moment it ends", async () => {
    await renderWithRouter(
      <>
        <PodTerminal {...props} />
        <TerminalsTab />
      </>
    );
    await waitFor(() => {
      expect(screen.getByTestId("terminal-stub")).toHaveAttribute(
        "data-session-id",
        "term-1"
      );
    });
    expect(screen.getByText(/app · connected/)).toBeInTheDocument();

    closed("term-1");

    await waitFor(() =>
      expect(screen.queryByText(/app · connected/)).not.toBeInTheDocument()
    );
    expect(useTerminalSessionStore.getState().sessions).toEqual([]);
  });

  /** Another pane's session closing is not this one's. */
  it("keeps its session when another one closes", async () => {
    await renderWithRouter(<PodTerminal {...props} />);
    await waitFor(() =>
      expect(useTerminalSessionStore.getState().sessions).toHaveLength(1)
    );

    closed("term-2");

    expect(useTerminalSessionStore.getState().sessions[0]).toMatchObject({
      id: "term-1",
      status: "connected",
    });
  });
});
