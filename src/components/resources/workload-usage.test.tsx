import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/commands", () => ({
  commands: { getPodsMetrics: vi.fn() },
}));

import { commands } from "@/lib/commands";
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
