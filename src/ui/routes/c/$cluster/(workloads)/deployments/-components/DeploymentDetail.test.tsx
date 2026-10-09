import { screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks")>()),
  useResourceDetail: vi.fn(),
}));

import { useResourceDetail } from "@/hooks";
import type { AccessQuery, DeploymentInfo } from "@/generated/types";
import { queryKeys } from "@/lib/query-keys";
import { forgetRefusals } from "@/lib/refusals";
import { useClusterStore } from "@/stores/clusterStore";
import { renderWithRouter, testQueryClient } from "@/test/render";
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
  forgetRefusals();
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

const open = (client = testQueryClient()) =>
  renderWithRouter(<DeploymentDetail />, {
    at: "/c/prod/deployments/team-blind/ledger",
    route: "/c/$cluster/deployments/$namespace/$name",
    client,
  });

/** The answers below for two commands, every other one as `beforeEach` gives it. */
function answering(
  connections: () => Promise<unknown>,
  pods: () => Promise<unknown> = () => Promise.resolve([])
) {
  const base = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "get_resource_connections") return connections();
    if (command === "get_deployment_pods") return pods();
    return base(command, args);
  });
}

const CREATING = {
  name: "ledger-6d9f7-x2",
  namespace: "team-blind",
  uid: "pod-uid",
  status: {
    phase: "Pending",
    display: "ContainerCreating",
    exitUnreported: false,
    ready: false,
    loopingUntil: null,
    conditions: [],
    message: null,
    reason: null,
  },
  nodeName: "k3d-agent-0",
  podIp: null,
  hostIp: null,
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
  start: {
    state: "starting",
    until: new Date(Date.now() + 600_000).toISOString(),
  },
  workload: null,
};

const onOverview = () =>
  vi.mocked(useResourceDetail).mockReturnValue({
    ...vi.mocked(useResourceDetail)(
      {} as Parameters<typeof useResourceDetail>[0]
    ),
    activeTab: "overview",
  });

/** The page's own read of the Deployment landing, which is what the page holds. */
const read = (client: ReturnType<typeof testQueryClient>) =>
  client.setQueryData(
    queryKeys.detail("Deployment", "team-blind", "ledger"),
    ledger
  );

describe("the Overview", () => {
  /**
   * Sam's big-pull page said "Could not read what connects to this:
   * Resource not found: Deployment/big-pull" beside the Deployment it had
   * just read as Ready: the neighbourhood was asked before it was created.
   * Fails if a NotFound older than the page's read of its Deployment is
   * drawn, or is not asked again.
   */
  it("reads a NotFound older than the Deployment it holds as still reading, and asks again", async () => {
    let asked = 0;
    answering(() => {
      asked += 1;
      return asked === 1
        ? Promise.reject({
            code: "NOT_FOUND",
            message:
              "Resource not found: Deployment/ledger in namespace team-blind",
          })
        : new Promise(() => {});
    });
    onOverview();
    const client = testQueryClient();
    await open(client);
    expect(
      await screen.findByText("Could not read what connects to this.")
    ).toBeInTheDocument();

    read(client);

    await waitFor(() =>
      expect(
        screen.queryByText("Could not read what connects to this.")
      ).toBeNull()
    );
    await waitFor(() => expect(asked).toBe(2));
  });

  /**
   * At 17:31:09.163 the same page's header said Ready while its Replicas bar
   * still said blue "1 starting": the pods were read before the Deployment
   * was. Fails if a pods read older than the page's read of its Deployment
   * splits the bar against the header, or is not asked again.
   */
  it("splits its Replicas bar by no pods read before the Deployment that count another number ready", async () => {
    let asked = 0;
    answering(
      () => new Promise(() => {}),
      () => {
        asked += 1;
        return asked === 1
          ? Promise.resolve({ uid: "uid", pods: [CREATING] })
          : new Promise(() => {});
      }
    );
    onOverview();
    const client = testQueryClient();
    read(client);
    await open(client);
    expect(await screen.findByText("1 starting")).toBeInTheDocument();

    await new Promise((resolve) => setTimeout(resolve, 5));
    read(client);

    expect(await screen.findByText("1 ready")).toBeInTheDocument();
    expect(screen.queryByText("1 starting")).toBeNull();
    await waitFor(() => expect(asked).toBe(2));
  });
});

describe("the Pods tab", () => {
  /**
   * Sam deleted big-pull and applied it again: the new Deployment's Pods tab
   * counted 1 and listed the old one's pod green "Running" while kubectl had
   * it Terminating and no pod owned by the new one. Fails if pods read for
   * another Deployment of its name are listed or counted under this one, or
   * are not asked for again.
   */
  it("lists none of the pods read for the Deployment deleted before this one, and asks again", async () => {
    let asked = 0;
    answering(
      () => new Promise(() => {}),
      () => {
        asked += 1;
        return asked === 1
          ? Promise.resolve({
              uid: "the-one-deleted",
              pods: [
                {
                  ...CREATING,
                  name: "ledger-6d9f7-old",
                  status: { ...CREATING.status, display: "Running" },
                },
              ],
            })
          : new Promise(() => {});
      }
    );
    vi.mocked(useResourceDetail).mockReturnValue({
      ...vi.mocked(useResourceDetail)(
        {} as Parameters<typeof useResourceDetail>[0]
      ),
      activeTab: "pods",
    });
    const client = testQueryClient();
    await open(client);
    await waitFor(() => expect(asked).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText("ledger-6d9f7-old")).toBeNull();

    read(client);

    await waitFor(() => expect(asked).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText("ledger-6d9f7-old")).toBeNull();
    expect(screen.getByRole("tab", { name: /Pods/ }).textContent).not.toMatch(
      /\d/
    );
  });
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

  /**
   * Sam opened big-pull's page before applying it: the Revisions tab kept
   * "Could not read this Deployment's ReplicaSets: deployments.apps
   * big-pull not found" beside the Deployment Ready 1/1 until he asked
   * again. Fails if a NotFound from before the page read its Deployment is
   * drawn once it has, or is not asked again.
   */
  it("reads a NotFound from before the Deployment was made as still reading, and asks again", async () => {
    let asked = 0;
    replicaSets.answer = () => {
      asked += 1;
      return asked === 1
        ? Promise.reject({
            code: "NOT_FOUND",
            message: 'deployments.apps "ledger" not found',
          })
        : new Promise(() => {});
    };
    const client = testQueryClient();
    await open(client);
    expect(
      await screen.findByText("Could not read this Deployment's ReplicaSets.")
    ).toBeInTheDocument();

    read(client);

    await waitFor(() =>
      expect(
        screen.queryByText("Could not read this Deployment's ReplicaSets.")
      ).toBeNull()
    );
    await waitFor(() => expect(asked).toBe(2));
    expect(screen.getByText("reading…")).toBeInTheDocument();
    expect(screen.queryByText("This Deployment has no ReplicaSets")).toBeNull();
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

describe("a Deployment page before its read has answered", () => {
  /**
   * Lena's deep link to big-pull drew the content pane blank: with no object,
   * no failure and no fetch in flight, as a read reset or called off leaves
   * it, the page returned nothing. Fails if it draws anything but its
   * placeholder then.
   */
  it("draws its placeholder rather than nothing", async () => {
    const held = vi.mocked(useResourceDetail)({} as never);
    vi.mocked(useResourceDetail).mockReturnValue({
      ...held,
      resource: undefined,
      isLoading: false,
      error: null,
    });
    await open();
    expect(screen.getByTestId("detail-skeleton")).toBeInTheDocument();
  });
});
