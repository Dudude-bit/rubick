import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/commands", () => ({
  commands: {
    getPodLogs: vi.fn(async () => [
      { raw: "INFO starting", message: "INFO starting" },
      {
        raw: "ERROR db: dial tcp 10.43.39.231:5432: connect: connection refused",
        message:
          "ERROR db: dial tcp 10.43.39.231:5432: connect: connection refused",
      },
    ]),
    listServices: vi.fn(async () => [
      { name: "shop-db-rw", namespace: "shop", clusterIp: "10.43.39.231" },
    ]),
    getEndpoints: vi.fn(async () => ({
      name: "shop-db-rw",
      namespace: "shop",
      subsets: [{ addresses: [], notReadyAddresses: [{}, {}, {}], ports: [] }],
      createdAt: null,
      overCapacity: false,
    })),
    getAppInfo: vi.fn(async () => ({ version: "4.9.2" })),
  },
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { commands } from "@/lib/commands";
import { useHintSettingsStore } from "@/stores/hintSettingsStore";
import type { PodInfo } from "@/generated/types";
import { MostLikelyPanel } from "./MostLikelyPanel";

const crashing = {
  name: "payments-7b6d9c5f4-x8k2p",
  namespace: "shop",
  uid: "u",
  status: {
    phase: "Running",
    display: "CrashLoopBackOff",
    ready: false,
    conditions: [],
    message: null,
    reason: null,
  },
  nodeName: null,
  podIp: null,
  hostIp: null,
  containers: [
    {
      name: "app",
      image: "shop/payments:2.14.1",
      ready: false,
      started: false,
      phase: "app",
      state: { type: "waiting", reason: "CrashLoopBackOff" },
      lastTerminated: {
        exitCode: 1,
        signal: null,
        reason: "Error",
        message: null,
        startedAt: null,
        finishedAt: null,
      },
      restartCount: 14,
      ports: [],
      env: [],
      envFrom: [],
    },
  ],
  initContainers: [],
  labels: {},
  annotations: {},
  createdAt: null,
  restartCount: 14,
  lastRestartAt: null,
  cpuRequests: null,
  cpuLimits: null,
  memoryRequests: null,
  memoryLimits: null,
  ownerReferences: [],
  volumes: [],
  serviceAccountName: null,
} as unknown as PodInfo;

function mount(pod: PodInfo) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TooltipProvider>
          <MostLikelyPanel
            pod={pod}
            events={[]}
            eventsError={null}
            onOpenTab={() => {}}
          />
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useHintSettingsStore.setState({ showPanel: true, stripNames: true });
});

describe("MostLikelyPanel", () => {
  /**
   * The sentence follows the chain as it is read: first the crash alone,
   * then, once the log named an address and the Service answered, the
   * Service with nothing behind it. Neither sentence claims a test.
   */
  it("says the Service behind the refused address has nothing ready, and that nothing was probed", async () => {
    mount(crashing);
    const panel = await screen.findByTestId("most-likely");
    await waitFor(() =>
      expect(panel.textContent).toContain(
        "That address is Service shop-db-rw, which has nothing ready behind it"
      )
    );
    expect(commands.getPodLogs).toHaveBeenCalledWith(
      "payments-7b6d9c5f4-x8k2p",
      "shop",
      "app",
      40,
      null,
      true
    );
    expect(panel.textContent).toContain("did not test");
    expect(
      screen.getByRole("button", { name: /Search it/ })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Copy for agent/ })
    ).toBeInTheDocument();
  });

  it("draws nothing for a pod with nothing wrong, and nothing when switched off", () => {
    const healthy = {
      ...crashing,
      status: { ...crashing.status, display: "Running", ready: true },
      containers: [
        {
          ...crashing.containers[0],
          ready: true,
          state: { type: "running" },
          lastTerminated: null,
          restartCount: 0,
        },
      ],
    } as PodInfo;
    mount(healthy);
    expect(screen.queryByTestId("most-likely")).not.toBeInTheDocument();

    useHintSettingsStore.setState({ showPanel: false });
    mount(crashing);
    expect(screen.queryByTestId("most-likely")).not.toBeInTheDocument();
  });
});
