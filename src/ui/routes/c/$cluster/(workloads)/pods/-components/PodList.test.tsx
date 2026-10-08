import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { fireEvent, screen, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";

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
  containers: [
    {
      name: "app",
      ready: true,
      started: true,
      phase: "app",
      state: { type: "running" },
    },
  ],
  initContainers: [],
  labels: {},
  createdAt: null,
  restartCount: 0,
  lastRestartAt: null,
  cpuRequests: null,
  cpuLimits: null,
  memoryRequests: null,
  memoryLimits: null,
  start: { state: "settled" },
  workload: null,
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

    expect(screen.queryByText("1 Pod")).toBeNull();
    expect(
      screen.getByText("1 Pod, from the namespaces that answered")
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

describe("the row's delete button", () => {
  afterEach(() => {
    vi.mocked(invoke).mockImplementation(async () => undefined);
  });

  /**
   * It opened a plain "are you sure" while the row menu and the peek asked
   * for the name and said what replaces the pod: one pod, two dialogs.
   */
  it("asks what the row menu's Delete asks, name typed and replacement named", async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) =>
      command === "get_pod"
        ? {
            ...api,
            containers: api.containers.map((container) => ({
              ...container,
              image: "api:1",
              lastTerminated: null,
              restartCount: 0,
              ports: [],
              env: [],
              envFrom: [],
            })),
            hostIp: null,
            annotations: {},
            status: { ...api.status, ready: true, conditions: [] },
            ownerReferences: [
              {
                api_version: "apps/v1",
                kind: "ReplicaSet",
                name: "api-7d",
                uid: "rs",
                controller: true,
              },
            ],
          }
        : undefined
    );
    await renderWithRouter(<PodList />, { at: "/c/prod/pods" });

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    const confirm = await screen.findByRole("alertdialog");
    expect(
      within(confirm).getByText("Delete Pod prod/api-0?")
    ).toBeInTheDocument();
    expect(within(confirm).getByLabelText(/to confirm/)).toBeInTheDocument();
    expect(
      await within(confirm).findByText(
        /ReplicaSet api-7d will start a replacement/
      )
    ).toBeInTheDocument();
  });
});

describe("the row's right-click menu", () => {
  /**
   * The menu planned a pod's actions from the list's row, whose containers
   * carry no ports, and the whole page fell over on `container.ports.map`.
   */
  it("opens on a row the list command answered, before the pod is read", async () => {
    await renderWithRouter(<PodList />, { at: "/c/prod/pods" });

    fireEvent.contextMenu(screen.getAllByRole("row")[1], {
      clientX: 30,
      clientY: 40,
    });

    const menu = await screen.findByRole("menu");
    expect(
      within(menu).getByRole("menuitem", { name: "Restart" })
    ).toBeInTheDocument();
    expect(
      within(menu).getByRole("menuitem", { name: "Port forward" })
    ).toBeInTheDocument();
  });
});
