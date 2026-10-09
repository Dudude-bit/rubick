import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { act, renderHook, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { TerminalSessionInfo } from "@/generated/types";
import { useTerminalSessionStore } from "@/stores/terminalSessionStore";
import { useTerminalSessionSync } from "./useTerminalSessionSync";

const shell = (id: string, pod: string): TerminalSessionInfo => ({
  id,
  context: "acme-staging",
  namespace: "shop",
  pod,
  container: "app",
  state: "connected",
  openedAt: "2026-10-09T09:00:00Z",
});

let send: ((event: { payload: unknown }) => void) | null = null;
let answer: () => Promise<unknown>;

beforeEach(() => {
  send = null;
  useTerminalSessionStore.setState({ sessions: null, failed: null });
  vi.mocked(listen).mockImplementation(async (channel, handler) => {
    if (channel === "terminal-sessions")
      send = handler as (event: { payload: unknown }) => void;
    return () => {};
  });
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "list_terminal_sessions" ? answer() : undefined
  );
});

afterEach(() => {
  vi.mocked(listen).mockImplementation(async () => () => {});
  vi.mocked(invoke).mockImplementation(async () => undefined);
});

describe("the list of open shells", () => {
  /**
   * Shells opened before the window was, or by a pane long gone, are in the
   * backend and nowhere else. Fails if the store waits for an event.
   */
  it("starts from what the backend holds", async () => {
    answer = async () => [shell("a", "cart-4f68h"), shell("b", "search-ztqf7")];
    renderHook(() => useTerminalSessionSync());

    await waitFor(() =>
      expect(
        useTerminalSessionStore.getState().sessions?.map((s) => s.pod)
      ).toEqual(["cart-4f68h", "search-ztqf7"])
    );
  });

  /** Fails if a change is kept by the panes rather than taken from the backend. */
  it("takes every change as the backend's whole list", async () => {
    answer = async () => [shell("a", "cart-4f68h")];
    renderHook(() => useTerminalSessionSync());
    await waitFor(() => expect(send).not.toBeNull());

    act(() => send!({ payload: { sessions: [] } }));

    expect(useTerminalSessionStore.getState().sessions).toEqual([]);
  });

  /** A read that answers after a newer change must not put the old list back. */
  it("keeps a change heard while the first read was out", async () => {
    let release!: (sessions: TerminalSessionInfo[]) => void;
    answer = () => new Promise((resolve) => (release = resolve));
    renderHook(() => useTerminalSessionSync());
    await waitFor(() => expect(send).not.toBeNull());

    act(() => send!({ payload: { sessions: [] } }));
    await act(async () => release([shell("a", "cart-4f68h")]));

    expect(useTerminalSessionStore.getState().sessions).toEqual([]);
  });

  /** Fails if a refused read is shown as "no terminals". */
  it("says the list could not be read rather than that it is empty", async () => {
    answer = async () => {
      throw { code: "INTERNAL", message: "the bridge is down" };
    };
    renderHook(() => useTerminalSessionSync());

    await waitFor(() =>
      expect(useTerminalSessionStore.getState().failed).toMatch(
        /the bridge is down/
      )
    );
    expect(useTerminalSessionStore.getState().sessions).toBeNull();
  });
});
