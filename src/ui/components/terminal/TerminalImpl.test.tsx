import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { act, render } from "@testing-library/react";

const session = vi.hoisted(() => ({
  resize: vi.fn(async (_cols: number, _rows: number) => undefined),
}));

vi.mock("@/hooks/useGenericTerminalSession", async () => {
  const { useEffect, useState } = await import("react");
  return {
    useGenericTerminalSession: () => {
      const [status, setStatus] = useState("idle");
      useEffect(() => setStatus("connected"), []);
      return {
        status,
        error: null,
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
