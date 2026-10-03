import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { NodeBudget, NodeInfo } from "@/generated/types";

// ----- Mocks -----
//
// Mock at module-import level so the component sees stub implementations.
// `useResourceDetail` is the central hook controlling render branches; we
// reset its return value per test. Other hooks return safe empty defaults.

vi.mock("@/hooks", () => ({
  useResourceDetail: vi.fn(),
}));

vi.mock("@/hooks/useMetrics", () => ({
  useMetrics: vi.fn(() => ({
    nodeMetrics: [],
    podMetrics: [],
    nodeStatus: { isLoading: false, error: null, available: true },
    podStatus: { isLoading: false, error: null, available: true },
  })),
}));

const budgetMock = vi.fn(async (_name: string) => buildBudget());

vi.mock("@/lib/commands", () => ({
  commands: {
    getNode: vi.fn(async () => buildNode()),
    listPods: vi.fn(async () => []),
    nodeResourceBudget: (name: string) => budgetMock(name),
    cordonNode: vi.fn(async () => undefined),
    uncordonNode: vi.fn(async () => undefined),
  },
}));

vi.mock("@/components/debug", () => ({
  DebugNodeDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="debug-dialog" /> : null,
}));

import { useResourceDetail } from "@/hooks";
import { NodeDetail } from "./NodeDetail";

// ----- Fixtures -----

function buildNode(overrides: Partial<NodeInfo> = {}): NodeInfo {
  return {
    name: "test-node-1",
    uid: "node-uid-1",
    status: {
      ready: true,
      conditions: [
        {
          type: "Ready",
          status: "True",
          reason: "KubeletReady",
          message: "kubelet is posting ready status",
          lastTransitionTime: "2026-04-25T00:00:00Z",
        },
      ],
      addresses: [
        { type: "InternalIP", address: "10.0.0.5" },
        { type: "ExternalIP", address: "1.2.3.4" },
        { type: "Hostname", address: "node1.local" },
      ],
    },
    roles: ["worker"],
    version: "v1.30.0",
    os: "linux",
    arch: "amd64",
    containerRuntime: "containerd://1.7.0",
    labels: { "kubernetes.io/hostname": "node1" },
    taints: [],
    unschedulable: false,
    capacity: {
      cpu: "4",
      memory: "16Gi",
      pods: "110",
      ephemeralStorage: "100Gi",
    },
    allocatable: {
      cpu: "3800m",
      memory: "14Gi",
      pods: "110",
      ephemeralStorage: "90Gi",
    },
    providerId: null,
    createdAt: "2026-04-25T00:00:00Z",
    ...overrides,
  };
}

function buildBudget(overrides: Partial<NodeBudget> = {}): NodeBudget {
  return {
    pods: 12,
    known: true,
    refused: [],
    error: null,
    resources: [
      {
        name: "cpu",
        unit: "cpu",
        capacity: 4000,
        allocatable: 3800,
        requested: 2100,
        limited: 6000,
        extended: false,
      },
      {
        name: "memory",
        unit: "memory",
        capacity: 16 * 1024 ** 3,
        allocatable: 14 * 1024 ** 3,
        requested: 7 * 1024 ** 3,
        limited: 20 * 1024 ** 3,
        extended: false,
      },
      {
        name: "pods",
        unit: "count",
        capacity: 110,
        allocatable: 110,
        requested: 12,
        limited: null,
        extended: false,
      },
      {
        name: "ephemeral-storage",
        unit: "memory",
        capacity: 100 * 1024 ** 3,
        allocatable: 90 * 1024 ** 3,
        requested: 0,
        limited: 0,
        extended: false,
      },
      {
        name: "nvidia.com/gpu",
        unit: "count",
        capacity: 1,
        allocatable: 1,
        requested: 1,
        limited: 1,
        extended: true,
      },
    ],
    ...overrides,
  };
}

function defaultUseResourceDetailReturn(node: NodeInfo) {
  return {
    name: node.name,
    namespace: undefined,
    resource: node,
    isLoading: false,
    error: null,
    yaml: "kind: Node\nmetadata:\n  name: test-node-1\n",
    yamlError: null,
    copyYaml: vi.fn(),
    activeTab: "overview",
    setActiveTab: vi.fn(),
    goBack: vi.fn(),
    refetch: vi.fn(),
  };
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/nodes/test-node-1"]}>
        <NodeDetail />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

// ----- Tests -----

describe("NodeDetail", () => {
  beforeEach(() => {
    vi.mocked(useResourceDetail).mockReturnValue(
      defaultUseResourceDetailReturn(buildNode()) as unknown as ReturnType<
        typeof useResourceDetail
      >
    );
  });

  it("renders the node name in the page title", () => {
    renderPage();
    // The title is a `ResourceName`, so the identity tail is its own span:
    // the heading's text content is the name, its `getByText` is not.
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain(
      "test-node-1"
    );
  });

  it("shows the role badge when the node has a role", () => {
    renderPage();
    expect(screen.getByText("worker")).toBeInTheDocument();
  });

  it("shows a Ready status badge when node is Ready", () => {
    renderPage();
    expect(screen.getByText(/^ready$/i)).toBeInTheDocument();
  });

  it("shows a NotReady status badge when node is not Ready", () => {
    const notReady = buildNode({
      status: {
        ready: false,
        conditions: [],
        addresses: [{ type: "InternalIP", address: "10.0.0.5" }],
      },
    });
    vi.mocked(useResourceDetail).mockReturnValue(
      defaultUseResourceDetailReturn(notReady) as unknown as ReturnType<
        typeof useResourceDetail
      >
    );
    renderPage();
    expect(screen.getByText(/notready/i)).toBeInTheDocument();
  });

  it("renders the tabs (Overview, Pods, Conditions, Labels, YAML)", () => {
    renderPage();
    expect(screen.getByRole("tab", { name: /overview/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^pods/i })).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: /conditions/i })
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /labels/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /yaml/i })).toBeInTheDocument();
  });

  it("displays InternalIP and ExternalIP from the node addresses", () => {
    renderPage();
    expect(screen.getByText("10.0.0.5")).toBeInTheDocument();
    expect(screen.getByText("1.2.3.4")).toBeInTheDocument();
  });

  it('shows "-" for IPs when the node has no matching address', () => {
    const noExternal = buildNode({
      status: {
        ready: true,
        conditions: [],
        addresses: [{ type: "InternalIP", address: "10.0.0.5" }],
      },
    });
    vi.mocked(useResourceDetail).mockReturnValue(
      defaultUseResourceDetailReturn(noExternal) as unknown as ReturnType<
        typeof useResourceDetail
      >
    );
    renderPage();
    // External IP row should fall back to the dash placeholder.
    const dashes = screen.getAllByText("-");
    expect(dashes.length).toBeGreaterThan(0);
  });

  it("shows the kubernetes version, runtime, OS and arch", () => {
    renderPage();
    expect(screen.getByText("v1.30.0")).toBeInTheDocument();
    expect(screen.getByText("containerd://1.7.0")).toBeInTheDocument();
    expect(screen.getByText("linux")).toBeInTheDocument();
    expect(screen.getByText("amd64")).toBeInTheDocument();
  });

  it("shows the Debug Node action button enabled when node loaded", () => {
    renderPage();
    const button = screen.getByRole("button", { name: /debug node/i });
    expect(button).toBeInTheDocument();
    expect(button).toBeEnabled();
  });

  it("returns null (renders nothing meaningful) when no node + no loading + no error", () => {
    vi.mocked(useResourceDetail).mockReturnValue({
      ...defaultUseResourceDetailReturn(buildNode()),
      resource: undefined,
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof useResourceDetail>);

    const { container } = renderPage();
    expect(container.firstChild).toBeNull();
  });
});

describe("the resources table", () => {
  beforeEach(() => {
    budgetMock.mockReset();
    budgetMock.mockImplementation(async () => buildBudget());
    vi.mocked(useResourceDetail).mockReturnValue(
      defaultUseResourceDetailReturn(buildNode()) as never
    );
  });

  /** A device plugin's resource is exactly the row somebody with a GPU node opens this page for. */
  it("lists an extended resource beside the four the kubelet always has", async () => {
    renderPage();
    expect(await screen.findByText("nvidia.com/gpu")).toBeInTheDocument();
    expect(screen.getByText("extended")).toBeInTheDocument();
  });

  /** A sum over the namespaces that could be read is a smaller number presented as the whole. */
  it("says unknown, and which namespaces refused, rather than a partial sum", async () => {
    budgetMock.mockImplementation(async () =>
      buildBudget({
        known: false,
        pods: null,
        refused: ["kube-system", "monitoring"],
        resources: buildBudget().resources.map((r) => ({
          ...r,
          requested: null,
          limited: null,
        })),
      })
    );
    renderPage();
    const notice = await screen.findByText(/kube-system, monitoring/);
    expect(notice).toHaveTextContent("2 namespaces");
    // One "unknown" per resource for requested, and one for limited on all but pods.
    expect(screen.getAllByText("unknown").length).toBe(5 + 4);
  });

  /** The other side of unknown: a non-refusal read error carries the cluster's words, not a partial sum. Fails if the nodeBudgetFailed branch is dropped. */
  it("says requested and limited are unknown with the error when the read failed", async () => {
    budgetMock.mockImplementation(async () =>
      buildBudget({
        known: false,
        pods: null,
        error: "etcdserver: request timed out",
        resources: buildBudget().resources.map((r) => ({
          ...r,
          requested: null,
          limited: null,
        })),
      })
    );
    renderPage();
    expect(
      await screen.findByText(/etcdserver: request timed out/)
    ).toBeInTheDocument();
  });

  /** A read that failed outright is a note with a retry, not a table of blanks that reads as "no resources". Fails if the error branch collapses to an empty table. */
  it("replaces the table with a could-not-read note and a retry when the budget query rejects", async () => {
    budgetMock.mockImplementation(async () => {
      throw new Error("boom");
    });
    renderPage();
    expect(
      await screen.findByText("Could not read what is reserved on this node.")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  /** While the budget is still being read, an empty table would read as "this node reports no resources". Fails if the pending branch is dropped. */
  it("says it is reading rather than drawing an empty table while the budget loads", async () => {
    budgetMock.mockImplementation(() => new Promise<never>(() => {}));
    renderPage();
    expect(await screen.findByText("Reading…")).toBeInTheDocument();
  });
});

describe("the header actions", () => {
  beforeEach(() => {
    budgetMock.mockImplementation(async () => buildBudget());
  });

  /** The list had cordon and drain and the page did not, so a reader on the page went back to the list to act. */
  it("offers cordon and drain on the page, and uncordon once cordoned", () => {
    vi.mocked(useResourceDetail).mockReturnValue(
      defaultUseResourceDetailReturn(buildNode()) as never
    );
    const { unmount } = renderPage();
    expect(screen.getByRole("button", { name: /^cordon$/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^drain$/i })).toBeEnabled();
    unmount();

    vi.mocked(useResourceDetail).mockReturnValue(
      defaultUseResourceDetailReturn(
        buildNode({ unschedulable: true })
      ) as never
    );
    renderPage();
    expect(screen.getByRole("button", { name: /uncordon/i })).toBeEnabled();
  });
});
