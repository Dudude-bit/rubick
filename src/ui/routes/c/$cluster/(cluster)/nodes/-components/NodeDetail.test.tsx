import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NodeBudget, NodeInfo, PodInfo } from "@/generated/types";

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
/** What the node's pods and its neighbourhood read, per test. */
const onNode = vi.hoisted(() => ({
  pods: [] as unknown[],
  connections: undefined as unknown,
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    getNode: vi.fn(async () => buildNode()),
    listPods: vi.fn(async () => onNode.pods),
    getResourceConnections: vi.fn(async () => {
      if (!onNode.connections) throw new Error("not read in this test");
      return onNode.connections;
    }),
    nodeResourceBudget: (name: string) => budgetMock(name),
    cordonNode: vi.fn(async () => undefined),
    uncordonNode: vi.fn(async () => undefined),
    startNodeDrain: vi.fn(async () => "drain-1"),
    checkAccess: vi.fn(),
  },
}));

vi.mock("../../../-debug", () => ({
  DebugNodeDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="debug-dialog" /> : null,
}));

import { useResourceDetail } from "@/hooks";
import { commands } from "@/lib/commands";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter } from "@/test/render";
import { NodeDetail } from "./NodeDetail";
import type { AccessQuery } from "@/generated/types";

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
  return renderWithRouter(<NodeDetail />, {
    at: "/c/prod/nodes/test-node-1",
    route: "/c/$cluster/nodes/$name",
  });
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

  it("renders the node name in the page title", async () => {
    await renderPage();
    // The title is a `ResourceName`, so the identity tail is its own span:
    // the heading's text content is the name, its `getByText` is not.
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain(
      "test-node-1"
    );
  });

  it("shows the role badge when the node has a role", async () => {
    await renderPage();
    expect(screen.getByText("worker")).toBeInTheDocument();
  });

  it("shows a Ready status badge when node is Ready", async () => {
    await renderPage();
    expect(screen.getByText(/^ready$/i)).toBeInTheDocument();
  });

  it("shows a NotReady status badge when node is not Ready", async () => {
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
    await renderPage();
    expect(screen.getByText(/notready/i)).toBeInTheDocument();
  });

  it("renders the tabs (Overview, Pods, Conditions, Labels, YAML)", async () => {
    await renderPage();
    expect(screen.getByRole("tab", { name: /overview/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^pods/i })).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: /conditions/i })
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /labels/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /yaml/i })).toBeInTheDocument();
  });

  it("displays InternalIP and ExternalIP from the node addresses", async () => {
    await renderPage();
    expect(screen.getByText("10.0.0.5")).toBeInTheDocument();
    expect(screen.getByText("1.2.3.4")).toBeInTheDocument();
  });

  /** External IP drew a bare "-" here while a Service's empty External IP said "none". */
  it("says none for an address the node does not report", async () => {
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
    await renderPage();
    const row = screen.getByText("External IP").closest("div")!;
    expect(within(row).getByText("none")).toBeInTheDocument();
    expect(screen.queryByText("-")).toBeNull();
  });

  it("shows the kubernetes version, runtime, OS and arch", async () => {
    await renderPage();
    expect(screen.getByText("v1.30.0")).toBeInTheDocument();
    expect(screen.getByText("containerd://1.7.0")).toBeInTheDocument();
    expect(screen.getByText("linux")).toBeInTheDocument();
    expect(screen.getByText("amd64")).toBeInTheDocument();
  });

  it("shows the Debug Node action button enabled when node loaded", async () => {
    await renderPage();
    const button = screen.getByRole("button", { name: /debug node/i });
    expect(button).toBeInTheDocument();
    expect(button).toBeEnabled();
  });

  it("returns null (renders nothing meaningful) when no node + no loading + no error", async () => {
    vi.mocked(useResourceDetail).mockReturnValue({
      ...defaultUseResourceDetailReturn(buildNode()),
      resource: undefined,
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof useResourceDetail>);

    const { container } = await renderPage();
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
    await renderPage();
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
    await renderPage();
    const notice = await screen.findByText(/kube-system, monitoring/);
    expect(notice).toHaveTextContent("2 namespaces");
    // One "unknown" per resource for requested, one for limited on all but
    // pods, and the pods in use, which are the pods requested.
    expect(screen.getAllByText("unknown").length).toBe(5 + 4 + 1);
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
    await renderPage();
    expect(
      await screen.findByText(/etcdserver: request timed out/)
    ).toBeInTheDocument();
  });

  /** A read that failed outright is a note with a retry, not a table of blanks that reads as "no resources". Fails if the error branch collapses to an empty table. */
  it("replaces the table with a could-not-read note and a retry when the budget query rejects", async () => {
    budgetMock.mockImplementation(async () => {
      throw new Error("boom");
    });
    await renderPage();
    expect(
      await screen.findByText("Could not read what is reserved on this node.")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  /** While the budget is still being read, an empty table would read as "this node reports no resources". Fails if the pending branch is dropped. */
  it("says it is reading rather than drawing an empty table while the budget loads", async () => {
    budgetMock.mockImplementation(() => new Promise<never>(() => {}));
    await renderPage();
    expect(await screen.findByText("Reading…")).toBeInTheDocument();
  });
});

describe("the pods on the node", () => {
  /** Sam's controlplane: 39 pods holding a place, 7 Succeeded and 4 Failed. */
  const pod = (name: string, phase: string, display: string) =>
    ({
      name,
      namespace: "shop",
      uid: name,
      status: { phase, display, message: null, reason: null },
      containers: [],
      initContainers: [],
      nodeName: "test-node-1",
      restartCount: 0,
      createdAt: "2026-10-06T21:00:00Z",
    }) as unknown as PodInfo;
  const placed = Array.from({ length: 39 }, (_, i) =>
    pod(`app-${i}`, "Running", "Running")
  );
  const finished = [
    ...Array.from({ length: 7 }, (_, i) =>
      pod(`reports-2985539${i}-done`, "Succeeded", "Completed")
    ),
    ...Array.from({ length: 4 }, (_, i) =>
      pod(`reports-2985538${i}-fail`, "Failed", "Error")
    ),
  ];
  const budget = buildBudget({
    pods: 39,
    resources: buildBudget().resources.map((r) =>
      r.name === "pods" ? { ...r, requested: 39 } : r
    ),
  });

  beforeEach(() => {
    budgetMock.mockReset();
    budgetMock.mockImplementation(async () => budget);
    onNode.pods = [...placed, ...finished];
    onNode.connections = {
      subject: {
        kind: "Node",
        name: "test-node-1",
        namespace: null,
        existence: "present",
        facts: null,
      },
      edges: [...placed, ...finished].map((p) => ({
        from: {
          kind: "Pod",
          name: p.name,
          namespace: p.namespace,
          existence: "present",
          facts: null,
        },
        to: {
          kind: "Node",
          name: "test-node-1",
          namespace: null,
          existence: "present",
          facts: null,
        },
        relation: { verb: "runsOn" },
      })),
      stops: [],
      published: [],
      notLookedAt: [],
    };
  });

  /**
   * Headroom said "Pods 51/110" and Resources Used 51 beside Requested 39,
   * which `kubectl describe node` agrees with: the 51 counted the pods
   * finished Jobs left. Fails if any pod count on the page takes in a pod
   * that holds no place, or two of them disagree.
   */
  it("counts only the pods holding a place, in the headroom and the table alike", async () => {
    vi.mocked(useResourceDetail).mockReturnValue(
      defaultUseResourceDetailReturn(buildNode()) as never
    );
    await renderPage();

    const whole = (text: string) => (_: string, el: Element | null) =>
      el?.tagName === "SPAN" && el.textContent === text;
    expect(await screen.findByText(whole("39/110 · 35%"))).toBeInTheDocument();
    const row = screen
      .getAllByRole("row")
      .find((tr) => tr.firstElementChild?.textContent === "pods")!;
    const [, , , requested, , used] = within(row).getAllByRole("cell");
    expect(requested).toHaveTextContent("39");
    expect(used).toHaveTextContent("39");
  });

  /** The tab's count is the same pods; the finished ones are listed apart, under their own heading. */
  it("lists the finished pods apart and counts the tab by the ones holding a place", async () => {
    vi.mocked(useResourceDetail).mockReturnValue({
      ...defaultUseResourceDetailReturn(buildNode()),
      activeTab: "pods",
    } as never);
    await renderPage();

    const finishedHeading = await screen.findByText("Finished here");
    expect(finishedHeading).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Pods/ })).toHaveTextContent("39");
    expect(screen.getByRole("tab", { name: /Pods/ })).not.toHaveTextContent(
      "50"
    );
  });
});

describe("the header actions", () => {
  beforeEach(() => {
    budgetMock.mockImplementation(async () => buildBudget());
  });

  /** The list had cordon and drain and the page did not, so a reader on the page went back to the list to act. */
  it("offers cordon and drain on the page, and uncordon once cordoned", async () => {
    vi.mocked(useResourceDetail).mockReturnValue(
      defaultUseResourceDetailReturn(buildNode()) as never
    );
    const { unmount } = await renderPage();
    expect(screen.getByRole("button", { name: /^cordon$/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^drain$/i })).toBeEnabled();
    unmount();

    vi.mocked(useResourceDetail).mockReturnValue(
      defaultUseResourceDetailReturn(
        buildNode({ unschedulable: true })
      ) as never
    );
    await renderPage();
    expect(screen.getByRole("button", { name: /uncordon/i })).toBeEnabled();
  });

  /**
   * A drain evicts every pod on the node. Fails if its confirmation opens
   * with the focus anywhere but Cancel, or if a stray Enter starts it.
   */
  it("opens Drain with the cursor on Cancel, so Enter drains nothing", async () => {
    vi.mocked(useResourceDetail).mockReturnValue(
      defaultUseResourceDetailReturn(buildNode()) as never
    );
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: /^drain$/i }));
    const dialog = await screen.findByRole("dialog");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    expect(cancel).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(commands.startNodeDrain).not.toHaveBeenCalled();
  });
});

describe("NodeDetail for a reader who may read nodes and not change them", () => {
  /**
   * Cordon and Drain were live for a reader the cluster refuses a patch on
   * nodes; the click was answered by a 403 toast. Fails if either stays
   * runnable while can-i patch nodes says no.
   */
  it("greys Cordon and Drain with the can-i question", async () => {
    vi.mocked(useResourceDetail).mockReturnValue(
      defaultUseResourceDetailReturn(buildNode()) as unknown as ReturnType<
        typeof useResourceDetail
      >
    );
    vi.mocked(commands.checkAccess).mockImplementation(
      async (queries: AccessQuery[]) =>
        queries.map((query) => ({ ...query, allowed: false }))
    );
    useClusterStore.setState((s) => ({
      currentContext: "prod",
      isConnected: true,
      connectionAttemptId: s.connectionAttemptId + 1,
    }));
    await renderPage();
    for (const name of ["Cordon", "Drain"])
      await waitFor(() =>
        expect(screen.getByRole("button", { name })).toHaveAttribute(
          "aria-disabled",
          "true"
        )
      );
    fireEvent.click(screen.getByRole("button", { name: "Cordon" }));
    expect(commands.cordonNode).not.toHaveBeenCalled();
  });
});
