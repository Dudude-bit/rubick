// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listeners: Record<
  string,
  Array<(event: { payload: unknown }) => void> | undefined
> = {};
let listenReady: Promise<void> = Promise.resolve();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (event: string, handler: (e: { payload: unknown }) => void) => {
      await listenReady;
      (listeners[event] ??= []).push(handler);
      return () => {
        listeners[event] = listeners[event]?.filter((h) => h !== handler);
      };
    }
  ),
}));

/** The backend as it behaves: a stop drops the entry and the gate, and the drain ends at once. */
const backend = { cancelled: false };
vi.mock("@/lib/commands", () => ({
  commands: {
    startNodeDrain: vi.fn(async () => ({ drainId: "d1" })),
    cancelNodeDrain: vi.fn(async () => {
      backend.cancelled = true;
      for (const handler of listeners["drain-finished"] ?? []) {
        handler({
          payload: {
            channel: "drain-finished",
            drain_id: "d1",
            node: "node-7",
            outcome: "cancelled",
            report: {
              evicted: 0,
              alreadyGone: 0,
              leaving: 0,
              daemonsetPodsLeft: 0,
              staticPodsLeft: 0,
              refused: [],
            },
            message: null,
          },
        });
      }
    }),
    nodeDrainSubscribed: vi.fn(async () => {
      if (backend.cancelled) throw new Error("Drain d1 not found");
    }),
  },
}));

import { commands } from "@/lib/commands";
import type { DrainOptions } from "@/generated/types";
import { useNodeDrain } from "./useNodeDrain";

const OPTIONS: DrainOptions = {
  ignoreDaemonsets: true,
  evictUnmanagedPods: false,
  evictPodsWithEmptydir: false,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(listeners)) delete listeners[key];
  listenReady = Promise.resolve();
  backend.cancelled = false;
});

describe("stopping a drain before anyone listened", () => {
  /** Stop pressed while the start was in flight: the cancel went out before the listeners, its ending was lost, and the subscribe that followed turned a cancelled drain into a red "Drain d1 not found". */
  it("says the drain was cancelled when Stop came before the handle", async () => {
    const handle = deferred<{ drainId: string }>();
    vi.mocked(commands.startNodeDrain).mockReturnValueOnce(handle.promise);
    const { result } = renderHook(() => useNodeDrain());

    let started!: Promise<void>;
    act(() => {
      started = result.current.start("node-7", OPTIONS);
    });
    act(() => result.current.cancel());
    await act(async () => {
      handle.resolve({ drainId: "d1" });
      await started;
    });

    expect(result.current.state).toMatchObject({
      phase: "done",
      outcome: "cancelled",
    });
  });

  /** The same race one step later: the handle is in, the listeners are not, and a cancel sent now is answered into nothing. */
  it("says the drain was cancelled when Stop came before the listeners", async () => {
    const ready = deferred<void>();
    listenReady = ready.promise;
    const { result } = renderHook(() => useNodeDrain());

    let started!: Promise<void>;
    act(() => {
      started = result.current.start("node-7", OPTIONS);
    });
    await waitFor(() => expect(result.current.state.phase).toBe("running"));
    act(() => result.current.cancel());
    await act(async () => {
      ready.resolve();
      await started;
    });

    expect(result.current.state).toMatchObject({
      phase: "done",
      outcome: "cancelled",
    });
  });

  /** A stop that lands while the gate is being released ends the drain first; the subscribe's "not found" after it must not paint that ending red. */
  it("keeps the cancelled ending when the subscribe loses the race to the stop", async () => {
    const gate = deferred<void>();
    vi.mocked(commands.nodeDrainSubscribed).mockImplementationOnce(async () => {
      await gate.promise;
      if (backend.cancelled) throw new Error("Drain d1 not found");
    });
    const { result } = renderHook(() => useNodeDrain());

    let started!: Promise<void>;
    act(() => {
      started = result.current.start("node-7", OPTIONS);
    });
    await waitFor(() =>
      expect(commands.nodeDrainSubscribed).toHaveBeenCalledWith("d1")
    );
    await act(async () => {
      result.current.cancel();
      gate.resolve();
      await started;
    });

    expect(result.current.state).toMatchObject({
      phase: "done",
      outcome: "cancelled",
    });
  });

  /** A start the cluster refused is a failure whether or not Stop was pressed; there is no drain to wait on. */
  it("still reports a refused start after an early Stop", async () => {
    const handle = deferred<{ drainId: string }>();
    vi.mocked(commands.startNodeDrain).mockReturnValueOnce(handle.promise);
    const { result } = renderHook(() => useNodeDrain());

    let started!: Promise<void>;
    act(() => {
      started = result.current.start("node-7", OPTIONS);
    });
    act(() => result.current.cancel());
    await act(async () => {
      handle.reject(new Error("nodes is forbidden"));
      await started;
    });

    expect(result.current.state).toMatchObject({ phase: "failed" });
  });
});
