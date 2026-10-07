// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { renderHook, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  type QueryKey,
} from "@tanstack/react-query";
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
import { testQueryClient } from "@/test/render";
import { queryKeys } from "@/lib/query-keys";
import { useWindowActivity } from "@/lib/window-activity";
import type { Scoped } from "@/generated/types";

// ----- Test harness -----

type Item = { name: string; namespace?: string | null; data?: number };

// One reference for the whole file, the way every consumer passes it: a
// key rebuilt on each render re-subscribes the watch on each render.
const KEY = ["configmaps", "default"];

// The cache holds a list's `Scoped` answer; these read and seed its rows.
function rowsIn(client: QueryClient): Item[] | undefined {
  return client.getQueryData<Scoped<Item>>(KEY)?.rows;
}

function seed(client: QueryClient, rows: Item[]) {
  client.setQueryData<Scoped<Item>>(KEY, { rows, unread: [] });
}

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

  async function start(client: QueryClient) {
    const hook = renderHook(
      () =>
        useResourceWatch<Item>({
          enabled: true,
          subscribe: subscribeMock,
          queryKey: KEY,
        }),
      { wrapper: makeWrapper(client) }
    );
    await waitFor(() => expect(subscribedCalls).toHaveLength(1));
    return hook;
  }

  /** Rebuilding the index rescans 10,000 keys; cloning rows invalidates untouched row memos. */
  it("updates one of 10,000 rows without rereading untouched keys or replacing their objects", async () => {
    let keyReads = 0;
    const rows = Array.from({ length: 10_000 }, (_, index) => ({
      get name() {
        keyReads++;
        return `pod-${index}`;
      },
      namespace: "default",
      data: 0,
    }));
    const client = new QueryClient();
    seed(client, rows);
    await start(client);
    emit("stream-cm-1", "applied", {
      name: "pod-9999",
      namespace: "default",
      data: 1,
    });

    for (const data of [1, 2]) {
      const before = rowsIn(client)!;
      keyReads = 0;
      emit("stream-cm-1", "applied", {
        name: "pod-1234",
        namespace: "default",
        data,
      });
      const after = rowsIn(client)!;
      expect(after).not.toBe(before);
      expect(after).toHaveLength(10_000);
      expect(after[1234]).not.toBe(before[1234]);
      expect(after[1234].data).toBe(data);
      expect(before[1234].data).toBe(data - 1);
      for (let index = 0; index < before.length; index++) {
        if (index !== 1234) expect(after[index]).toBe(before[index]);
      }
      expect(keyReads).toBeLessThan(10);
    }
  });

  /** Publishing staged rows early would expose an incomplete collection to cache readers. */
  it("replaces the complete collection in one atomic resync write", async () => {
    const client = new QueryClient();
    const before = [{ name: "old", data: 1 }];
    seed(client, before);
    await start(client);
    const writes: Item[][] = [];
    const off = client.getQueryCache().subscribe((event) => {
      if (event.type === "updated" && event.action.type === "success") {
        writes.push(rowsIn(client)!);
      }
    });

    emit("stream-cm-1", "restarted", null);
    emit("stream-cm-1", "applied", { name: "first" });
    emit("stream-cm-1", "applied", { name: "second" });
    expect(rowsIn(client)).toBe(before);
    expect(writes).toEqual([]);
    emit("stream-cm-1", "synced", null);
    expect(writes).toEqual([[{ name: "first" }, { name: "second" }]]);
    emit("stream-cm-1", "applied", { name: "second", data: 2 });
    expect(rowsIn(client)).toEqual([
      { name: "first" },
      { name: "second", data: 2 },
    ]);
    off();
  });

  /**
   * A polled read left a namespace unread; the watch then synced every
   * namespace of its stream. Keeping the old `unread` would leave the page
   * saying "could not read staging" over staging's rows.
   */
  it("clears the unread namespaces once a resync has every namespace's rows", async () => {
    const client = new QueryClient();
    const missing = {
      namespace: "staging",
      code: "PERMISSION_DENIED",
      message: "",
    };
    client.setQueryData<Scoped<Item>>(KEY, {
      rows: [{ name: "a", namespace: "prod" }],
      unread: [missing],
    });
    await start(client);

    emit("stream-cm-1", "applied", { name: "b", namespace: "prod" });
    expect(client.getQueryData<Scoped<Item>>(KEY)?.unread).toEqual([missing]);

    emitBatch("stream-cm-1", [
      { op: "restarted", resource: null },
      { op: "applied", resource: { name: "a", namespace: "prod" } },
      { op: "applied", resource: { name: "s", namespace: "staging" } },
      { op: "synced", resource: null },
    ]);
    const answer = client.getQueryData<Scoped<Item>>(KEY);
    expect(answer?.rows.map((row) => row.name)).toEqual(["a", "s"]);
    expect(answer?.unread).toEqual([]);
  });

  /**
   * Dana saw reports-29855212-snmdw land under search-d76577dcb at the
   * bottom of shop until she left the page. Fails if a new row stops landing
   * where the list puts it, if any other row is replaced, or if finding the
   * place reads more than a handful of the 10,000 keys.
   */
  it("puts one new pod of 10,000 in its sorted place and leaves every other row as it was", async () => {
    let keyReads = 0;
    const rows = Array.from({ length: 10_000 }, (_, index) => {
      const name = `pod-${String(index).padStart(5, "0")}`;
      return {
        get name() {
          keyReads++;
          return name;
        },
        namespace: "shop",
      };
    });
    // The app's own client: structural sharing is where a shifted row lost
    // its identity.
    const client = testQueryClient();
    seed(client, rows);
    await start(client);
    // The first event indexes the list, which reads every key once.
    emit("stream-cm-1", "applied", { name: "pod-09999", namespace: "shop" });
    const before = rowsIn(client)!;
    keyReads = 0;
    emit("stream-cm-1", "applied", { name: "pod-04999x", namespace: "shop" });
    const after = rowsIn(client)!;
    expect(after).toHaveLength(10_001);
    expect(after[5000].name).toBe("pod-04999x");
    for (let index = 0; index < before.length; index++) {
      expect(after[index < 5000 ? index : index + 1]).toBe(before[index]);
    }
    expect(keyReads).toBeLessThan(40);
  });

  /** Fails if a new row stops landing inside its own namespace's rows. */
  it("puts a new row among its own namespace's rows", async () => {
    const client = new QueryClient();
    seed(client, [
      { name: "cart-9df89489c-kzfc6", namespace: "shop" },
      { name: "search-d76577dcb-zbtv9", namespace: "shop" },
      { name: "checkout-7db8bc9ffd-w5b7p", namespace: "team-checkout" },
    ]);
    await start(client);
    emit("stream-cm-1", "applied", {
      name: "reports-29855212-snmdw",
      namespace: "shop",
    });
    expect(rowsIn(client)?.map((row) => row.name)).toEqual([
      "cart-9df89489c-kzfc6",
      "reports-29855212-snmdw",
      "search-d76577dcb-zbtv9",
      "checkout-7db8bc9ffd-w5b7p",
    ]);
  });

  /** Stale positions after deletion would update the wrong row, or put a row added again anywhere but its place. */
  it("keeps updates in place and puts a deleted row back in its place when it is added again", async () => {
    const client = new QueryClient();
    seed(
      client,
      ["a", "b", "c"].map((name) => ({ name }))
    );
    await start(client);
    emitBatch("stream-cm-1", [
      { op: "applied", resource: { name: "b", data: 1 } },
      { op: "deleted", resource: { name: "a" } },
      { op: "applied", resource: { name: "a", data: 2 } },
    ]);
    expect(rowsIn(client)).toEqual([
      { name: "a", data: 2 },
      { name: "b", data: 1 },
      { name: "c" },
    ]);
    emit("stream-cm-1", "deleted", { name: "c" });
    emit("stream-cm-1", "applied", { name: "c", data: 3 });
    emit("stream-cm-1", "applied", { name: "b", data: 4 });
    expect(rowsIn(client)).toEqual([
      { name: "a", data: 2 },
      { name: "b", data: 4 },
      { name: "c", data: 3 },
    ]);
  });

  /** Polling or another observer can replace the array and invalidate every cached position. */
  it("rebuilds positions after another writer replaces the cached list", async () => {
    const client = new QueryClient();
    seed(client, [{ name: "a" }, { name: "b" }]);
    await start(client);
    emit("stream-cm-1", "applied", { name: "a", data: 1 });
    seed(client, [{ name: "b" }, { name: "c" }]);
    emit("stream-cm-1", "applied", { name: "b", data: 2 });
    emit("stream-cm-1", "deleted", { name: "c" });
    expect(rowsIn(client)).toEqual([{ name: "b", data: 2 }]);
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
    seed(client, [{ name: "a", namespace: "default" }]);

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
      const list = rowsIn(client);
      expect(list).toHaveLength(2);
    });

    const list = rowsIn(client)!;
    expect(list.map((i) => i.name)).toEqual(["a", "b"]);
  });

  it("replaces an existing item on applied", async () => {
    const client = new QueryClient();
    seed(client, [{ name: "a", namespace: "default", data: 1 }]);

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
      const list = rowsIn(client)!;
      expect(list[0].data).toBe(999);
    });

    expect(rowsIn(client)).toHaveLength(1);
  });

  it("removes the matching item on deleted", async () => {
    const client = new QueryClient();
    seed(client, [
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
      const list = rowsIn(client)!;
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
    seed(client, [
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
    expect(rowsIn(client)!.map((i) => i.name)).toEqual(["a", "b"]);

    // The burst ends without `b`, which is how a watch says it is gone.
    emitBatch("stream-cm-1", [
      { op: "applied", resource: { name: "c", namespace: "default" } },
      { op: "synced", resource: null },
    ]);

    await waitFor(() => expect(result.current.resyncing).toBe(false));
    const list = rowsIn(client)!;
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
    seed(client, []);

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
      expect(rowsIn(client)!.map((i) => i.name)).toEqual(["b", "c"]);
    });
    expect(writes).toHaveBeenCalledTimes(1);
    writes.mockRestore();
  });

  it("ignores events for a different stream id", async () => {
    const client = new QueryClient();
    seed(client, [{ name: "a", namespace: "default" }]);

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
    expect(rowsIn(client)).toHaveLength(1);
  });

  it("calls onError on a failed event without mutating the cache", async () => {
    const client = new QueryClient();
    seed(client, [{ name: "a", namespace: "default" }]);
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
    expect(rowsIn(client)).toEqual([{ name: "a", namespace: "default" }]);
  });

  /**
   * The bridge dropping events is this watch failing: the list is short, not
   * stale. The payload is `{ missed }`; reading it as the bare number it
   * once was prints "dropped [object Object] updates".
   */
  it("reports a lagging event bridge as a failure, with how many were dropped", async () => {
    const client = new QueryClient();
    seed(client, []);
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
      expect(listeners["event-bridge-lagged"]).toBeDefined();
    });
    listeners["event-bridge-lagged"]?.({
      payload: { channel: "event-bridge-lagged", missed: 37 },
    });

    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining("dropped 37 updates")
    );
  });

  it("calls onRecovered exactly once when a non-failed event follows a failed one", async () => {
    const client = new QueryClient();
    seed(client, []);
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
    expect(rowsIn(client)!.map((i) => i.name)).toEqual(["x", "y"]);
  });

  /**
   * The marker kube sends before every list attempt is not the cluster
   * answering: a watch the cluster refuses emits one between every pair of
   * failures. Recovering on it hands the list back to a watch that does not
   * work, stops the polling that was standing in for it, and shows a resync
   * that never syncs.
   */
  it("does not treat the restart marker of a refused watch as a recovery", async () => {
    const client = new QueryClient();
    seed(client, []);
    const onError = vi.fn();
    const onRecovered = vi.fn();

    const { result } = renderHook(
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

    emitFailed("stream-cm-1", "pods is forbidden");
    // Three more attempts, each announced and each refused.
    emit("stream-cm-1", "restarted", null);
    emit("stream-cm-1", "restarted", null);
    emit("stream-cm-1", "restarted", null);

    await waitFor(() => {
      expect(onError).toHaveBeenCalledTimes(1);
    });
    expect(onRecovered).not.toHaveBeenCalled();
    expect(result.current.resyncing).toBe(false);

    // The list a reader would be shown is still the one polling fills, and
    // the first real answer is what ends the failure.
    emit("stream-cm-1", "applied", { name: "x", namespace: "default" });
    await waitFor(() => {
      expect(onRecovered).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * The marker must not end the failure — and it must still do its work.
   * Returning early on it skipped the staging map the resync is collected
   * into, so the rows that went away while the watch was down stayed in the
   * cache after it came back: `synced` had nothing to commit.
   */
  it("commits the resync that follows a failure, dropping what went away", async () => {
    const client = new QueryClient();
    seed(client, [
      { name: "gone", namespace: "default" },
      { name: "stays", namespace: "default" },
    ]);
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

    emitFailed("stream-cm-1", "pods is forbidden");
    // The watch comes back: the marker, the list it re-read, the commit.
    emit("stream-cm-1", "restarted", null);
    emit("stream-cm-1", "applied", { name: "stays", namespace: "default" });
    emit("stream-cm-1", "synced", null);

    await waitFor(() => {
      expect(onRecovered).toHaveBeenCalledTimes(1);
    });
    expect(rowsIn(client)!.map((i) => i.name)).toEqual(["stays"]);
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
   * A renewal or a re-enable subscribes again under the same key. The new
   * stream began as "not failed", so its first answer recovered nothing and
   * the list kept polling beside a watch that worked, marked not live.
   */
  it("recovers a failed watch when a new stream under the same key answers", async () => {
    const client = new QueryClient();
    const onRecovered = vi.fn();
    subscribeMock
      .mockResolvedValueOnce("stream-cm-1")
      .mockResolvedValueOnce("stream-cm-2");

    const { rerender } = renderHook(
      ({ enabled }) =>
        useResourceWatch<Item>({
          enabled,
          subscribe: subscribeMock,
          queryKey: KEY,
          onError: vi.fn(),
          onRecovered,
        }),
      { wrapper: makeWrapper(client), initialProps: { enabled: true } }
    );
    await waitFor(() => expect(subscribedCalls).toHaveLength(1));
    emitFailed("stream-cm-1", "Unauthorized");

    rerender({ enabled: false });
    rerender({ enabled: true });
    await waitFor(() => expect(subscribedCalls).toHaveLength(2));
    emit("stream-cm-2", "applied", { name: "a" });

    await waitFor(() => expect(onRecovered).toHaveBeenCalledTimes(1));
  });

  /** A new key is a new stream, which owes no recovery for the last one. */
  it("starts a stream under a new key without the last key's failure", async () => {
    const client = new QueryClient();
    const onRecovered = vi.fn();
    subscribeMock
      .mockResolvedValueOnce("stream-cm-1")
      .mockResolvedValueOnce("stream-cm-2");
    const other = ["configmaps", "prod"];

    const { rerender, result } = renderHook(
      ({ queryKey }) =>
        useResourceWatch<Item>({
          enabled: true,
          subscribe: subscribeMock,
          queryKey,
          onError: vi.fn(),
          onRecovered,
        }),
      { wrapper: makeWrapper(client), initialProps: { queryKey: KEY } }
    );
    await waitFor(() => expect(subscribedCalls).toHaveLength(1));
    emitFailed("stream-cm-1", "Unauthorized");

    rerender({ queryKey: other });
    await waitFor(() => expect(subscribedCalls).toHaveLength(2));
    emit("stream-cm-2", "restarted", null);

    await waitFor(() => expect(result.current.resyncing).toBe(true));
    expect(onRecovered).not.toHaveBeenCalled();
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
    seed(client, [{ name: "a", namespace: "default" }]);

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
    expect(rowsIn(client)!.map((i) => i.name)).toEqual(["a"]);
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

describe("the readers beside a watched list", () => {
  beforeEach(() => {
    subscribedCalls.length = 0;
    for (const k of Object.keys(listeners)) delete listeners[k];
    vi.clearAllMocks();
    useWindowActivity.setState({ visible: true });
  });

  const DEPLOYMENTS = ["deployments", "shop"];
  const PODS = ["pods", "shop"];
  const PEEK = queryKeys.detail("Deployment", "shop", "search");
  const SIDEBAR = queryKeys.clusterOverview("acme-staging", ["shop"]);

  /** A poll that never fires on its own, so only the watch can move it. */
  function useReader<A>(queryKey: QueryKey, read: () => Promise<A>) {
    return useQuery({ queryKey, queryFn: read, staleTime: Infinity }).data;
  }

  async function watching<A>(
    client: QueryClient,
    listKey: string[],
    readerKey: QueryKey,
    read: () => Promise<A>
  ) {
    const detail = queryKeys.rowDetail(listKey === PODS ? "Pod" : "Deployment");
    const hook = renderHook(
      () => {
        useResourceWatch<Item>({
          enabled: true,
          subscribe: subscribeMock,
          queryKey: listKey,
          detail,
        });
        return useReader(readerKey, read);
      },
      { wrapper: makeWrapper(client) }
    );
    await waitFor(() => expect(subscribedCalls).toHaveLength(1));
    await waitFor(() => expect(hook.result.current).toBeDefined());
    return hook;
  }

  /**
   * Dana scaled search to 3: the Deployments row said 3/3 while the open
   * peek said "Stalled, 2 of 3 ready" for five seconds, until its own poll.
   * Fails if the watch's change does not make the peek's entry read again.
   */
  it("has the peek read a Deployment again when the list's watch sees it change", async () => {
    const client = testQueryClient();
    const getDeployment = vi
      .fn()
      .mockResolvedValueOnce({ name: "search", ready: 2 })
      .mockResolvedValue({ name: "search", ready: 3 });
    client.setQueryData<Scoped<Item>>(DEPLOYMENTS, {
      rows: [{ name: "search", namespace: "shop", data: 2 }],
      unread: [],
    });
    const hook = await watching(client, DEPLOYMENTS, PEEK, getDeployment);
    expect(hook.result.current).toEqual({ name: "search", ready: 2 });

    emit("stream-cm-1", "applied", {
      name: "search",
      namespace: "shop",
      data: 3,
    });
    await waitFor(() =>
      expect(hook.result.current).toEqual({ name: "search", ready: 3 })
    );
    expect(getDeployment).toHaveBeenCalledTimes(2);
  });

  /**
   * Scale 2 to 4: the Pods header said 16 while the sidebar and the status
   * bar said 14 until the overview's next ten-second read. Fails if a pod
   * the watch added leaves the counts to that poll, or if two pods landing
   * together cost two overview reads.
   */
  it("reads the overview's counts once again when the watch adds pods", async () => {
    const client = testQueryClient();
    const overview = vi
      .fn()
      .mockResolvedValueOnce({ pods: 14 })
      .mockResolvedValue({ pods: 16 });
    client.setQueryData<Scoped<Item>>(PODS, {
      rows: Array.from({ length: 14 }, (_, i) => ({
        name: `pod-${i}`,
        namespace: "shop",
      })),
      unread: [],
    });
    const hook = await watching(client, PODS, SIDEBAR, overview);

    emit("stream-cm-1", "applied", { name: "search-2cw59", namespace: "shop" });
    emit("stream-cm-1", "applied", { name: "search-4bmgj", namespace: "shop" });
    await waitFor(() => expect(hook.result.current).toEqual({ pods: 16 }), {
      timeout: 3000,
    });
    expect(overview).toHaveBeenCalledTimes(2);
  });

  /**
   * A watch that was down comes back with a resync, and pods that came or
   * went meanwhile arrive in it rather than as changes. Fails if a resync
   * that changes the count leaves the sidebar on the old one.
   */
  it("reads the overview again when a resync brings a different count", async () => {
    const client = testQueryClient();
    const overview = vi
      .fn()
      .mockResolvedValueOnce({ pods: 1 })
      .mockResolvedValue({ pods: 2 });
    client.setQueryData<Scoped<Item>>(PODS, {
      rows: [{ name: "pod-0", namespace: "shop" }],
      unread: [],
    });
    const hook = await watching(client, PODS, SIDEBAR, overview);

    emit("stream-cm-1", "restarted", null);
    emit("stream-cm-1", "applied", { name: "pod-0", namespace: "shop" });
    emit("stream-cm-1", "applied", { name: "pod-1", namespace: "shop" });
    emit("stream-cm-1", "synced", null);
    await waitFor(() => expect(hook.result.current).toEqual({ pods: 2 }), {
      timeout: 3000,
    });
  });

  /**
   * A read already in flight may have left before the pod arrived. Fails if
   * the watch's re-read joins it instead of following it, which leaves the
   * sidebar on the count from before the change.
   */
  it("reads the overview after a read that was already in flight", async () => {
    const client = testQueryClient();
    let release: (value: { pods: number }) => void = () => {};
    const overview = vi
      .fn()
      .mockResolvedValueOnce({ pods: 14 })
      .mockImplementationOnce(
        () => new Promise<{ pods: number }>((resolve) => (release = resolve))
      )
      .mockResolvedValue({ pods: 15 });
    client.setQueryData<Scoped<Item>>(PODS, {
      rows: [{ name: "pod-0", namespace: "shop" }],
      unread: [],
    });
    const hook = await watching(client, PODS, SIDEBAR, overview);
    void client.refetchQueries({ queryKey: SIDEBAR });

    emit("stream-cm-1", "applied", { name: "search-2cw59", namespace: "shop" });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    release({ pods: 14 });
    await waitFor(() => expect(hook.result.current).toEqual({ pods: 15 }), {
      timeout: 3000,
    });
    expect(overview).toHaveBeenCalledTimes(3);
  });

  /**
   * A minimised window stops polling; a watch still writing rows must not
   * start reading on its behalf. Fails if a hidden window re-reads at once.
   */
  it("leaves a hidden window's peek stale for its return rather than reading it", async () => {
    const client = testQueryClient();
    const getDeployment = vi
      .fn()
      .mockResolvedValue({ name: "search", ready: 2 });
    client.setQueryData<Scoped<Item>>(DEPLOYMENTS, {
      rows: [{ name: "search", namespace: "shop", data: 2 }],
      unread: [],
    });
    await watching(client, DEPLOYMENTS, PEEK, getDeployment);
    useWindowActivity.setState({ visible: false });

    emit("stream-cm-1", "applied", {
      name: "search",
      namespace: "shop",
      data: 3,
    });
    await waitFor(() =>
      expect(client.getQueryState(PEEK)?.isInvalidated).toBe(true)
    );
    expect(getDeployment).toHaveBeenCalledTimes(1);
  });
});
