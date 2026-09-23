// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { renderHook as render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PodMetrics, Scoped, UnreadNamespace } from "@/generated/types";
import type { PodRow } from "@/lib/pod-rows";
import type { NodeSilence } from "@/lib/node-reporting";
import * as metricsModule from "@/lib/metrics";
import { usePodsWithMetrics } from "./usePodsWithMetrics";

interface ClusterState {
  isConnected: boolean;
  currentNamespace: string;
  namespaceScope: string[];
}

const state = vi.hoisted(() => ({
  pods: [] as PodRow[],
  unread: [] as UnreadNamespace[],
  placeholder: false,
  read: undefined as
    ((ctx: { signal: AbortSignal }) => Promise<unknown>) | undefined,
  fresh: { rows: [], unread: [] } as unknown,
  metrics: [] as PodMetrics[],
  silent: new Map<string, NodeSilence>(),
  cluster: {
    isConnected: true,
    currentNamespace: "default",
    namespaceScope: [],
  } as ClusterState,
}));

// Through the selector, not around it: every reader of this store passes one,
// and a mock that answers with the whole state hands `useNamespaceScope` an
// object where it expects the array it selected.
vi.mock("@/stores/clusterStore", () => ({
  useClusterStore: (selector?: (cluster: ClusterState) => unknown) =>
    selector ? selector(state.cluster) : state.cluster,
}));
vi.mock("@/hooks/useLiveQuery", () => ({
  // Freshness comes with every real answer; a mock without it made the hook
  // read waitingSince off undefined.
  useLiveQuery: (options: {
    queryFn: (ctx: { signal: AbortSignal }) => Promise<unknown>;
  }) => {
    state.read = options.queryFn;
    return {
      data: { rows: state.pods, unread: state.unread },
      isPlaceholderData: state.placeholder,
      isLoading: false,
      error: null,
      freshness: { slowed: false, waitingSince: null },
    };
  },
}));
vi.mock("@/lib/pod-rows", async (original) => ({
  ...(await original<typeof import("@/lib/pod-rows")>()),
  listPodRows: async () => state.fresh,
}));

const client = new QueryClient();
const renderHook = <R>(hook: () => R) =>
  render(hook, {
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children),
  });
vi.mock("@/hooks/useMetrics", () => ({
  useMetrics: () => ({ podMetrics: state.metrics, podStatus: null }),
}));
vi.mock("@/hooks/useSilentNodes", () => ({
  useSilentNodes: () => state.silent,
}));
vi.mock("@/hooks/useResourceWatch", () => ({
  useResourceWatch: () => ({ resyncing: false }),
}));

beforeEach(() => {
  state.unread = [];
  state.placeholder = false;
  client.clear();
  state.pods = ["a", "b"].map(
    (name) => ({ name, namespace: "default", nodeName: "gone" }) as PodRow
  );
  state.metrics = state.pods.map(({ name, namespace }) => ({
    name,
    namespace,
    cpuMillicores: 10,
    memoryBytes: 100,
  }));
  state.silent = new Map([
    ["gone", { node: "gone", since: null, reason: "NodeStatusUnknown" }],
  ]);
});

/** A downstream annotation must not undo identity preservation in the metrics merge. */
it("keeps final pod row references across identical ticks even on a silent node", () => {
  const { result, rerender } = renderHook(() => usePodsWithMetrics());
  const before = result.current.data;
  state.metrics = state.metrics.map((metric) => ({ ...metric }));
  rerender();
  expect(result.current.data[0]).toBe(before[0]);
  expect(result.current.data[1]).toBe(before[1]);
  expect(result.current.data[0].nodeSilence?.reason).toBe("NodeStatusUnknown");
});

/**
 * The two memos are split so a node-silence change re-runs only the
 * annotation, not the pod/metrics merge. The output is byte-identical either
 * way (the merge is idempotent on identity), so only the merge's call count
 * tells the split from the combined memo it replaced.
 */
it("does not re-run the merge when only node silence changes", () => {
  const merge = vi.spyOn(metricsModule, "mergePodsWithMetrics");
  try {
    const { result, rerender } = renderHook(() => usePodsWithMetrics());
    const calls = merge.mock.calls.length;
    // Only the silence changes; pods and metrics keep their references.
    state.silent = new Map([
      ["gone", { node: "gone", since: null, reason: "NodeNotReady" }],
    ]);
    rerender();
    expect(merge.mock.calls.length).toBe(calls);
    expect(result.current.data[0].nodeSilence?.reason).toBe("NodeNotReady");
  } finally {
    merge.mockRestore();
  }
});

/** The hook must expose changed CPU while leaving other annotated rows stable. */
it("replaces only the final row whose CPU changed", () => {
  const { result, rerender } = renderHook(() => usePodsWithMetrics());
  const before = result.current.data;
  state.metrics = [
    { ...state.metrics[0], cpuMillicores: 20 },
    state.metrics[1],
  ];
  rerender();
  expect(result.current.data[0]).not.toBe(before[0]);
  expect(result.current.data[0].cpuMillicores).toBe(20);
  expect(result.current.data[1]).toBe(before[1]);
});

/** Losing metrics must reach the rendered row as unknown, including when it carries a warning. */
it("exposes unknown usage when a pod loses its metrics sample", () => {
  const { result, rerender } = renderHook(() => usePodsWithMetrics());
  const before = result.current.data;
  state.metrics = [state.metrics[1]];
  rerender();
  expect(result.current.data[0]).not.toBe(before[0]);
  expect(result.current.data[0].cpuMillicores).toBeNull();
  expect(result.current.data[0].memoryBytes).toBeNull();
  expect(result.current.data[0].nodeSilence).toEqual(before[0].nodeSilence);
  expect(result.current.data[1]).toBe(before[1]);
});

/**
 * The last scope's answer stands in while a new one is read. Its unread
 * namespaces are not the new scope's, and the page named them under it.
 */
it("does not carry the last scope's unread namespaces into the next", () => {
  state.unread = [
    { namespace: "staging", code: "PERMISSION_DENIED", message: "" },
  ];
  state.placeholder = true;
  const { result } = renderHook(() => usePodsWithMetrics());
  expect(result.current.unread).toEqual([]);
});

/**
 * A re-read under a live watch that timed out in one namespace. The watch
 * still streams that namespace's pods; the answer took them away and called
 * the namespace unread.
 */
it("keeps a watched namespace's pods when a re-read misses it", async () => {
  state.cluster.namespaceScope = ["default", "staging"];
  try {
    const { result } = renderHook(() => usePodsWithMetrics());
    const worker = { name: "worker", namespace: "staging" } as PodRow;
    expect(result.current.watchLive).toBe(true);
    state.fresh = {
      rows: [state.pods[0]],
      unread: [{ namespace: "staging", code: "READ_DEADLINE", message: "" }],
    };
    const { queryKeys } = await import("@/lib/query-keys");
    client.setQueryData<Scoped<PodRow>>(queryKeys.podRows("default,staging"), {
      rows: [state.pods[0], worker],
      unread: [],
    });
    const answer = (await state.read?.({
      signal: new AbortController().signal,
    })) as Scoped<PodRow>;
    expect(answer.rows).toContain(worker);
    expect(answer.unread).toEqual([]);
  } finally {
    state.cluster.namespaceScope = [];
  }
});
