import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { act, render, screen } from "@testing-library/react";

const session = vi.hoisted(() => ({
  error: null as string | null,
  resize: vi.fn(async (_cols: number, _rows: number) => undefined),
}));

vi.mock("@/hooks/useGenericTerminalSession", async () => {
  const { useEffect, useState } = await import("react");
  return {
    useGenericTerminalSession: ({
      sessionId,
    }: {
      sessionId: string | null;
    }) => {
      const [status, setStatus] = useState("idle");
      useEffect(
        () =>
          setStatus(session.error ? "error" : sessionId ? "connected" : "idle"),
        [sessionId]
      );
      return {
        status,
        error: session.error,
        send: vi.fn(),
        resize: session.resize,
        disconnect: vi.fn(),
      };
    },
  };
});

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    loadAddon(addon: { activate?: (term: unknown) => void }) {
      addon.activate?.(this);
    }
    open() {}
    onData() {}
    write() {}
    writeln() {}
    dispose() {}
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    term: { cols: number; rows: number } | null = null;
    activate(term: { cols: number; rows: number }) {
      this.term = term;
    }
    fit() {
      if (this.term) Object.assign(this.term, { cols: 132, rows: 41 });
    }
  },
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class {},
}));

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

import { Terminal } from "./TerminalImpl";

beforeEach(() => {
  vi.useFakeTimers();
  session.resize.mockClear();
});

afterEach(() => vi.useRealTimers());

/**
 * Coming back to a parked shell, the pane is connected before it has fitted
 * itself, and xterm's unfitted 80x24 reached the shell: busybox redrew its
 * prompt for it and again for the real size. Fails if a size is sent before
 * the pane has measured itself.
 */
it("tells a running shell the pane's size only once the pane has fitted", async () => {
  render(<Terminal sessionId="term-kept" ownsSession={false} />);
  expect(session.resize).not.toHaveBeenCalled();

  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

  expect(session.resize.mock.calls).toEqual([[132, 41]]);
});

/**
 * With no session id yet the badge said "Idle" over a blank body for the
 * whole handshake. Fails if a pane told it is connecting says anything else.
 */
it("says Connecting while the session it was told is opening has no id yet", () => {
  render(<Terminal sessionId={null} connecting />);
  expect(screen.getAllByText("Connecting")).toHaveLength(2);
});

/** Fails if a pane that was not told it is connecting claims to be. */
it("says Idle when no session is wanted", () => {
  render(<Terminal sessionId={null} />);
  expect(screen.getByText("Idle")).toBeInTheDocument();
  expect(screen.queryByText("Connecting")).toBeNull();
});

/** Fails if the reason a connection broke is cut at 240px with no way to read it. */
it("keeps the whole connection error readable in a tooltip", () => {
  session.error =
    "failed to upgrade to a WebSocket connection: 500 Internal Server Error";
  render(<Terminal sessionId="term-1" />);
  expect(
    screen.getByTitle(/failed to upgrade to a WebSocket connection: 500/)
  ).toBeInTheDocument();
  session.error = null;
});
