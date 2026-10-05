import { describe, expect, it, vi } from "vite-plus/test";
import { fireEvent, screen } from "@testing-library/react";

import type { PodRow } from "@/generated/types";

const store = vi.hoisted(() => ({
  state: {
    currentNamespace: "default",
    namespaceScope: ["prod", "dev"] as string[],
    isConnected: true,
    contexts: [],
  },
}));

vi.mock("@/stores/clusterStore", () => ({
  useClusterStore: vi.fn(<T,>(selector?: (s: typeof store.state) => T) =>
    typeof selector === "function" ? selector(store.state) : store.state
  ),
}));

const api: PodRow = {
  name: "api-0",
  namespace: "prod",
  uid: "u-1",
  status: { phase: "Running", display: "Running" },
  nodeName: "n1",
  podIp: null,
  containers: [],
  initContainers: [],
  labels: {},
  createdAt: null,
  restartCount: 0,
  lastRestartAt: null,
  cpuRequests: null,
  cpuLimits: null,
  memoryRequests: null,
  memoryLimits: null,
};

vi.mock("@/hooks/usePodsWithMetrics", () => ({
  usePodsWithMetrics: () => ({
    data: [api],
    podStatus: null,
    podUnread: [],
    refetchPodMetrics: vi.fn(),
    isLoading: false,
    error: null,
    unread: [],
    isPlaceholderData: true,
    dataUpdatedAt: 0,
    watchLive: false,
    resyncing: false,
    waitingSince: null,
    refetch: vi.fn(),
  }),
}));

import { renderWithRouter } from "@/test/render";
import { PodList } from "./PodList";

describe("the pod list while a new scope is read", () => {
  /**
   * The pods come from outside `ResourceList`, which only knew a placeholder
   * of its own query: the last scope's pods, standing in, were printed as the
   * new scope's total.
   */
  it("does not total the last scope's pods", async () => {
    await renderWithRouter(<PodList />, { at: "/c/prod/pods" });

    expect(screen.queryByText("1 pod")).toBeNull();
    expect(
      screen.getByText("1 pod, from the namespaces that answered")
    ).toBeVisible();
  });
});

describe("the row's shell button", () => {
  /** It asked for `?tab=terminal`, a tab the pod page does not have, and
   *  landed on the overview with no shell anywhere. */
  it("opens the pod page on its shell tab", async () => {
    const { router } = await renderWithRouter(<PodList />, {
      at: "/c/prod/pods",
    });

    fireEvent.click(screen.getByRole("button", { name: "Shell" }));

    await vi.waitFor(() =>
      expect(router.state.location.href).toBe(
        "/c/prod/pods/prod/api-0?tab=shell"
      )
    );
  });
});
