/**
 * A workload list reads its own rows and hands them to `ResourceList`, so
 * whatever `ResourceList` does for the lists it reads itself has to be done
 * here too: nothing of it reaches rows that come from outside.
 */

import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { act, screen } from "@testing-library/react";
import type { ComponentType } from "react";
import { QueryClient } from "@tanstack/react-query";

import type { Scoped, UnreadNamespace } from "@/generated/types";

const store = vi.hoisted(() => ({
  state: {
    currentNamespace: "default",
    namespaceScope: [] as string[],
    isConnected: true,
    contexts: [],
  },
}));

vi.mock("@/stores/clusterStore", () => ({
  useClusterStore: vi.fn(<T,>(selector?: (s: typeof store.state) => T) =>
    typeof selector === "function" ? selector(store.state) : store.state
  ),
}));

const podRead = vi.hoisted(() => ({
  data: [] as unknown[],
  read: false,
  unread: [] as unknown[],
}));
vi.mock("@/hooks/usePodsWithMetrics", () => ({
  usePodsWithMetrics: () => ({
    ...podRead,
    podStatus: null,
    podUnread: [],
    refetchPodMetrics: vi.fn(),
  }),
}));

const watch = vi.hoisted(() => ({ live: true }));
vi.mock("@/hooks/useWatchedList", () => ({
  useWatchedList: () => ({
    live: watch.live,
    refresh: false,
    resyncing: false,
  }),
}));

import { renderWithRouter } from "@/test/render";
import { matchDeploymentPods } from "@/lib/metrics";
import { queryKeys } from "@/lib/query-keys";
import { ResourceType } from "@/lib/resource-registry";
import { createWorkloadListPage } from "./createWorkloadListPage";
import { RowCauseText } from "./RowCauseText";

interface Item {
  name: string;
  namespace: string;
}

const deadline: UnreadNamespace = {
  namespace: "staging",
  code: "READ_DEADLINE",
  message: "the read ran out of time",
};

function page(fetchList: () => Promise<Scoped<Item>>) {
  return createWorkloadListPage<Item>({
    resourceType: ResourceType.Deployment,
    title: "Deployments",
    fetchList,
    matchPods: matchDeploymentPods,
    deleter: async () => undefined,
    columns: () => [{ accessorKey: "name", header: "Name" }],
    watch: async () => "watch-1",
  });
}

async function mount(client: QueryClient, List: ComponentType) {
  const { rerender } = await renderWithRouter(<List />, {
    client,
    at: "/c/prod/deployments",
    route: "/c/$cluster/deployments",
  });
  return () => rerender(<List />);
}

beforeEach(() => {
  watch.live = true;
  podRead.data = [];
  podRead.read = false;
  podRead.unread = [];
  store.state.namespaceScope = ["prod", "staging"];
});

describe("a workload list under a live watch", () => {
  /**
   * The re-read timed out in staging, which the watch still streams. The
   * list dropped staging's rows and called it unread, and the watch went on
   * sending changes to rows the page no longer had.
   */
  it("keeps a watched namespace's rows when a re-read misses it", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const key = queryKeys.resources(ResourceType.Deployment, "prod,staging");
    client.setQueryData<Scoped<Item>>(key, {
      rows: [
        { name: "api", namespace: "prod" },
        { name: "worker", namespace: "staging" },
      ],
      unread: [],
    });
    const List = page(async () => ({
      rows: [
        { name: "api", namespace: "prod" },
        { name: "api-2", namespace: "prod" },
      ],
      unread: [deadline],
    }));
    await mount(client, List);
    expect(await screen.findByText("worker")).toBeVisible();

    await act(() => client.invalidateQueries({ queryKey: key }));
    expect(await screen.findByText("api-2")).toBeVisible();
    expect(screen.getByText("worker")).toBeVisible();
  });
});

describe("a workload list while a new scope is read", () => {
  /**
   * The last scope's answer stands in for the new one. Its rows were counted
   * as the new scope's total, and its unread namespace was named under a
   * selection that did not contain it.
   */
  it("neither totals the last scope's rows nor names its unread namespaces", async () => {
    watch.live = false;
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let answer = async (): Promise<Scoped<Item>> => ({
      rows: [{ name: "api", namespace: "prod" }],
      unread: [{ ...deadline, code: "FORBIDDEN" }],
    });
    const List = page(() => answer());
    const rerender = await mount(client, List);
    expect(await screen.findByText(/in staging/)).toBeVisible();

    store.state.namespaceScope = ["prod", "dev"];
    answer = () => new Promise(() => {});
    await rerender();

    expect(screen.getByText("api")).toBeVisible();
    expect(screen.queryByText(/in staging/)).toBeNull();
    expect(screen.queryByText("1 Deployment")).toBeNull();
    expect(
      screen.getByText("1 Deployment, from the namespaces that answered")
    ).toBeVisible();
  });
});

describe("the cause a workload list's row tells", () => {
  /**
   * The Deployments list said "Stalled" while the Overview and the page
   * said why. Fails if a row does not tell the cause its own pods share, or
   * a row whose namespace's pods were refused says nothing, which reads
   * exactly like pods with nothing wrong.
   */
  it("tells each row the cause its own pods share, and where they were not read", async () => {
    watch.live = false;
    podRead.read = true;
    podRead.unread = [{ ...deadline, code: "FORBIDDEN" }];
    podRead.data = [
      {
        name: "api-5d4c-x9",
        namespace: "prod",
        labels: {},
        workload: { kind: "Deployment", name: "api" },
        status: {
          phase: "Running",
          display: "CrashLoopBackOff",
          cause: {
            says: "exits",
            container: "app",
            restarts: 7,
            run: null,
            until: null,
          },
        },
        containers: [
          {
            name: "app",
            ready: false,
            started: false,
            phase: "app",
            state: {
              type: "waiting",
              reason: "CrashLoopBackOff",
              message: null,
            },
          },
        ],
        initContainers: [],
      },
    ];
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const List = createWorkloadListPage<Item>({
      resourceType: ResourceType.Deployment,
      title: "Deployments",
      fetchList: async () => ({
        rows: [
          { name: "api", namespace: "prod" },
          { name: "worker", namespace: "staging" },
        ],
        unread: [],
      }),
      matchPods: matchDeploymentPods,
      deleter: async () => undefined,
      columns: () => [
        { accessorKey: "name", header: "Name" },
        {
          id: "cause",
          header: "Cause",
          cell: ({ row }) => (
            <RowCauseText cause={row.original.podsCause} verdict="trouble" />
          ),
        },
      ],
    });
    await mount(client, List);
    expect(await screen.findByTestId("row-cause")).toHaveTextContent(
      /^1 of 1 pod: app/
    );
    expect(
      screen.getByText("pods not read, so why is not known")
    ).toBeVisible();
  });
});
