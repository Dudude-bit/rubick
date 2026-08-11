import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/commands", () => ({
  commands: { getPodsMetrics: vi.fn() },
}));

vi.mock("@/integrations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/integrations")>()),
  useCapabilityState: vi.fn(() => ({ state: "absent" })),
}));

import { commands } from "@/lib/commands";
import { useCapabilityState } from "@/integrations";
import { useUsageHistoryStore } from "@/stores/usageHistoryStore";
import { WorkloadUsage } from "./workload-usage";
import type { DeploymentContainerInfo, PodInfo } from "@/generated/types";

function pod(name: string, phase: string): PodInfo {
  return {
    name,
    namespace: "k8s-gui-test",
    uid: `uid-${name}`,
    status: {
      phase,
      display: phase,
      ready: phase === "Running",
      conditions: [],
      message: null,
      reason: null,
    },
    nodeName: "k3d-agent-0",
    podIp: "10.42.0.9",
    hostIp: "172.18.0.3",
    containers: [],
    initContainers: [],
    labels: {},
    annotations: {},
    createdAt: null,
    restartCount: 0,
    lastRestartAt: null,
    cpuRequests: null,
    cpuLimits: null,
    memoryRequests: null,
    memoryLimits: null,
    ownerReferences: [],
    volumes: [],
    serviceAccountName: null,
  };
}

const container: DeploymentContainerInfo = {
  name: "app",
  image: "busybox:1.36",
  phase: "app",
  ports: [],
  resources: { requests: {}, limits: { cpu: "100m", memory: "64Mi" } },
  env: [],
  envFrom: [],
};

function view(props: Partial<Parameters<typeof WorkloadUsage>[0]> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <WorkloadUsage
        kind="CronJob"
        uid="workload-uid"
        namespace="k8s-gui-test"
        template={{ containers: [container], initContainers: [] }}
        pods={[]}
        idle="This CronJob is suspended, so no run will start."
        {...props}
      />
    </QueryClientProvider>
  );
}

describe("WorkloadUsage with nothing running", () => {
  beforeEach(() => {
    useUsageHistoryStore.getState().clear();
    vi.mocked(commands.getPodsMetrics).mockReset();
  });

  it("says a suspended CronJob is idle instead of charting it at zero", () => {
    const { container: dom } = view();
    expect(screen.getByText(/This CronJob is suspended/i)).toBeInTheDocument();
    expect(dom.querySelector("svg")).toBeNull();
  });

  it("counts a Job's exited pods as gone rather than as readings", () => {
    const { container: dom } = view({
      kind: "Job",
      pods: [pod("job-demo-abc", "Succeeded"), pod("job-demo-def", "Failed")],
      idle: "This Job has finished.",
    });
    expect(screen.getByText(/This Job has finished/i)).toBeInTheDocument();
    expect(dom.querySelector("svg")).toBeNull();
  });

  it("asks metrics-server nothing about a workload with no live pod", () => {
    view({ pods: [pod("cron-demo-1-x", "Succeeded")] });
    expect(commands.getPodsMetrics).not.toHaveBeenCalled();
  });
});

describe("WorkloadUsage with nothing running and a supplier that kept it", () => {
  /** Two readings a minute apart, which is a line rather than a dot. */
  const window = {
    samples: [
      { t: 1_700_000_000_000, cpuMillicores: 40, memoryBytes: 30e6 },
      { t: 1_700_000_060_000, cpuMillicores: 90, memoryBytes: 52e6 },
    ],
    resolution: "1m steps",
  };

  beforeEach(() => {
    useUsageHistoryStore.getState().clear();
    vi.mocked(commands.getPodsMetrics).mockReset();
    vi.mocked(useCapabilityState).mockImplementation((key) =>
      key === "usage.history"
        ? {
            state: "ready",
            vendor: "Prometheus",
            endpoint: "prometheus.monitoring:9090",
            use: vi.fn().mockResolvedValue(window),
          }
        : ({ state: "absent" } as never)
    );
  });

  /**
   * The case metrics-server is wrong about and Prometheus is best at. Would
   * break if a finished Job went back to being told "there is no line" while
   * a connected supplier held the hour it spent running — the one question
   * the reader came to this page with.
   */
  it("charts what a finished Job used, from the supplier that kept it", async () => {
    const { container: dom } = view({
      kind: "Job",
      name: "job-demo",
      pods: [pod("job-demo-abc", "Succeeded")],
      idle: "This Job has finished.",
    });

    await waitFor(() => expect(dom.querySelector("svg")).not.toBeNull());
    expect(screen.getByText(/from prometheus.monitoring:9090/i)).toBeVisible();
    expect(screen.getByText(/This Job has finished/i)).toBeVisible();
  });

  /**
   * Would break if the caption went on counting a window nobody is watching.
   * There is no live line here, so a label promising one — or "0s so far" —
   * is the block describing work it is not doing.
   */
  it("claims no live window when there is nothing to watch", async () => {
    const { container: dom } = view({
      kind: "Job",
      name: "job-demo",
      pods: [pod("job-demo-abc", "Succeeded")],
      idle: "This Job has finished.",
    });

    await waitFor(() => expect(dom.querySelector("svg")).not.toBeNull());
    expect(screen.queryByText(/watching from now/i)).toBeNull();
    expect(
      screen.queryByText(/watched since you opened this page/i)
    ).toBeNull();
    expect(screen.queryByText(/so far/i)).toBeNull();
  });

  /**
   * Would break if the last reading before it stopped were printed the way a
   * current one is: `52 MB` beside a limit reads as what the workload is
   * taking right now, and this one has taken nothing for hours.
   */
  it("reports the peak rather than a last reading that reads as now", async () => {
    const { container: dom } = view({
      kind: "Job",
      name: "job-demo",
      pods: [pod("job-demo-abc", "Succeeded")],
      idle: "This Job has finished.",
    });

    await waitFor(() => expect(dom.querySelector("svg")).not.toBeNull());
    expect(screen.getAllByText(/^peak$/)).toHaveLength(2);
  });

  /**
   * Caught on screen on a CronJob that has never fired. Would break if the
   * page promised a past that was never recorded: a supplier answering with
   * an empty window is not the same as one that kept the run, and "this is
   * what Prometheus kept" printed over two empty rows sends the reader to
   * debug a Prometheus that is working perfectly.
   */
  it("does not promise a past the supplier answered nothing for", async () => {
    vi.mocked(useCapabilityState).mockImplementation((key) =>
      key === "usage.history"
        ? {
            state: "ready",
            vendor: "Prometheus",
            endpoint: "prometheus.monitoring:9090",
            use: vi.fn().mockResolvedValue({ samples: [], resolution: "3m" }),
          }
        : ({ state: "absent" } as never)
    );

    view({
      kind: "CronJob",
      name: "meshed-cron-demo",
      pods: [],
      idle: "This CronJob is suspended, so no run will start.",
    });

    expect(
      await screen.findByText(/has nothing for it in this window either/i)
    ).toBeVisible();
    expect(screen.queryByText(/this is what Prometheus kept/i)).toBeNull();
    // The ceiling sentence belongs to a series that can be read against it.
    expect(screen.queryByText(/No limits declared/i)).toBeNull();
  });

  /**
   * The other half of the deal, and the one a regression would be silent
   * about. Without a supplier this page owes exactly what it owed before:
   * the sentence, and no chart of a workload nothing measured.
   */
  it("is unchanged where no supplier is connected", () => {
    vi.mocked(useCapabilityState).mockReturnValue({ state: "absent" } as never);
    const { container: dom } = view({
      kind: "Job",
      name: "job-demo",
      pods: [pod("job-demo-abc", "Succeeded")],
      idle: "This Job has finished.",
    });

    expect(dom.querySelector("svg")).toBeNull();
    expect(screen.getByText(/metrics-server keeps nothing/i)).toBeVisible();
  });
});

describe("WorkloadUsage with a pod running", () => {
  beforeEach(() => {
    useUsageHistoryStore.getState().clear();
    vi.mocked(commands.getPodsMetrics).mockResolvedValue({
      data: [
        {
          name: "stateful-demo-0",
          namespace: "k8s-gui-test",
          cpuMillicores: 12,
          memoryBytes: 20 * 1024 * 1024,
        },
      ],
      status: { status: "available", message: null },
    });
  });

  it("charts the pods it summed, and says how many they were", async () => {
    const { container: dom } = view({
      kind: "StatefulSet",
      pods: [pod("stateful-demo-0", "Running")],
      idle: "This StatefulSet is scaled to zero.",
    });
    await waitFor(() => expect(dom.querySelector("svg")).not.toBeNull());
    expect(screen.getByText(/summed over 1 pod/i)).toBeInTheDocument();
    expect(screen.queryByText(/scaled to zero/i)).not.toBeInTheDocument();
  });
});
