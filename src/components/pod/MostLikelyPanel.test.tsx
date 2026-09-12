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

function mount(pod: PodInfo, eventsError: string | null = null) {
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
            eventsError={eventsError}
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

  /**
   * The third state the panel exists to show. A refused Services list made
   * it say no Service in the namespace answers to that address — a claim
   * about the cluster from a read that never happened.
   */
  it("says it could not read the Services rather than that none answers", async () => {
    vi.mocked(commands.listServices).mockRejectedValueOnce(
      new Error("services is forbidden")
    );
    mount(crashing);
    const panel = await screen.findByTestId("most-likely");
    await waitFor(() =>
      expect(panel.textContent).toContain("could not be read")
    );
    expect(panel.textContent).not.toContain("no Service in this namespace");
  });

  /** A refused log read is a line, not a missing panel. */
  it("names the container whose log it could not read", async () => {
    vi.mocked(commands.getPodLogs).mockRejectedValueOnce(
      new Error("pods/log is forbidden")
    );
    mount(crashing);
    const panel = await screen.findByTestId("most-likely");
    await waitFor(() => expect(panel.textContent).toContain("app"));
    expect(panel.textContent).toContain("forbidden");
  });

  /**
   * Three of the six troubles are read from events. A refused events read
   * used to hide the panel entirely, which is byte-identical to a pod with
   * nothing wrong — the one thing this panel may not do.
   */
  it("does not treat a refused events read as a pod with nothing wrong", async () => {
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
    mount(healthy, "events is forbidden");
    const panel = await screen.findByTestId("most-likely");
    expect(panel.textContent).toContain("could not be read");
    expect(panel.textContent).toContain("forbidden");
  });

  /**
   * The named sidecar was the next container in the list, whatever port it
   * declares — so a pod whose proxy listens on 5432 and whose exporter
   * does not had the exporter blamed. The pod's own `ports` answers it.
   */
  it("names the container that declares the port, not the next one in the list", async () => {
    vi.mocked(commands.getPodLogs).mockResolvedValueOnce([
      {
        raw: "ERROR dial tcp 127.0.0.1:5432: connect: connection refused",
        message: "ERROR dial tcp 127.0.0.1:5432: connect: connection refused",
      },
    ] as never);
    const withSidecars = {
      ...crashing,
      containers: [
        crashing.containers[0],
        {
          ...crashing.containers[0],
          name: "metrics",
          ready: true,
          state: { type: "running" },
          ports: [{ name: null, containerPort: 9090, protocol: "TCP" }],
        },
        {
          ...crashing.containers[0],
          name: "cloud-sql-proxy",
          ready: false,
          state: { type: "running" },
          ports: [{ name: null, containerPort: 5432, protocol: "TCP" }],
        },
      ],
    } as PodInfo;
    mount(withSidecars);
    const panel = await screen.findByTestId("most-likely");
    await waitFor(() => expect(panel.textContent).toContain("cloud-sql-proxy"));
    expect(panel.textContent).not.toContain("metrics");
  });

  /**
   * `shop-db-rw.billing.svc.cluster.local` was matched on the bare name
   * against this namespace's Services, so a same-named Service next door
   * was reported — with its endpoint count — as what stands behind an
   * address in a namespace the app never listed.
   */
  it("does not answer for a Service in a namespace it did not list", async () => {
    vi.mocked(commands.getPodLogs).mockResolvedValueOnce([
      {
        raw: "ERROR dial tcp shop-db-rw.billing.svc.cluster.local:5432: connect: connection refused",
        message:
          "ERROR dial tcp shop-db-rw.billing.svc.cluster.local:5432: connect: connection refused",
      },
    ] as never);
    mount(crashing);
    const panel = await screen.findByTestId("most-likely");
    // The Services of `billing` were never listed, so the sentence says so
    // rather than answering from the same-named Service next door.
    await waitFor(() =>
      expect(panel.textContent).toContain("could not be read")
    );
    expect(panel.textContent).toContain("billing");
    // Not the same-named Service next door, under any wording.
    expect(panel.textContent).not.toContain("Service shop-db-rw");
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
    // With the events read answered, so this cannot pass on a refusal.
    mount(healthy, null);
    expect(screen.queryByTestId("most-likely")).not.toBeInTheDocument();

    useHintSettingsStore.setState({ showPanel: false });
    mount(crashing);
    expect(screen.queryByTestId("most-likely")).not.toBeInTheDocument();
  });
});
