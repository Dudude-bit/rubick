import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ResourceConnections,
  StatefulSetDetailInfo,
} from "@/generated/types";

vi.mock("@/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks")>()),
  useResourceDetail: vi.fn(),
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    getStatefulset: vi.fn(async () => buildSet()),
    deleteStatefulset: vi.fn(),
    scaleStatefulset: vi.fn(async () => undefined),
    listPods: vi.fn(async () => []),
    // Read at call time so a test can put this workload in a different
    // neighbourhood before it renders.
    getResourceConnections: vi.fn(async () => connections),
  },
}));

import { useResourceDetail } from "@/hooks";
import { StatefulSetDetail } from "./StatefulSetDetail";

function buildSet(
  overrides: Partial<StatefulSetDetailInfo> = {}
): StatefulSetDetailInfo {
  return {
    name: "stateful-demo",
    namespace: "k8s-gui-test",
    uid: "sts-uid",
    replicas: { desired: 1, ready: 1, current: 1 },
    serviceName: "stateful-demo",
    podManagementPolicy: "OrderedReady",
    updateStrategy: "RollingUpdate",
    containers: [],
    initContainers: [],
    serviceAccountName: null,
    labels: {},
    annotations: {},
    conditions: [],
    ownerReferences: [],
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

/**
 * An HPA that names the StatefulSet, exactly as the connections call returns
 * it. The warning has to survive the whole path — the page's `useConnections`
 * on the StatefulSet kind, `scaleWarnings`, and the dialog.
 */
let connections: ResourceConnections;

const governed: ResourceConnections = {
  subject: {
    kind: "StatefulSet",
    name: "stateful-demo",
    namespace: "k8s-gui-test",
    existence: "present",
    facts: null,
  },
  edges: [
    {
      from: {
        kind: "HorizontalPodAutoscaler",
        name: "hpa-stateful",
        namespace: "k8s-gui-test",
        existence: "present",
        facts: {
          kind: "autoscaler",
          minReplicas: 1,
          maxReplicas: 3,
          currentReplicas: 1,
          desiredReplicas: 1,
          metrics: [
            { name: "cpu", source: "resource", target: "80%", current: "2%" },
          ],
          conditions: [],
          lastScaleTime: null,
        },
      },
      to: {
        kind: "StatefulSet",
        name: "stateful-demo",
        namespace: "k8s-gui-test",
        existence: "present",
        facts: null,
      },
      relation: { verb: "governs", selector: null },
    },
  ],
  stops: [],
  published: [],
  notLookedAt: [],
};

/** The common case: nothing scales it and nothing guards it. */
const ungoverned: ResourceConnections = {
  ...governed,
  edges: [],
};

function mockDetail(set: StatefulSetDetailInfo | undefined) {
  vi.mocked(useResourceDetail).mockReturnValue({
    name: set?.name ?? "stateful-demo",
    namespace: set?.namespace ?? "k8s-gui-test",
    resource: set,
    isLoading: false,
    error: null,
    yaml: "kind: StatefulSet\n",
    copyYaml: vi.fn(),
    activeTab: "overview",
    setActiveTab: vi.fn(),
    goBack: vi.fn(),
    refetch: vi.fn(),
    deleteMutation: { mutate: vi.fn(), isPending: false },
  } as unknown as ReturnType<typeof useResourceDetail>);
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter
        initialEntries={["/statefulsets/k8s-gui-test/stateful-demo"]}
      >
        <StatefulSetDetail />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("StatefulSetDetail", () => {
  beforeEach(() => {
    connections = governed;
    mockDetail(buildSet());
  });

  it("offers Scale — a StatefulSet has a replica count like any other", () => {
    renderPage();
    expect(screen.getByRole("button", { name: "Scale" })).toBeInTheDocument();
  });

  it("names the autoscaler that will put the number back", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Scale" }));

    expect(
      await screen.findByText(/hpa-stateful will put this number back/)
    ).toBeInTheDocument();
    expect(screen.getByText(/keeps this between 1 and 3/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Scale anyway" })
    ).toBeInTheDocument();
  });

  it("lays the Overview out as blocks in one column, never a page-level grid", async () => {
    const { container } = renderPage();
    await screen.findByText("Set by");

    // A grid is allowed *inside* a block — a bar beside its rows, a short
    // fact table in two columns. What is not allowed back is the page-level
    // auto-flow that put "who sets the replica count" and "what a drain must
    // respect" in opposite columns: a grid whose items are the page's blocks.
    for (const grid of container.querySelectorAll('[class*="grid-cols"]')) {
      expect(grid.querySelectorAll("section").length).toBeLessThan(2);
    }
  });

  it("states the replica count once — the bar owns it", async () => {
    mockDetail(buildSet({ replicas: { desired: 3, ready: 3, current: 3 } }));
    connections = {
      ...governed,
      edges: governed.edges.map((edge) => ({
        ...edge,
        from: {
          ...edge.from,
          facts:
            edge.from.facts?.kind === "autoscaler"
              ? { ...edge.from.facts, currentReplicas: 3, desiredReplicas: 3 }
              : edge.from.facts,
        },
      })),
    };

    renderPage();
    await screen.findByText("Set by");

    // The header's `3/3 ready` is identity and exempt; inside the page's own
    // blocks the number is stated by the composition and by nothing else.
    expect(screen.getAllByText("3")).toHaveLength(1);
    expect(screen.queryByText(/3 running/)).toBeNull();
  });

  it("draws no empty Set by row for a workload nothing scales", async () => {
    connections = ungoverned;
    renderPage();

    // The bar is what a workload with no autoscaler and no budget shows.
    await screen.findByText("replica wanted");
    expect(screen.queryByText("Set by")).toBeNull();
    expect(screen.queryByText("A drain waits")).toBeNull();
  });
});
