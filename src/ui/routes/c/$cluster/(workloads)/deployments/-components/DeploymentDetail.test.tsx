import { screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks")>()),
  useResourceDetail: vi.fn(),
}));

import { useResourceDetail } from "@/hooks";
import type { AccessQuery, DeploymentInfo } from "@/generated/types";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter } from "@/test/render";
import { DeploymentDetail } from "./DeploymentDetail";

const ledger = {
  name: "ledger",
  namespace: "team-blind",
  uid: "uid",
  replicas: { desired: 1, ready: 1, available: 1, updated: 1 },
  rollout: { state: "ready" },
  rolloutPlan: { strategy: "rolling", replicas: 1, surge: 1, unavailable: 0 },
  strategy: "RollingUpdate",
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
  templateAnnotations: {},
  generation: 1,
  observedGeneration: 1,
  createdAt: "2026-10-01T00:00:00Z",
  conditions: [],
  ownerReferences: [],
} as unknown as DeploymentInfo;

/** How the cluster answers for the Deployment's ReplicaSets, per test. */
const replicaSets = vi.hoisted(() => ({
  answer: (): Promise<unknown> => Promise.resolve([]),
}));

beforeEach(() => {
  useClusterStore.setState({ isConnected: true, currentContext: "prod" });
  vi.mocked(useResourceDetail).mockReturnValue({
    name: "ledger",
    namespace: "team-blind",
    resource: ledger,
    isLoading: false,
    error: null,
    yaml: "",
    copyYaml: vi.fn(),
    activeTab: "replicasets",
    setActiveTab: vi.fn(),
    goBack: vi.fn(),
    refetch: vi.fn(),
    deleteMutation: { mutate: vi.fn(), isPending: false },
  } as unknown as ReturnType<typeof useResourceDetail>);
  vi.mocked(invoke).mockImplementation(async (command: string, args) => {
    if (command === "get_deployment_replicasets") return replicaSets.answer();
    if (command === "check_access")
      return (args as { queries: AccessQuery[] }).queries.map((query) => ({
        ...query,
        allowed: true,
      }));
    if (
      command === "list_service_health_inputs" ||
      (command.startsWith("list_") && command.endsWith("_in"))
    )
      return { rows: [], unread: [] };
    if (command.startsWith("list_") || command.endsWith("_pods")) return [];
    return undefined;
  });
});

const open = () =>
  renderWithRouter(<DeploymentDetail />, {
    at: "/c/prod/deployments/team-blind/ledger",
    route: "/c/$cluster/deployments/$namespace/$name",
  });

describe("the Revisions tab", () => {
  /**
   * A refused ReplicaSet list was answered with none: "Revisions 0" over
   * "This Deployment has no ReplicaSets". Fails if either the tab or its
   * body states none for a list nobody could read.
   */
  it("says the ReplicaSets could not be read, on the tab and in it", async () => {
    replicaSets.answer = () =>
      Promise.reject({ code: "PERMISSION_DENIED", message: "forbidden" });
    await open();

    expect(
      await screen.findByText("Could not read this Deployment's ReplicaSets.")
    ).toBeInTheDocument();
    expect(screen.queryByText("This Deployment has no ReplicaSets")).toBeNull();
    const tab = screen.getByRole("tab", { name: /Revisions/ });
    expect(tab.textContent).not.toMatch(/\d/);
    expect(tab).toHaveAccessibleName(
      "Revisions: Could not read this Deployment's ReplicaSets."
    );
  });

  /** Fails if a list still on its way is counted as none. */
  it("wears no number while the ReplicaSets are still being read", async () => {
    replicaSets.answer = () => new Promise(() => {});
    await open();

    expect(
      screen.getByRole("tab", { name: /Revisions/ }).textContent
    ).not.toMatch(/\d/);
  });
});
