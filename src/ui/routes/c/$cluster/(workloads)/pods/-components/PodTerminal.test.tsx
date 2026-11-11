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
  close: undefined as undefined | (() => void),
}));
vi.mock("@/components/terminal/Terminal", async () => {
  const { useEffect } = await import("react");
  return {
    Terminal: ({
      sessionId,
      onSize,
      replay,
      onClose,
      closeLabel,
    }: {
      sessionId: string | null;
      onSize?: (cols: number, rows: number) => void;
      replay?: () => string;
      onClose?: () => void;
      closeLabel?: string;
    }) => {
      pane.close = onClose;
      useEffect(() => {
        pane.measure = () => onSize?.(132, 41);
        if (!pane.holdSize) pane.measure();
      }, [onSize]);
      return (
        <div
          data-testid="terminal-stub"
          data-session-id={sessionId ?? ""}
          data-replay={sessionId ? (replay?.() ?? "") : ""}
          data-close-label={closeLabel ?? ""}
        />
      );
    },
  };
});

import { commands } from "@/lib/commands";
import { heard, useKeptShellStore } from "@/stores/keptShellStore";
import { useScopeTabStore } from "@/stores/scopeTabStore";
import { PodTerminal } from "./PodTerminal";

const closePane = () => pane.close?.();

beforeEach(() => useKeptShellStore.setState({ shells: [] }));

/** The reader asked: the pane may open its one shell. */
const props = {
  podName: "log-demo-7f9",
  namespace: "default",
  uid: "uid-log-demo",
  containerName: "app",
  claim: () => true,
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
   * The pane goes when its tab is parked; the shell is the reader's and stays
   * with the tab. Fails if the pane ends it, or leaves it kept by nobody.
   */
  it("leaves its session with its tab when it goes away", async () => {
    const { unmount } = render(<PodTerminal {...props} />);
    await waitFor(() =>
      expect(screen.getByTestId("terminal-stub")).toHaveAttribute(
        "data-session-id",
        "term-1"
      )
    );

    unmount();

    expect(commands.closeTerminal).not.toHaveBeenCalled();
    expect(useKeptShellStore.getState().shells).toMatchObject([
      {
        id: "term-1",
        tab: useScopeTabStore.getState().activeId,
        pod: "log-demo-7f9",
        container: "app",
      },
    ]);
  });

  /**
   * Coming back to the page attaches to the shell the tab kept, with what it
   * printed while nobody watched. Fails if a second shell is opened, or the
   * pane starts blank.
   */
  it("attaches to the shell its tab kept, with what it printed meanwhile", async () => {
    useKeptShellStore.getState().keep({
      id: "term-kept",
      tab: useScopeTabStore.getState().activeId,
      context: "",
      namespace: "default",
      pod: "log-demo-7f9",
      uid: "uid-log-demo",
      container: "app",
    });
    heard("term-kept", "/srv/app # ls\r\nindex.html\r\n/srv/app # ");

    render(<PodTerminal {...props} />);

    const pane = screen.getByTestId("terminal-stub");
    expect(pane).toHaveAttribute("data-session-id", "term-kept");
    expect(pane).toHaveAttribute(
      "data-replay",
      "/srv/app # ls\r\nindex.html\r\n/srv/app # "
    );
    await act(async () => {});
    expect(commands.openPodShell).not.toHaveBeenCalled();
  });

  /** A shell kept for another container is not this pane's. */
  it("opens its own shell when the kept one is in another container", async () => {
    useKeptShellStore.getState().keep({
      id: "term-sidecar",
      tab: useScopeTabStore.getState().activeId,
      context: "",
      namespace: "default",
      pod: "log-demo-7f9",
      uid: "uid-log-demo",
      container: "sidecar",
    });

    await renderConnected();

    expect(commands.openPodShell).toHaveBeenCalledTimes(1);
  });

  /**
   * A StatefulSet pod comes back under its name as another pod. Fails if the
   * pane takes the shell kept in the pod that was deleted for its own.
   */
  it("does not attach to a shell kept in an earlier pod of the same name", async () => {
    useKeptShellStore.getState().keep({
      id: "term-before",
      tab: useScopeTabStore.getState().activeId,
      context: "",
      namespace: "default",
      pod: "log-demo-7f9",
      uid: "uid-deleted",
      container: "app",
    });

    await renderConnected();

    expect(commands.openPodShell).toHaveBeenCalledTimes(1);
  });
});

/**
 * An exec is a change to the cluster, so the pane opens one only on an ask
 * the reader made and nobody has spent: a pane that mounts again after its
 * shell died, or beside a kept shell that has just gone, has none.
 */
describe("a pane with no ask left to spend", () => {
  beforeEach(() => {
    for (const k of Object.keys(listeners)) delete listeners[k];
    vi.clearAllMocks();
  });

  /** Fails if mounting is enough to open an exec, which is how one reopened in a restarted container. */
  it("opens nothing and says the shell ended", async () => {
    const onClose = vi.fn();
    render(<PodTerminal {...props} claim={() => false} onClose={onClose} />);

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(commands.openPodShell).not.toHaveBeenCalled();
  });

  /** Fails if the pane asks twice for one shell, or opens before it asked. */
  it("spends the ask once, for the one shell it opens", async () => {
    const claim = vi.fn(() => true);
    render(<PodTerminal {...props} claim={claim} />);

    await waitFor(() => expect(commands.openPodShell).toHaveBeenCalledOnce());
    expect(claim).toHaveBeenCalledOnce();
  });

  /** Fails if attaching to a kept shell spends an ask the reader made for another. */
  it("leaves the ask alone when it attaches to a kept shell", async () => {
    useKeptShellStore.getState().keep({
      id: "term-kept",
      tab: useScopeTabStore.getState().activeId,
      context: "",
      namespace: "default",
      pod: "log-demo-7f9",
      uid: "uid-log-demo",
      container: "app",
    });
    const claim = vi.fn(() => true);
    render(<PodTerminal {...props} claim={claim} />);
    await act(async () => {});

    expect(claim).not.toHaveBeenCalled();
    expect(commands.openPodShell).not.toHaveBeenCalled();
  });

  /** Lena met the same shell as "Терминал" and "Оболочка". Fails if its × calls it anything but a shell. */
  it("calls its close button ending the shell", async () => {
    await renderConnected();
    expect(screen.getByTestId("terminal-stub")).toHaveAttribute(
      "data-close-label",
      "End the shell in log-demo-7f9"
    );
  });

  /** Ending it is the reader's own act. Fails if × leaves the shell kept or running. */
  it("ends the shell and lets go of it when the reader closes the pane", async () => {
    await renderConnected();
    expect(useKeptShellStore.getState().shells).toHaveLength(1);

    act(() => {
      closePane();
    });

    expect(commands.closeTerminal).toHaveBeenCalledWith("term-1");
    expect(useKeptShellStore.getState().shells).toEqual([]);
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
