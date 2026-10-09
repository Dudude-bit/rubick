import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { act, cleanup, screen, waitFor } from "@testing-library/react";

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

import { commands } from "@/lib/commands";
import { useHintSettingsStore } from "@/stores/hintSettingsStore";
import type { EventInfo, PodInfo } from "@/generated/types";
import { renderWithRouter } from "@/test/render";
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
  return renderWithRouter(
    <MostLikelyPanel
      pod={pod}
      events={[]}
      eventsError={eventsError}
      onOpenTab={() => {}}
    />,
    { at: "/c/test", route: "/c/$cluster" }
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
    await mount(crashing);
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
    await mount(crashing);
    const panel = await screen.findByTestId("most-likely");
    await waitFor(() =>
      expect(panel.textContent).toContain("could not be read")
    );
    expect(panel.textContent).not.toContain("no Service in this namespace");
  });

  /**
   * Sam opened checkout the moment it exited: the panel asked for the run
   * before the one that had just ended, the node had already dropped that
   * one, and it said the log of app was gone while kubectl logs printed it.
   * Fails if a container sitting on its exit is read for the run before,
   * or one backing off or up between crashes is not.
   */
  it.each([
    [
      "has just exited",
      { type: "terminated", reason: "Error", exitCode: 1 },
      false,
    ],
    ["is backing off", { type: "waiting", reason: "CrashLoopBackOff" }, true],
    ["is up between crashes", { type: "running" }, true],
  ])(
    "reads the run that holds the last exit when the container %s",
    async (_, state, previous) => {
      const looping = {
        ...crashing,
        status: {
          ...crashing.status,
          loopingUntil: new Date(Date.now() + 60_000).toISOString(),
        },
        containers: [{ ...crashing.containers[0], state }],
      } as PodInfo;
      await mount(looping);
      await screen.findByTestId("most-likely");
      await waitFor(() =>
        expect(commands.getPodLogs).toHaveBeenCalledWith(
          "payments-7b6d9c5f4-x8k2p",
          "shop",
          "app",
          40,
          null,
          previous
        )
      );
    }
  );

  /**
   * An OOMKilled container backing off was read for its current run, which
   * has not started: the kubelet refuses that with "waiting to start", and
   * the lines before the kill were one run back. Fails if it reads the
   * current run again.
   */
  it("reads the run before for a container killed for memory and backing off", async () => {
    const killed = {
      ...crashing,
      containers: [
        {
          ...crashing.containers[0],
          lastTerminated: {
            ...crashing.containers[0].lastTerminated!,
            reason: "OOMKilled",
            exitCode: 137,
          },
          resources: { requests: {}, limits: { memory: "64Mi" } },
        },
      ],
    } as PodInfo;
    await mount(killed);
    await screen.findByTestId("most-likely");
    await waitFor(() =>
      expect(commands.getPodLogs).toHaveBeenCalledWith(
        "payments-7b6d9c5f4-x8k2p",
        "shop",
        "app",
        40,
        null,
        true
      )
    );
  });

  /** A refused log read is a line, not a missing panel. */
  it("names the container whose log it could not read", async () => {
    vi.mocked(commands.getPodLogs).mockRejectedValueOnce(
      new Error("pods/log is forbidden")
    );
    await mount(crashing);
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
    await mount(healthy, "events is forbidden");
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
    await mount(withSidecars);
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
    await mount(crashing);
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

  it("draws nothing for a pod with nothing wrong, and nothing when switched off", async () => {
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
    await mount(healthy, null);
    expect(screen.queryByTestId("most-likely")).not.toBeInTheDocument();

    useHintSettingsStore.setState({ showPanel: false });
    await mount(crashing);
    expect(screen.queryByTestId("most-likely")).not.toBeInTheDocument();
  });
});

describe("MostLikelyPanel on a pod the scheduler has not placed", () => {
  const unplaced = (secondsLeft: number) =>
    ({
      ...crashing,
      status: {
        ...crashing.status,
        phase: "Pending",
        display: "Pending",
      },
      containers: [
        {
          ...crashing.containers[0],
          state: { type: "waiting", reason: null },
          lastTerminated: null,
          restartCount: 0,
        },
      ],
      restartCount: 0,
      start: {
        state: "starting",
        until: new Date(Date.now() + secondsLeft * 1000).toISOString(),
      },
    }) as unknown as PodInfo;
  const said =
    "0/2 nodes are available: 2 node(s) didn't match Pod's node affinity/selector.";
  const scheduling: EventInfo[] = [
    {
      name: "never-placed.1",
      namespace: "shop",
      uid: "e1",
      type: "Warning",
      reason: "FailedScheduling",
      message: said,
      source: "default-scheduler",
      involvedObject: {
        kind: "Pod",
        name: "never-placed",
        namespace: "shop",
        uid: null,
      },
      count: 1,
      firstTimestamp: null,
      lastTimestamp: null,
    },
  ];
  const copied = async (pod: PodInfo) => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    await renderWithRouter(
      <MostLikelyPanel
        pod={pod}
        events={scheduling}
        eventsError={null}
        onOpenTab={() => {}}
      />,
      { at: "/c/test", route: "/c/$cluster" }
    );
    const panel = await screen.findByTestId("most-likely");
    await act(async () =>
      screen.getByRole("button", { name: /Copy for agent/ }).click()
    );
    return { panel, report: writeText.mock.calls[0]?.[0] ?? "" };
  };

  /**
   * Sam's never-placed pod, 45 s old under a blue Pending badge, got an
   * amber "Most likely: no node fits it", and Copy for agent said the same.
   * Fails if a pod inside its wait is framed or worded as a fault, or one
   * past it is not.
   */
  it("says it is not placed yet in blue inside the wait, and that no node fits it after", async () => {
    const early = await copied(unplaced(15));
    expect(early.panel.className).toContain("border-info/40");
    expect(early.panel.textContent).toContain("Not placed yet");
    expect(early.panel.textContent).toContain(`The scheduler said: ${said}`);
    expect(early.panel.textContent).not.toContain("no node fits it");
    expect(early.report).toContain("App's own guess: Not placed yet");
    cleanup();

    const late = await copied(unplaced(-1));
    expect(late.panel.className).toContain("border-warn/40");
    expect(late.panel.textContent).toContain("Most likely: no node fits it");
    expect(late.report).toContain(
      "App's own guess: Most likely: no node fits it"
    );
  });
});
