import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

// ----- Mocks -----

type Handler = (event: { payload: unknown }) => void;
const handlers: Record<string, Handler[]> = {};

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: Handler) => {
    (handlers[event] ??= []).push(handler);
    return () => {
      handlers[event] = (handlers[event] ?? []).filter((h) => h !== handler);
    };
  }),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: class {
    static async getByLabel() {
      return null;
    }
  },
}));

vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn(async () => {}) }));

const subscribed: string[] = [];
vi.mock("@/lib/commands", () => ({
  commands: {
    terminalSubscribed: vi.fn(async (id: string) => {
      subscribed.push(id);
    }),
    cancelAuthSession: vi.fn(async () => {}),
  },
}));

vi.mock("@/components/ui/use-toast", () => ({
  useToast: () => ({ toast: () => ({ id: "t" }), dismiss: () => {} }),
}));

import { useAuthFlowEvents } from "./useAuthFlowEvents";

function emit(event: string, payload: unknown) {
  act(() => {
    for (const handler of handlers[event] ?? []) handler({ payload });
  });
}

const created = {
  auth_session_id: "auth-1",
  terminal_session_id: "term-1",
  context: "prod",
  command: "kubectl oidc-login get-token",
};

describe("the sign-in pane nobody should have to see", () => {
  beforeEach(() => {
    for (const key of Object.keys(handlers)) delete handlers[key];
    subscribed.length = 0;
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Issue #148's second complaint: switching clusters flashed an
   * "Authorization" window for the fraction of a second a cached credential
   * plugin takes. The pane is held back — but the session is subscribed to at
   * once, because the backend holds the plugin's output until somebody says
   * they are listening, and a delay there would delay every sign-in instead.
   */
  it("subscribes at once and shows nobody anything until the plugin is slow", async () => {
    const { result } = renderHook(() => useAuthFlowEvents());
    await waitFor(() => {
      expect(handlers["auth-terminal-session-created"]).toHaveLength(1);
    });

    emit("auth-terminal-session-created", created);
    await waitFor(() => expect(subscribed).toEqual(["term-1"]));
    expect(result.current.authTerminalSession).toBeNull();

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current.authTerminalSession?.terminalSessionId).toBe(
      "term-1"
    );
  });

  it("never opens for a plugin that answered from its own cache", async () => {
    const { result } = renderHook(() => useAuthFlowEvents());
    await waitFor(() => {
      expect(handlers["auth-terminal-session-created"]).toHaveLength(1);
    });

    emit("auth-terminal-session-created", created);
    emit("auth-flow-completed", {
      session_id: "auth-1",
      context: "prod",
      success: true,
    });

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current.authTerminalSession).toBeNull();
  });

  /**
   * A plugin that prompts writes the prompt while the pane is still held
   * back. Losing it would open a terminal showing a bare cursor and no
   * question — worse than the flash the hold-back was added to remove.
   */
  it("keeps what the plugin printed while the pane was held back", async () => {
    const { result } = renderHook(() => useAuthFlowEvents());
    await waitFor(() => {
      expect(handlers["auth-terminal-session-created"]).toHaveLength(1);
    });

    emit("auth-terminal-session-created", created);
    emit("terminal-output", { session_id: "term-1", data: "Enter PIN: " });
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(result.current.authTerminalSession?.replay()).toBe("Enter PIN: ");
  });

  it("does not keep output from some other terminal", async () => {
    const { result } = renderHook(() => useAuthFlowEvents());
    await waitFor(() => {
      expect(handlers["auth-terminal-session-created"]).toHaveLength(1);
    });

    emit("auth-terminal-session-created", created);
    emit("terminal-output", { session_id: "a-pod-shell", data: "$ ls\r\n" });
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(result.current.authTerminalSession?.replay()).toBe("");
  });
});
