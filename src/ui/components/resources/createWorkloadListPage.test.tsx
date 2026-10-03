/**
 * A workload list reads its own rows and hands them to `ResourceList`, so
 * whatever `ResourceList` does for the lists it reads itself has to be done
 * here too: nothing of it reaches rows that come from outside.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { Scoped, UnreadNamespace } from "@/generated/types";

const store = vi.hoisted(() => ({
  state: {
    currentNamespace: "default",
    namespaceScope: [] as string[],
    isConnected: true,
  },
}));

vi.mock("@/stores/clusterStore", () => ({
  useClusterStore: vi.fn(<T,>(selector?: (s: typeof store.state) => T) =>
    typeof selector === "function" ? selector(store.state) : store.state
  ),
}));

vi.mock("@/hooks/usePodsWithMetrics", () => ({
  usePodsWithMetrics: () => ({
    data: [],
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

import { TooltipProvider } from "@/components/ui/tooltip";
import { matchDeploymentPods } from "@/lib/metrics";
import { queryKeys } from "@/lib/query-keys";
import { ResourceType } from "@/lib/resource-registry";
import { createWorkloadListPage } from "./createWorkloadListPage";

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

function mount(client: QueryClient, ui: React.ReactNode) {
  const tree = (node: React.ReactNode) => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/workloads/deployments"]}>
        <TooltipProvider>{node}</TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const { rerender } = render(tree(ui));
  return (next: React.ReactNode) => rerender(tree(next));
}

beforeEach(() => {
  watch.live = true;
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
    mount(client, <List />);
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
    const rerender = mount(client, <List />);
    expect(await screen.findByText(/in staging/)).toBeVisible();

    store.state.namespaceScope = ["prod", "dev"];
    answer = () => new Promise(() => {});
    rerender(<List />);

    expect(screen.getByText("api")).toBeVisible();
    expect(screen.queryByText(/in staging/)).toBeNull();
    expect(screen.queryByText("1 deployment")).toBeNull();
    expect(
      screen.getByText("1 deployment, from the namespaces that answered")
    ).toBeVisible();
  });
});
