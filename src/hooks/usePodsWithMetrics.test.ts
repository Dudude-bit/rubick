import { beforeEach, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { PodInfo, PodMetrics } from "@/generated/types";
import type { NodeSilence } from "@/lib/node-reporting";
import { usePodsWithMetrics } from "./usePodsWithMetrics";

const state = vi.hoisted(() => ({
  pods: [] as PodInfo[],
  metrics: [] as PodMetrics[],
  silent: new Map<string, NodeSilence>(),
}));

vi.mock("@/stores/clusterStore", () => ({
  useClusterStore: () => ({ isConnected: true, currentNamespace: "default" }),
}));
vi.mock("@/hooks/useLiveQuery", () => ({
  useLiveQuery: () => ({ data: state.pods, isLoading: false, error: null }),
}));
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
  state.pods = ["a", "b"].map(
    (name) => ({ name, namespace: "default", nodeName: "gone" }) as PodInfo
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
