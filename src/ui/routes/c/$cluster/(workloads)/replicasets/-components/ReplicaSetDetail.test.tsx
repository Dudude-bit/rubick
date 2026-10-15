import { describe, it, expect, vi } from "vite-plus/test";
import { screen, waitFor } from "@testing-library/react";
import type { ReplicaSetInfo } from "@/generated/types";

vi.mock("@/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks")>()),
  useResourceDetail: vi.fn(),
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    getReplicaset: vi.fn(),
    getReplicasetPods: vi.fn(async () => []),
    getDeploymentReplicasets: vi.fn(async () => []),
    listPods: vi.fn(async () => []),
    listEvents: vi.fn(async () => []),
    detectInClusterExtensions: vi.fn(async () => []),
    getPrometheusConnection: vi.fn(async () => null),
    getLokiConnection: vi.fn(async () => null),
    getPodSetupWarnings: vi.fn(async () => []),
  },
}));

import { useResourceDetail } from "@/hooks";
import { renderWithRouter } from "@/test/render";
import { ReplicaSetDetail } from "./ReplicaSetDetail";

const SAID =
  'pods "web-6d67bcbdbc-bl2gn" is forbidden: exceeded quota: two-pods, requested: pods=1, used: pods=2, limited: pods=2';

function buildReplicaSet(
  overrides: Partial<ReplicaSetInfo> = {}
): ReplicaSetInfo {
  return {
    name: "web-6d67bcbdbc",
    namespace: "shop",
    uid: "rs-uid",
    replicas: { desired: 4, current: 2, ready: 2, available: 2 },
    revision: "1",
    currentRevision: "1",
    containers: [],
    initContainers: [],
    serviceAccountName: null,
    labels: {},
    annotations: {},
    templateAnnotations: {},
    template: null,
    conditions: [],
    podsRefused: null,
    ownerReferences: [],
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function mockDetail(replicaSet: ReplicaSetInfo) {
  vi.mocked(useResourceDetail).mockReturnValue({
    name: replicaSet.name,
    namespace: replicaSet.namespace,
    resource: replicaSet,
    isLoading: false,
    error: null,
    yaml: "kind: ReplicaSet\n",
    copyYaml: vi.fn(),
    activeTab: "overview",
    setActiveTab: vi.fn(),
    goBack: vi.fn(),
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useResourceDetail>);
}

const renderPage = () =>
  renderWithRouter(<ReplicaSetDetail />, {
    at: "/c/prod/replicasets/shop/web-6d67bcbdbc",
    route: "/c/$cluster/replicasets/$namespace/$name",
  });

describe("ReplicaSetDetail", () => {
  /**
   * The refusal happens to the ReplicaSet, and its Deployment's page said it
   * while the ReplicaSet's own page said nothing. Fails if the page does not
   * lead with the API server's words, or the missing pods are not counted.
   */
  it("leads with the API server's refusal of its pods", async () => {
    mockDetail(buildReplicaSet({ podsRefused: SAID }));
    await renderPage();
    expect(await screen.findByTestId("refused-line")).toHaveTextContent(
      `The API server refuses to create its pods. The API server answered: ${SAID}`
    );
    expect(screen.getByText("2 not created")).toBeInTheDocument();
  });

  /** A revision with every replica up has nothing to explain. */
  it("says no cause while every replica it wants is up", async () => {
    mockDetail(
      buildReplicaSet({
        replicas: { desired: 2, current: 2, ready: 2, available: 2 },
        podsRefused: SAID,
      })
    );
    await renderPage();
    await waitFor(() =>
      expect(screen.getByText("2 ready")).toBeInTheDocument()
    );
    expect(screen.queryByTestId("refused-line")).toBeNull();
  });
});
