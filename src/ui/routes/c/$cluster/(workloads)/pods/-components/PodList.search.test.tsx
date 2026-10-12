import { describe, expect, it, vi } from "vite-plus/test";
import { fireEvent, screen, waitFor } from "@testing-library/react";

import type { PodRow } from "@/generated/types";

const store = vi.hoisted(() => ({
  state: {
    currentNamespace: "default",
    namespaceScope: [] as string[],
    isConnected: true,
    contexts: [],
  },
}));

vi.mock("@/stores/clusterStore", () => ({
  useClusterStore: vi.fn(<T,>(selector?: (s: typeof store.state) => T) =>
    typeof selector === "function" ? selector(store.state) : store.state
  ),
}));

const pod = (name: string, namespace: string, display: string): PodRow => ({
  name,
  namespace,
  uid: `${namespace}/${name}`,
  status: { phase: "Running", display, exitUnreported: false },
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
  start: { state: "settled" },
  workload: null,
});

const rows = [
  pod("cart-667846ff79-4f68h", "shop", "Running"),
  pod("checkout-7596d7fc77-7r5wt", "shop", "CrashLoopBackOff"),
  pod("ledger-76bccd5b44-499fh", "team-blind", "CrashLoopBackOff"),
  pod("orders-db-0", "shop", "Running"),
];

vi.mock("@/hooks/usePodsWithMetrics", () => ({
  usePodsWithMetrics: () => ({
    data: rows,
    podStatus: null,
    podUnread: [],
    refetchPodMetrics: vi.fn(),
    isLoading: false,
    error: null,
    unread: [],
    isPlaceholderData: false,
    dataUpdatedAt: 1,
    watchLive: true,
    resyncing: false,
    waitingSince: null,
    refetch: vi.fn(),
  }),
}));

import { renderWithRouter } from "@/test/render";
import { PodList } from "./PodList";

const drawn = () => document.querySelectorAll("tr[data-row-index]");
const searchFor = (value: string) =>
  fireEvent.change(screen.getByLabelText("Search..."), { target: { value } });

describe("the Pods list search", () => {
  /**
   * Dana searched "CrashLoop" on call and read "Nothing matches CrashLoop"
   * as no pod crash-looping. Fails if the search stops reading the status
   * kubectl prints, or a search that matched nothing stops naming Status
   * among the columns it looked in.
   */
  it("finds a pod by the status it shows, and names Status where nothing matched", async () => {
    await renderWithRouter(<PodList />, { at: "/c/prod/pods" });
    expect(drawn()).toHaveLength(4);

    searchFor("CrashLoop");
    await waitFor(() => expect(drawn()).toHaveLength(2));
    for (const row of drawn())
      expect(row.textContent).toContain("CrashLoopBackOff");

    searchFor("ImagePullBackOff");
    expect(await screen.findByTestId("searched-columns")).toHaveTextContent(
      /^Searched in .*\bStatus\b.*\.$/
    );
  });
});
