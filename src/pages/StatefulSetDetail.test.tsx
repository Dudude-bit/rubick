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
const connections: ResourceConnections = {
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
  beforeEach(() => mockDetail(buildSet()));

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
});
