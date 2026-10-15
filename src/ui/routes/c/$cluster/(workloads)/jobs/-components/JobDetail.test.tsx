import { describe, it, expect, vi } from "vite-plus/test";
import { screen } from "@testing-library/react";
import type { JobDetailInfo } from "@/generated/types";

vi.mock("@/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks")>()),
  useResourceDetail: vi.fn(),
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    getJob: vi.fn(),
    deleteJob: vi.fn(),
    listPods: vi.fn(async () => []),
    listEvents: vi.fn(async () => []),
    getResourceConnections: vi.fn(async () => ({
      subject: {
        kind: "Job",
        name: "nightly-report",
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
import { commands } from "@/lib/commands";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter } from "@/test/render";
import { JobDetail } from "./JobDetail";

function buildJob(overrides: Partial<JobDetailInfo> = {}): JobDetailInfo {
  return {
    name: "nightly-report",
    namespace: "k8s-gui-test",
    uid: "job-uid",
    completions: 1,
    parallelism: 1,
    backoffLimit: 6,
    activeDeadlineSeconds: null,
    succeeded: 0,
    failed: 0,
    active: 1,
    status: "Running",
    failure: null,
    startTime: "2026-01-01T00:00:00Z",
    completionTime: null,
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
    conditions: [],
    ownerReferences: [],
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function mockDetail(job: JobDetailInfo, watched?: JobDetailInfo) {
  vi.mocked(useResourceDetail).mockReturnValue({
    name: job.name,
    namespace: job.namespace,
    resource: job,
    watched,
    isLoading: false,
    error: null,
    yaml: "kind: Job\n",
    copyYaml: vi.fn(),
    activeTab: "overview",
    setActiveTab: vi.fn(),
    goBack: vi.fn(),
    refetch: vi.fn(),
    deleteMutation: { mutate: vi.fn(), isPending: false },
  } as unknown as ReturnType<typeof useResourceDetail>);
}

const renderPage = () =>
  renderWithRouter(<JobDetail />, {
    at: "/c/prod/jobs/k8s-gui-test/nightly-report",
    route: "/c/$cluster/jobs/$namespace/$name",
  });

describe("JobDetail", () => {
  /**
   * The Job's header said Running after its watch had delivered it Complete.
   * Fails if the header draws the read where the watch holds the same Job,
   * or draws the watch's Job of another uid.
   */
  it("draws the Job its watch delivered, not the read behind it", async () => {
    const done = buildJob({
      status: "Complete",
      succeeded: 1,
      active: 0,
      completionTime: "2026-01-01T00:05:00Z",
    });
    mockDetail(buildJob(), done);
    const page = await renderPage();
    expect(await screen.findByText("Complete")).toBeInTheDocument();
    expect(screen.queryByText("Running")).toBeNull();
    page.unmount();

    mockDetail(buildJob(), { ...done, uid: "another" });
    await renderPage();
    expect(await screen.findByText("Running")).toBeInTheDocument();
    expect(screen.queryByText("Complete")).toBeNull();
  });

  /**
   * A quota refused every pod the Job asked for, and its page said Pending in
   * grey with no pod to say why. Fails if the header does not say
   * FailedCreate or the page does not quote the refusal.
   */
  it("says FailedCreate and quotes the refusal when the API server refuses its pods", async () => {
    const said =
      'Error creating: pods "nightly-report-x" is forbidden: exceeded quota: two-pods';
    vi.mocked(commands.listEvents).mockResolvedValue([
      {
        name: "e",
        namespace: "k8s-gui-test",
        uid: "e",
        type: "Warning",
        reason: "FailedCreate",
        message: said,
        source: "job-controller",
        involvedObject: {
          kind: "Job",
          name: "nightly-report",
          namespace: "k8s-gui-test",
          uid: "job-uid",
        },
        count: 4,
        firstTimestamp: null,
        lastTimestamp: "2026-01-01T00:01:00Z",
      },
    ]);
    useClusterStore.setState({ currentContext: "prod", isConnected: true });
    mockDetail(buildJob({ status: "Pending", active: 0, startTime: null }));
    await renderPage();
    expect(await screen.findByTestId("refused-line")).toHaveTextContent(
      `The API server refuses to create its pods. The API server answered: ${said}`
    );
    expect(screen.getAllByText("FailedCreate").length).toBeGreaterThan(0);
    expect(screen.queryByText("Pending")).toBeNull();
    vi.mocked(commands.listEvents).mockResolvedValue([]);
  });
});
