import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { NodeInfo } from "@/generated/types";

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
    clusterMetrics: null,
    nodeStatus: { isLoading: false, error: null, available: true },
    podStatus: { isLoading: false, error: null, available: true },
  })),
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    getNode: vi.fn(async () => buildNode()),
    listPods: vi.fn(async () => []),
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

  it("renders the four tabs (Overview, Conditions, Labels, YAML)", () => {
    renderPage();
    expect(screen.getByRole("tab", { name: /overview/i })).toBeInTheDocument();
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
