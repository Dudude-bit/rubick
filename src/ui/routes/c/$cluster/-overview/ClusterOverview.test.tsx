/**
 * The overview needs a cluster-wide read, and an RBAC-scoped user does not
 * have it. That refusal must read as a refusal — no permission, pick your
 * namespaces — and never as the raw "Could not read cluster state" fault with
 * a retry that will be refused the same way. Deleting the `isRefusal` branch
 * puts the reported screenshot (a Tauri error dump on Overview) back.
 */

import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";

vi.mock("@/lib/commands", () => ({
  commands: {
    getClusterOverview: vi.fn(),
    getClusterInfo: vi.fn(async () => null),
    checkListAccess: vi.fn(async () => []),
  },
}));

import {
  ScreenShareProvider,
  useScreenSections,
} from "@/components/share/screen-share";
import { commands } from "@/lib/commands";
import { SCOPE_PICKER_OPEN } from "@/lib/read-deadline";
import type { ClusterOverview as ClusterOverviewData } from "@/generated/types";
import { useClusterStore } from "@/stores/clusterStore";
import { usePinnedServicesStore } from "@/stores/pinnedServicesStore";
import { renderWithRouter } from "@/test/render";
import { ClusterOverview } from "./ClusterOverview";

const getClusterOverview = vi.mocked(commands.getClusterOverview);

function mount(ui: ReactElement = <ClusterOverview />) {
  return renderWithRouter(ui, { at: "/c/prod", route: "/c/$cluster" });
}

beforeEach(() => {
  getClusterOverview.mockReset();
  useClusterStore.setState({
    isConnected: true,
    currentContext: "",
    namespaceScope: [],
  });
});

describe("what the overview does when the read is refused", () => {
  /** Fails if a refusal is called a fault, or offered no read again after rights change. */
  it("names the refusal and still offers the read again when the cluster forbids it", async () => {
    getClusterOverview.mockRejectedValue(
      'Tauri command \'getClusterOverview\' failed: pods is forbidden: User "kc" cannot list resource "pods" in API group "" at the cluster scope: Forbidden (code: 403)'
    );

    await mount();

    await waitFor(() =>
      expect(
        screen.getByText(/do not have permission to read the whole cluster/i)
      ).toBeInTheDocument()
    );
    expect(
      screen.getByRole("button", { name: "Try the read again" })
    ).toBeInTheDocument();
    // The fault headline is the wrong words for a refusal.
    expect(
      screen.queryByText("Could not read cluster state")
    ).not.toBeInTheDocument();
    // And the framing prefix the reporter saw is off the message.
    expect(screen.queryByText(/Tauri command/)).not.toBeInTheDocument();
  });

  /**
   * The banner used to say "pick the namespaces you can see" over a picker
   * that showed none. Fails if the refusal stops leading to the picker.
   */
  it("opens the namespace picker from the refusal", async () => {
    getClusterOverview.mockRejectedValue(
      "pods is forbidden: Forbidden (code: 403)"
    );
    const opened = vi.fn();
    window.addEventListener(SCOPE_PICKER_OPEN, opened);

    await mount();
    (await screen.findByRole("button", { name: "Choose a namespace" })).click();

    window.removeEventListener(SCOPE_PICKER_OPEN, opened);
    expect(opened).toHaveBeenCalledOnce();
  });

  /**
   * Marco under All namespaces: the list pages named team-checkout as where
   * he could list them, and the Overview only said to type a namespace he
   * has. Fails if the Overview stops naming the namespace it can read.
   */
  it("names the namespace the reader can open, as the list pages do", async () => {
    useClusterStore.setState({
      currentContext: "prod",
      contexts: [{ name: "prod", namespace: "team-checkout" } as never],
    });
    vi.mocked(commands.checkListAccess).mockImplementation(
      async (queries, namespaces) =>
        queries.map((query) => ({
          resource: query.resource,
          allowed: namespaces?.[0] === "team-checkout",
        }))
    );
    getClusterOverview.mockRejectedValue(
      "pods is forbidden: Forbidden (code: 403)"
    );

    await mount();

    expect(
      await screen.findByText(
        "You do not have permission to read the whole cluster. You can read team-checkout: choose it in the namespace picker above."
      )
    ).toBeInTheDocument();
    expect(commands.checkListAccess).toHaveBeenCalledWith(
      [{ group: "", resource: "pods", namespaced: true }],
      ["team-checkout"]
    );
  });

  it("keeps the fault headline and a retry when the read fails for any other reason", async () => {
    getClusterOverview.mockRejectedValue(
      "Tauri command 'getClusterOverview' failed: error trying to connect: connection refused"
    );

    await mount();

    await waitFor(() =>
      expect(
        screen.getByText("Could not read cluster state")
      ).toBeInTheDocument()
    );
    expect(
      screen.getByRole("button", { name: "Try the read again" })
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/do not have permission to read the whole cluster/i)
    ).not.toBeInTheDocument();
  });
});

describe("what stands when the cluster-wide read does not", () => {
  /**
   * The pinned list is read per object and owes nothing to the cluster-wide
   * answer. It sat behind the refusal branch, so the reader it exists for —
   * the one whose token reads their own workloads and not the cluster —
   * opened a home page with the refusal on it and nothing else.
   */
  it("keeps the pinned services on screen when the overview is refused", async () => {
    usePinnedServicesStore.setState({
      pins: [
        {
          context: "prod",
          kind: "Deployment",
          namespace: "shop",
          name: "payments",
          pinnedAt: 1,
        },
      ],
    });
    useClusterStore.setState({ isConnected: true, currentContext: "prod" });
    getClusterOverview.mockRejectedValue(
      'pods is forbidden: User "kc" cannot list resource "pods" (code: 403)'
    );

    await mount();

    // The refusal first, so this asserts about the refused screen and not
    // about the skeleton that precedes it.
    await waitFor(() =>
      expect(
        screen.getByText(/do not have permission to read the whole cluster/i)
      ).toBeInTheDocument()
    );
    expect(screen.getByText("payments")).toBeVisible();
  });
});

const FULL_OVERVIEW: ClusterOverviewData = {
  servedFrom: "list",
  problems: [],
  problemsTruncated: 0,
  scheduler: {
    cpu: { requested: 1000, allocatable: 4000, usage: null },
    memory: { requested: 0, allocatable: 0, usage: null },
  },
  nodes: [
    {
      name: "node-a",
      ready: true,
      schedulable: true,
      roles: [],
      podCount: 1,
      podCapacity: 110,
      cpu: { requested: 0, allocatable: 0, usage: null },
      memory: { requested: 0, allocatable: 0, usage: null },
    },
  ],
  nodesKnown: true,
  warnings: [],
  warningsKnown: true,
  namespaces: [],
  counts: {
    pods: 1,
    deployments: 0,
    statefulSets: 0,
    daemonSets: 0,
    jobs: 0,
    cronJobs: 0,
    nodes: 1,
    namespaces: 1,
    services: 0,
    ingresses: 0,
    configMaps: 0,
    secrets: 0,
    endpoints: 0,
    persistentVolumeClaims: 0,
    serviceAccounts: 0,
    events: 0,
  },
  pods: {
    read: {
      running: 1,
      pending: 0,
      succeeded: 0,
      failed: 0,
      unknown: 0,
      crashLooping: 0,
      notReady: 0,
      ready: 1,
      stuck: [],
      starting: 0,
    },
    complete: true,
  },
  jobs: null,
  deployments: null,
  metricsAvailable: false,
  unread: [],
};

describe("what the overview offers Share", () => {
  /** One section per panel, deleting a hook makes its panel's evidence
   *  vanish from a report that otherwise looked complete. */
  it("collects a section from every panel once the overview has loaded", async () => {
    useClusterStore.setState({
      isConnected: true,
      currentContext: "prod",
      namespaceScope: [],
    });
    getClusterOverview.mockResolvedValue(FULL_OVERVIEW);

    let collect: ReturnType<typeof useScreenSections> = null;
    function Probe() {
      collect = useScreenSections();
      return null;
    }
    await mount(
      <ScreenShareProvider>
        <ClusterOverview />
        <Probe />
      </ScreenShareProvider>
    );

    await waitFor(() =>
      expect(
        collect?.().some((section) => section.id === "overview-problems")
      ).toBe(true)
    );
    const ids = collect!().map((section) => section.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "overview-problems",
        "overview-workloads",
        "overview-scheduler",
        "overview-nodes",
        "overview-warnings",
      ])
    );
  });
});
