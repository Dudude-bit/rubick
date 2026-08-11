import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

// ----- Mocks -----

const listenCalls: Array<{ event: string; index: number }> = [];
let callCounter = 0;

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string) => {
    listenCalls.push({ event, index: callCounter++ });
    return () => {};
  }),
}));

const subscribedCalls: Array<{ sessionId: string; index: number }> = [];

vi.mock("@/lib/commands", () => ({
  commands: {
    terminalSubscribed: vi.fn(async (sessionId: string) => {
      subscribedCalls.push({ sessionId, index: callCounter++ });
    }),
    terminalInput: vi.fn(async () => undefined),
    terminalResize: vi.fn(async () => undefined),
    closeTerminal: vi.fn(async () => undefined),
  },
}));

import { useGenericTerminalSession } from "./useGenericTerminalSession";

// ----- Tests -----

describe("useGenericTerminalSession deferred-start handshake", () => {
  beforeEach(() => {
    listenCalls.length = 0;
    subscribedCalls.length = 0;
    callCounter = 0;
    vi.clearAllMocks();
  });

  it("registers terminal-output listener before calling terminalSubscribed", async () => {
    renderHook(() =>
      useGenericTerminalSession({
        sessionId: "session-1",
      })
    );

    await waitFor(() => {
      expect(subscribedCalls).toHaveLength(1);
    });

    const outputCall = listenCalls.find((c) => c.event === "terminal-output");
    expect(
      outputCall,
      "terminal-output listener was never registered"
    ).toBeDefined();
    expect(outputCall!.index).toBeLessThan(subscribedCalls[0].index);
  });

  it("registers terminal-closed listener before calling terminalSubscribed", async () => {
    renderHook(() =>
      useGenericTerminalSession({
        sessionId: "session-2",
      })
    );

    await waitFor(() => {
      expect(subscribedCalls).toHaveLength(1);
    });

    const closedCall = listenCalls.find((c) => c.event === "terminal-closed");
    expect(
      closedCall,
      "terminal-closed listener was never registered"
    ).toBeDefined();
    expect(closedCall!.index).toBeLessThan(subscribedCalls[0].index);
  });

  it("calls terminalSubscribed with the session id passed to the hook", async () => {
    renderHook(() =>
      useGenericTerminalSession({
        sessionId: "session-xyz",
      })
    );

    await waitFor(() => {
      expect(subscribedCalls).toHaveLength(1);
    });

    expect(subscribedCalls[0].sessionId).toBe("session-xyz");
  });

  it("does not call terminalSubscribed when sessionId is null", async () => {
    renderHook(() =>
      useGenericTerminalSession({
        sessionId: null,
      })
    );

    // Give microtasks a chance to flush in case the hook would have called.
    await new Promise((r) => setTimeout(r, 50));

    expect(subscribedCalls).toHaveLength(0);
  });

  it("does not set error status when terminalSubscribed rejects after both listeners installed", async () => {
    // Race in the wild: the auth flow can finish (success OR error)
    // before the frontend reaches `terminalSubscribed`. The backend
    // session is then gone and `mark_subscribed` errors with
    // "Session not found" — but the listeners are still installed
    // and will catch any TerminalOutput / TerminalClosed events that
    // *do* fire. Showing "Failed to setup terminal listeners" in
    // that case is misleading; the listeners are fine.
    const { commands } = await import("@/lib/commands");
    vi.mocked(commands.terminalSubscribed).mockRejectedValueOnce(
      new Error("Session not found")
    );

    const { result } = renderHook(() =>
      useGenericTerminalSession({
        sessionId: "race-loser-session",
      })
    );

    await waitFor(() => {
      expect(vi.mocked(commands.terminalSubscribed)).toHaveBeenCalled();
    });
    // Let the rejection propagate through the catch.
    await new Promise((r) => setTimeout(r, 20));

    expect(result.current.status).not.toBe("error");
    expect(result.current.error).toBeNull();
  });

  /**
   * The one thing a terminal is for. `send` gates on a ref that mirrors the
   * status, and the ref was never written — so a pod shell painted a prompt,
   * accepted a click, and silently swallowed everything typed into it.
   */
  it("sends what is typed once the session is attached", async () => {
    const { commands } = await import("@/lib/commands");
    const { result } = renderHook(() =>
      useGenericTerminalSession({ sessionId: "typing-session" })
    );

    await waitFor(() => {
      expect(result.current.status).toBe("connected");
    });
    await result.current.send("ps\r");

    expect(vi.mocked(commands.terminalInput)).toHaveBeenCalledWith(
      "typing-session",
      "ps\r"
    );
  });

  /**
   * The id can already be known when the terminal first mounts: the xterm
   * chunk is lazy, and `openPodShell` often answers before it arrives.
   */
  it("reaches connected when the session id is there from the first render", async () => {
    const { result } = renderHook(() =>
      useGenericTerminalSession({ sessionId: "eager-session" })
    );
    await waitFor(() => {
      expect(result.current.status).toBe("connected");
    });
  });

  it("DOES set error status when listen() itself rejects (real Tauri IPC failure)", async () => {
    // The flip side: if `listen()` itself fails — that's a genuine
    // IPC problem, not a session-lifecycle race, and the user
    // *should* see an error so they know events won't arrive.
    const { listen } = await import("@tauri-apps/api/event");
    vi.mocked(listen).mockRejectedValueOnce(new Error("IPC unavailable"));

    const { result } = renderHook(() =>
      useGenericTerminalSession({
        sessionId: "ipc-broken-session",
      })
    );

    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });
    expect(result.current.error).toMatch(/listener/i);
  });
});
