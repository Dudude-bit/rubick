import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

// ----- Mocks -----

type Handler = (event: { payload: unknown }) => void;

const handlers: Record<string, Set<Handler>> = {};
const order: string[] = [];

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (channel: string, handler: Handler) => {
    order.push(`listen:${channel}`);
    (handlers[channel] ??= new Set()).add(handler);
    return () => {
      handlers[channel]?.delete(handler);
    };
  }),
}));

let nextSearchId = 0;
const startedRequests: Array<Record<string, unknown>> = [];
let targetsForNextStart: Array<Record<string, unknown>> = [];

vi.mock("@/lib/commands", () => ({
  commands: {
    startResourceSearch: vi.fn(async (request: Record<string, unknown>) => {
      startedRequests.push(request);
      nextSearchId += 1;
      return {
        searchId: `search-${nextSearchId}`,
        targets: targetsForNextStart,
      };
    }),
    resourceSearchSubscribed: vi.fn(async (id: string) => {
      order.push(`subscribed:${id}`);
    }),
    cancelResourceSearch: vi.fn(async () => undefined),
  },
}));

import { commands } from "@/lib/commands";
import { useResourceSearch } from "./useResourceSearch";

// ----- Helpers -----

function emit(channel: string, payload: unknown) {
  act(() => {
    for (const handler of handlers[channel] ?? []) handler({ payload });
  });
}

function searching(...contexts: string[]) {
  return contexts.map((context) => ({
    context,
    status: "searching",
    reason: null,
    message: null,
  }));
}

function hit(context: string, name: string) {
  return { context, kind: "Pod", name, namespace: "default" };
}

describe("useResourceSearch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const key of Object.keys(handlers)) delete handlers[key];
    order.length = 0;
    startedRequests.length = 0;
    nextSearchId = 0;
    targetsForNextStart = searching("dev");
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("streams hits from every cluster, each tagged with where it came from", async () => {
    targetsForNextStart = searching("dev", "prod");
    const { result } = renderHook(() =>
      useResourceSearch({ query: "api", contexts: ["dev", "prod"] })
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(result.current.clusters).toHaveLength(2);

    emit("search-hits", {
      search_id: "search-1",
      context: "dev",
      hits: [hit("dev", "api-0")],
    });
    emit("search-hits", {
      search_id: "search-1",
      context: "prod",
      hits: [hit("prod", "api-7")],
    });

    expect(result.current.hits).toEqual([
      expect.objectContaining({ context: "dev", name: "api-0" }),
      expect.objectContaining({ context: "prod", name: "api-7" }),
    ]);
    expect(result.current.isSearching).toBe(true);

    emit("search-status", {
      search_id: "search-1",
      context: "dev",
      status: "done",
      reason: null,
      message: null,
      matched: 1,
      truncated: false,
    });
    emit("search-status", {
      search_id: "search-1",
      context: "prod",
      status: "done",
      reason: null,
      message: null,
      matched: 1,
      truncated: false,
    });

    expect(result.current.isSearching).toBe(false);
  });

  it("reports a cluster that failed as failed, never as empty", async () => {
    targetsForNextStart = searching("dev", "prod");
    const { result } = renderHook(() =>
      useResourceSearch({ query: "api", contexts: ["dev", "prod"] })
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(result.current.clusters).toHaveLength(2);

    emit("search-hits", {
      search_id: "search-1",
      context: "dev",
      hits: [hit("dev", "api-0")],
    });
    emit("search-status", {
      search_id: "search-1",
      context: "dev",
      status: "done",
      reason: null,
      message: null,
      matched: 1,
      truncated: false,
    });
    emit("search-status", {
      search_id: "search-1",
      context: "prod",
      status: "failed",
      reason: "unreachable",
      message: "Connection refused (os error 111)",
      matched: 0,
      truncated: false,
    });

    // The good cluster's results survive the bad one entirely.
    expect(result.current.hits).toHaveLength(1);

    const prod = result.current.clusters.find((c) => c.context === "prod");
    expect(prod?.status).toBe("failed");
    expect(prod?.reason).toBe("unreachable");
    expect(prod?.message).toBe("Connection refused (os error 111)");

    const dev = result.current.clusters.find((c) => c.context === "dev");
    expect(dev?.status).toBe("done");
    // Both clusters produced zero *unmatched* rows; only the status
    // tells them apart, which is the whole point.
    expect(dev?.reason).toBeNull();
    expect(result.current.isSearching).toBe(false);
  });

  it("surfaces a cold cluster as skipped with a reason instead of dropping it", async () => {
    targetsForNextStart = [
      ...searching("dev"),
      {
        context: "prod",
        status: "skipped",
        reason: "not-connected",
        message: "'prod' is not connected — searching it opens a connection",
      },
    ];
    const { result } = renderHook(() =>
      useResourceSearch({ query: "api", contexts: ["dev", "prod"] })
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(result.current.clusters).toHaveLength(2);

    const prod = result.current.clusters.find((c) => c.context === "prod");
    expect(prod?.status).toBe("skipped");
    expect(prod?.reason).toBe("not-connected");
    // Typing must not open connections: the request says so.
    expect(startedRequests[0].connect).toBe(false);
  });

  it("cancels the superseded search on the backend, not just its results", async () => {
    const { rerender } = renderHook(
      ({ query }: { query: string }) => useResourceSearch({ query }),
      { initialProps: { query: "api" } }
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(commands.startResourceSearch).toHaveBeenCalledTimes(1);

    rerender({ query: "apiserver" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(commands.cancelResourceSearch).toHaveBeenCalledWith("search-1");
    expect(commands.startResourceSearch).toHaveBeenCalledTimes(2);
  });

  it("does not fire a request per keystroke", async () => {
    const { rerender } = renderHook(
      ({ query }: { query: string }) => useResourceSearch({ query }),
      { initialProps: { query: "ap" } }
    );

    rerender({ query: "api" });
    rerender({ query: "apis" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(commands.startResourceSearch).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(commands.startResourceSearch).toHaveBeenCalledTimes(1);
    expect(startedRequests[0].query).toBe("apis");
  });

  it("releases the backend gate only after both listeners are installed", async () => {
    renderHook(() => useResourceSearch({ query: "api" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(order).toContain("subscribed:search-1");
    expect(order.indexOf("listen:search-hits")).toBeLessThan(
      order.indexOf("subscribed:search-1")
    );
    expect(order.indexOf("listen:search-status")).toBeLessThan(
      order.indexOf("subscribed:search-1")
    );
  });

  it("runs the identical request again when the attempt is bumped", async () => {
    const { rerender } = renderHook(
      ({ attempt }: { attempt: number }) =>
        useResourceSearch({ query: "api", attempt }),
      { initialProps: { attempt: 0 } }
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(commands.startResourceSearch).toHaveBeenCalledTimes(1);

    // A retry asks exactly the question that failed, so nothing else in
    // the request changes — and without the attempt nothing would happen.
    rerender({ attempt: 1 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(commands.startResourceSearch).toHaveBeenCalledTimes(2);
    expect(startedRequests[1]).toEqual(startedRequests[0]);
  });

  it("keeps the roster across a keystroke, and the hits with the old query", async () => {
    targetsForNextStart = [
      ...searching("dev"),
      {
        context: "prod",
        status: "skipped",
        reason: "not-connected",
        message: null,
      },
    ];
    const { result, rerender } = renderHook(
      ({ query }: { query: string }) =>
        useResourceSearch({ query, contexts: ["dev", "prod"] }),
      { initialProps: { query: "api" } }
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    emit("search-hits", {
      search_id: "search-1",
      context: "dev",
      hits: [hit("dev", "api-0")],
    });
    emit("search-status", {
      search_id: "search-1",
      context: "dev",
      status: "done",
      reason: null,
      message: null,
      matched: 1,
      truncated: false,
    });

    // Mid-debounce for the next query: "no clusters answered" over a
    // fan-out that is still there would be a lie once per keystroke.
    rerender({ query: "apis" });
    expect(result.current.hits).toEqual([]);
    expect(result.current.isSearching).toBe(true);
    expect(result.current.clusters.map((c) => c.status)).toEqual([
      "searching",
      "skipped",
    ]);
  });

  it("drops the roster when the clusters themselves change", async () => {
    targetsForNextStart = searching("dev");
    const { result, rerender } = renderHook(
      ({ contexts }: { contexts: string[] }) =>
        useResourceSearch({ query: "api", contexts }),
      { initialProps: { contexts: ["dev"] } }
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(result.current.clusters).toHaveLength(1);

    rerender({ contexts: ["prod"] });
    expect(result.current.clusters).toEqual([]);
  });

  it("stays idle below the minimum query length", async () => {
    const { result } = renderHook(() => useResourceSearch({ query: "a" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(commands.startResourceSearch).not.toHaveBeenCalled();
    expect(result.current.isSearching).toBe(false);
    expect(result.current.clusters).toEqual([]);
  });
});
