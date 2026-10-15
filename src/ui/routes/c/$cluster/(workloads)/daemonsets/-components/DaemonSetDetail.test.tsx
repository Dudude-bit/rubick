import { describe, it, expect, vi } from "vite-plus/test";
import { screen } from "@testing-library/react";
import type { DaemonSetDetailInfo } from "@/generated/types";

vi.mock("@/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks")>()),
  useResourceDetail: vi.fn(),
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    getDaemonset: vi.fn(),
    deleteDaemonset: vi.fn(),
    restartDaemonset: vi.fn(),
    listPods: vi.fn(async () => []),
    getResourceConnections: vi.fn(async () => ({
      subject: {
        kind: "DaemonSet",
        name: "node-agent",
        namespace: "k8s-gui-test",
        existence: "present",
        facts: null,
      },
      edges: [],
      stops: [],
      published: [],
      notLookedAt: [],
    })),
    detectInClusterExtensions: vi.fn(async () => []),
    getPrometheusConnection: vi.fn(async () => null),
    getLokiConnection: vi.fn(async () => null),
    getPodSetupWarnings: vi.fn(async () => []),
  },
}));

import { useResourceDetail } from "@/hooks";
import { renderWithRouter } from "@/test/render";
import { DaemonSetDetail } from "./DaemonSetDetail";

function buildSet(
  overrides: Partial<DaemonSetDetailInfo> = {}
): DaemonSetDetailInfo {
  return {
    name: "node-agent",
    namespace: "k8s-gui-test",
    uid: "ds-uid",
    desired: 2,
    current: 2,
    ready: 2,
    upToDate: 2,
    available: 2,
    rollout: { state: "ready" },
    rolloutPlan: { strategy: "nodes", nodes: 2, surge: 0, unavailable: 1 },
    updateStrategy: "RollingUpdate",
    containers: [],
    initContainers: [],
    serviceAccountName: null,
    podResources: { requests: {}, limits: {} },
    replica: {
      cpuRequests: null,
      cpuLimits: null,
      memoryRequests: null,
      memoryLimits: null,
      known: true,
    },
    labels: {},
    annotations: {},
    selector: "app=node-agent",
    conditions: [],
    ownerReferences: [],
    generation: null,
    observedGeneration: null,
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function mockDetail(set: DaemonSetDetailInfo, watched?: DaemonSetDetailInfo) {
  vi.mocked(useResourceDetail).mockReturnValue({
    name: set.name,
    namespace: set.namespace,
    resource: set,
    watched,
    isLoading: false,
    error: null,
    yaml: "kind: DaemonSet\n",
    copyYaml: vi.fn(),
    activeTab: "overview",
    setActiveTab: vi.fn(),
    goBack: vi.fn(),
    refetch: vi.fn(),
    deleteMutation: { mutate: vi.fn(), isPending: false },
  } as unknown as ReturnType<typeof useResourceDetail>);
}

const renderPage = () =>
  renderWithRouter(<DaemonSetDetail />, {
    at: "/c/prod/daemonsets/k8s-gui-test/node-agent",
    route: "/c/$cluster/daemonsets/$namespace/$name",
  });

describe("DaemonSetDetail", () => {
  /**
   * The set's header drew its first read while the object watch had already
   * delivered it a node short. Fails if the header draws the read where the
   * watch holds the same set, or draws the watch's set of another uid.
   */
  it("draws the set its watch delivered, not the read behind it", async () => {
    const rolling = buildSet({
      ready: 1,
      available: 1,
      rollout: { state: "rollingOut", updated: 1, desired: 2 },
    });
    mockDetail(buildSet(), rolling);
    const page = await renderPage();
    expect(await screen.findByText("1/2 ready")).toBeInTheDocument();
    page.unmount();

    mockDetail(buildSet(), { ...rolling, uid: "another" });
    await renderPage();
    expect(await screen.findByText("2/2")).toBeInTheDocument();
    expect(screen.queryByText("1/2 ready")).toBeNull();
  });
});
