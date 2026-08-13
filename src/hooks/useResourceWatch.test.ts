import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

// ----- Mocks -----

let callCounter = 0;
const listenCalls: Array<{ event: string; index: number }> = [];
const subscribedCalls: Array<{ streamId: string; index: number }> = [];

const listeners: Record<
  string,
  ((event: { payload: unknown }) => void) | undefined
> = {};

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (event: string, handler: (e: { payload: unknown }) => void) => {
      listenCalls.push({ event, index: callCounter++ });
      listeners[event] = handler;
      return () => {
        delete listeners[event];
      };
    }
  ),
}));

const subscribeMock = vi.fn(async () => "stream-cm-1");

vi.mock("@/lib/commands", () => ({
  commands: {
    resourceWatchSubscribed: vi.fn(async (streamId: string) => {
      subscribedCalls.push({ streamId, index: callCounter++ });
    }),
    unsubscribeResourceWatch: vi.fn(async () => undefined),
  },
}));

import { commands } from "@/lib/commands";
import { useResourceWatch } from "./useResourceWatch";

// ----- Test harness -----

type Item = { name: string; namespace?: string | null; data?: number };

// One reference for the whole file, the way every consumer passes it: a
// key rebuilt on each render re-subscribes the watch on each render.
const KEY = ["configmaps", "default"];

function makeWrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

type Op = "applied" | "deleted" | "restarted" | "synced";

function emitBatch(
  streamId: string,
  changes: Array<{ op: Op; resource: Item | null }>
) {
  const handler = listeners["resource-event"];
  if (!handler) throw new Error("resource-event handler not registered");
  handler({
    payload: { stream_id: streamId, changes, error: null },
  });
}

function emit(streamId: string, op: Op, resource: Item | null) {
  emitBatch(streamId, [{ op, resource }]);
}

function emitFailed(streamId: string, error: string) {
  const handler = listeners["resource-event"];
  if (!handler) throw new Error("resource-event handler not registered");
  handler({
    payload: {
      stream_id: streamId,
      changes: [{ op: "failed", resource: null }],
      error,
    },
  });
}

describe("useResourceWatch", () => {
  beforeEach(() => {
    listenCalls.length = 0;
    subscribedCalls.length = 0;
    callCounter = 0;
    for (const k of Object.keys(listeners)) delete listeners[k];
    vi.clearAllMocks();
  });

  it("registers resource-event listener before calling resourceWatchSubscribed", async () => {
    const client = new QueryClient();
    renderHook(
      () =>
        useResourceWatch<Item>({
          enabled: true,
          subscribe: subscribeMock,
          queryKey: KEY,
        }),
      { wrapper: makeWrapper(client) }
    );

    await waitFor(() => {
      expect(subscribedCalls).toHaveLength(1);
    });

    const lc = listenCalls.find((c) => c.event === "resource-event");
    expect(lc, "resource-event listener was never registered").toBeDefined();
    expect(lc!.index).toBeLessThan(subscribedCalls[0].index);
  });

  it("does not subscribe while disabled", async () => {
    const client = new QueryClient();
    renderHook(
      () =>
        useResourceWatch<Item>({
          enabled: false,
          subscribe: subscribeMock,
          queryKey: KEY,
        }),
      { wrapper: makeWrapper(client) }
    );

    await new Promise((r) => setTimeout(r, 50));
    expect(subscribeMock).not.toHaveBeenCalled();
    expect(subscribedCalls).toHaveLength(0);
  });

  it("appends an applied event for an unseen item", async () => {
    const client = new QueryClient();
    client.setQueryData<Item[]>(KEY, [{ name: "a", namespace: "default" }]);

    renderHook(
      () =>
        useResourceWatch<Item>({
          enabled: true,
          subscribe: subscribeMock,
          queryKey: KEY,
        }),
      { wrapper: makeWrapper(client) }
    );

    await waitFor(() => {
      expect(subscribedCalls).toHaveLength(1);
    });

    emit("stream-cm-1", "applied", {
      name: "b",
      namespace: "default",
      data: 1,
    });

    await waitFor(() => {
      const list = client.getQueryData<Item[]>(KEY);
      expect(list).toHaveLength(2);
    });

    const list = client.getQueryData<Item[]>(KEY)!;
    expect(list.map((i) => i.name)).toEqual(["a", "b"]);
  });

  it("replaces an existing item on applied", async () => {
    const client = new QueryClient();
    client.setQueryData<Item[]>(KEY, [
      { name: "a", namespace: "default", data: 1 },
    ]);

    renderHook(
      () =>
        useResourceWatch<Item>({
          enabled: true,
          subscribe: subscribeMock,
          queryKey: KEY,
        }),
      { wrapper: makeWrapper(client) }
    );

    await waitFor(() => {
      expect(subscribedCalls).toHaveLength(1);
    });

    emit("stream-cm-1", "applied", {
      name: "a",
      namespace: "default",
      data: 999,
    });

    await waitFor(() => {
      const list = client.getQueryData<Item[]>(KEY)!;
      expect(list[0].data).toBe(999);
    });

    expect(client.getQueryData<Item[]>(KEY)).toHaveLength(1);
  });

  it("removes the matching item on deleted", async () => {
    const client = new QueryClient();
    client.setQueryData<Item[]>(KEY, [
      { name: "a", namespace: "default" },
      { name: "b", namespace: "default" },
    ]);

    renderHook(
      () =>
        useResourceWatch<Item>({
          enabled: true,
          subscribe: subscribeMock,
          queryKey: KEY,
        }),
      { wrapper: makeWrapper(client) }
    );

    await waitFor(() => {
      expect(subscribedCalls).toHaveLength(1);
    });

    emit("stream-cm-1", "deleted", { name: "a", namespace: "default" });

    await waitFor(() => {
      const list = client.getQueryData<Item[]>(KEY)!;
      expect(list.map((i) => i.name)).toEqual(["b"]);
    });
  });

  /**
   * A resync used to empty the cache and refill it from the burst that
   * follows. The list query is long since loaded, so nothing renders a
   * skeleton and the table draws "No resources of this type in the
   * current scope" over a cluster that is fine — for as long as the
   * burst takes. The rows we already have are the last complete state
   * and stay until the new one is complete.
   */
  it("keeps the rows it has for the length of a resync", async () => {
    const client = new QueryClient();
    client.setQueryData<Item[]>(KEY, [
      { name: "a", namespace: "default" },
      { name: "b", namespace: "default" },
    ]);

    const { result } = renderHook(
      () =>
        useResourceWatch<Item>({
          enabled: true,
          subscribe: subscribeMock,
          queryKey: KEY,
        }),
      { wrapper: makeWrapper(client) }
    );

    await waitFor(() => {
      expect(subscribedCalls).toHaveLength(1);
    });

    emitBatch("stream-cm-1", [
      { op: "restarted", resource: null },
      { op: "applied", resource: { name: "a", namespace: "default", data: 2 } },
    ]);

    await waitFor(() => expect(result.current.resyncing).toBe(true));
    expect(client.getQueryData<Item[]>(KEY)!.map((i) => i.name)).toEqual([
      "a",
      "b",
    ]);

    // The burst ends without `b`, which is how a watch says it is gone.
    emitBatch("stream-cm-1", [
      { op: "applied", resource: { name: "c", namespace: "default" } },
      { op: "synced", resource: null },
    ]);

    await waitFor(() => expect(result.current.resyncing).toBe(false));
    const list = client.getQueryData<Item[]>(KEY)!;
    expect(list.map((i) => i.name)).toEqual(["a", "c"]);
    expect(list[0].data).toBe(2);
  });

  /**
   * One batch is one cache write, whatever it holds. Per-event writes
   * were per-event renders — a thousand-object init burst rebuilt the
   * whole table a thousand times.
   */
  it("applies a whole batch in a single cache write", async () => {
    const client = new QueryClient();
    client.setQueryData<Item[]>(KEY, []);

    renderHook(
      () =>
        useResourceWatch<Item>({
          enabled: true,
          subscribe: subscribeMock,
          queryKey: KEY,
        }),
      { wrapper: makeWrapper(client) }
    );

    await waitFor(() => {
      expect(subscribedCalls).toHaveLength(1);
    });

    const writes = vi.spyOn(client, "setQueryData");
    emitBatch("stream-cm-1", [
      { op: "applied", resource: { name: "a", namespace: "default" } },
      { op: "applied", resource: { name: "b", namespace: "default" } },
      { op: "applied", resource: { name: "c", namespace: "default" } },
      { op: "deleted", resource: { name: "a", namespace: "default" } },
    ]);

    await waitFor(() => {
      expect(client.getQueryData<Item[]>(KEY)!.map((i) => i.name)).toEqual([
        "b",
        "c",
      ]);
    });
    expect(writes).toHaveBeenCalledTimes(1);
    writes.mockRestore();
  });

  it("ignores events for a different stream id", async () => {
    const client = new QueryClient();
    client.setQueryData<Item[]>(KEY, [{ name: "a", namespace: "default" }]);

    renderHook(
      () =>
        useResourceWatch<Item>({
          enabled: true,
          subscribe: subscribeMock,
          queryKey: KEY,
        }),
      { wrapper: makeWrapper(client) }
    );

    await waitFor(() => {
      expect(subscribedCalls).toHaveLength(1);
    });

    // Event from a different stream — must not touch the cache.
    emit("some-other-stream", "deleted", { name: "a", namespace: "default" });

    await new Promise((r) => setTimeout(r, 30));
    expect(client.getQueryData<Item[]>(KEY)).toHaveLength(1);
  });

  it("calls onError on a failed event without mutating the cache", async () => {
    const client = new QueryClient();
    client.setQueryData<Item[]>(KEY, [{ name: "a", namespace: "default" }]);
    const onError = vi.fn();

    renderHook(
      () =>
        useResourceWatch<Item>({
          enabled: true,
          subscribe: subscribeMock,
          queryKey: KEY,
          onError,
        }),
      { wrapper: makeWrapper(client) }
    );

    await waitFor(() => {
      expect(subscribedCalls).toHaveLength(1);
    });

    emitFailed("stream-cm-1", "watch verb forbidden");

    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith("watch verb forbidden");
    });

    // Failed events MUST NOT touch the cache. The consumer is the one
    // that decides what to do (toast + re-enable polling, etc.).
    expect(client.getQueryData<Item[]>(KEY)).toEqual([
      { name: "a", namespace: "default" },
    ]);
  });

  it("calls onRecovered exactly once when a non-failed event follows a failed one", async () => {
    const client = new QueryClient();
    client.setQueryData<Item[]>(KEY, []);
    const onError = vi.fn();
    const onRecovered = vi.fn();

    renderHook(
      () =>
        useResourceWatch<Item>({
          enabled: true,
          subscribe: subscribeMock,
          queryKey: KEY,
          onError,
          onRecovered,
        }),
      { wrapper: makeWrapper(client) }
    );

    await waitFor(() => {
      expect(subscribedCalls).toHaveLength(1);
    });

    // Watch fails, then recovers, then keeps receiving applied events.
    emitFailed("stream-cm-1", "transient");
    emit("stream-cm-1", "applied", { name: "x", namespace: "default" });
    emit("stream-cm-1", "applied", { name: "y", namespace: "default" });

    await waitFor(() => {
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onRecovered).toHaveBeenCalledTimes(1);
    });

    // Cache reflects both applied events.
    expect(client.getQueryData<Item[]>(KEY)!.map((i) => i.name)).toEqual([
      "x",
      "y",
    ]);
  });

  it("calls onRecovered again on a second failure→recovery cycle", async () => {
    const client = new QueryClient();
    const onRecovered = vi.fn();

    renderHook(
      () =>
        useResourceWatch<Item>({
          enabled: true,
          subscribe: subscribeMock,
          queryKey: KEY,
          onError: vi.fn(),
          onRecovered,
        }),
      { wrapper: makeWrapper(client) }
    );

    await waitFor(() => {
      expect(subscribedCalls).toHaveLength(1);
    });

    emitFailed("stream-cm-1", "first");
    emit("stream-cm-1", "applied", { name: "a" });
    emitFailed("stream-cm-1", "second");
    emit("stream-cm-1", "applied", { name: "b" });

    await waitFor(() => {
      expect(onRecovered).toHaveBeenCalledTimes(2);
    });
  });

  /**
   * A watch that fails mid-resync never sends the `synced` that ends it.
   * Left resyncing, a surface with nothing to show waits on a skeleton
   * that can never resolve — and the half-delivered burst must not be
   * committed either, or rows that still exist are deleted from a list
   * that has already stopped being live.
   */
  it("abandons a resync the watch failed in the middle of", async () => {
    const client = new QueryClient();
    client.setQueryData<Item[]>(KEY, [{ name: "a", namespace: "default" }]);

    const { result } = renderHook(
      () =>
        useResourceWatch<Item>({
          enabled: true,
          subscribe: subscribeMock,
          queryKey: KEY,
          onError: vi.fn(),
          onRecovered: vi.fn(),
        }),
      { wrapper: makeWrapper(client) }
    );

    await waitFor(() => {
      expect(subscribedCalls).toHaveLength(1);
    });

    emitBatch("stream-cm-1", [
      { op: "restarted", resource: null },
      { op: "applied", resource: { name: "b", namespace: "default" } },
    ]);
    await waitFor(() => expect(result.current.resyncing).toBe(true));

    emitFailed("stream-cm-1", "connection reset");
    await waitFor(() => expect(result.current.resyncing).toBe(false));

    // A `synced` that arrives after the failure has nothing to commit.
    emit("stream-cm-1", "synced", null);
    await new Promise((r) => setTimeout(r, 20));
    expect(client.getQueryData<Item[]>(KEY)!.map((i) => i.name)).toEqual(["a"]);
  });

  it("calls unsubscribeResourceWatch on unmount", async () => {
    const client = new QueryClient();
    const { unmount } = renderHook(
      () =>
        useResourceWatch<Item>({
          enabled: true,
          subscribe: subscribeMock,
          queryKey: KEY,
        }),
      { wrapper: makeWrapper(client) }
    );

    await waitFor(() => {
      expect(subscribedCalls).toHaveLength(1);
    });

    unmount();

    await waitFor(() => {
      expect(commands.unsubscribeResourceWatch).toHaveBeenCalledWith(
        "stream-cm-1"
      );
    });
  });
});
