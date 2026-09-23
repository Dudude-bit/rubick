import { describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { NodeInfo } from "@/generated/types";
import { queryKeys } from "@/lib/query-keys";
import { ResourceType } from "@/lib/resource-registry";

const store = vi.hoisted(() => ({ state: { isConnected: true } }));
vi.mock("@/stores/clusterStore", () => ({
  useClusterStore: vi.fn(<T,>(selector?: (s: typeof store.state) => T) =>
    typeof selector === "function" ? selector(store.state) : store.state
  ),
}));

const node = { name: "node-a" } as NodeInfo;
vi.mock("@/lib/commands", () => ({
  commands: {
    listNodes: vi.fn(async () => [node]),
    subscribeNodeWatch: vi.fn(async () => "rw-1"),
    resourceWatchSubscribed: vi.fn(async () => undefined),
    unsubscribeResourceWatch: vi.fn(async () => undefined),
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@/hooks/useMetrics", () => ({
  useMetrics: () => ({ nodeMetrics: [], nodeStatus: null }),
}));
vi.mock("@/hooks/useNodeActions", () => ({
  useNodeActions: () => ({ dialogs: null }),
}));

const drawn = vi.hoisted(() => ({ nodes: [] as unknown[] }));
vi.mock("@/components/resources/NodeUtilisation", () => ({
  NodeUtilisation: ({ nodes }: { nodes: unknown[] }) => {
    drawn.nodes = nodes;
    return null;
  },
}));

import { NodeList } from "./NodeList";

describe("NodeList", () => {
  /**
   * The Utilisation view reads the key the table and the node watch write,
   * and they write `{rows, unread}`. Reading that entry as an array threw
   * `nodes.map is not a function` on the first switch to the view.
   */
  it("draws the utilisation view from the rows the table's entry holds", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(queryKeys.resources(ResourceType.Node, null), {
      rows: [node],
      unread: [],
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/nodes?view=utilisation"]}>
          <NodeList />
        </MemoryRouter>
      </QueryClientProvider>
    );
    await waitFor(() => expect(drawn.nodes).toEqual([node]));
  });

  /**
   * The other direction: a list the Utilisation view fetched itself lands in
   * the table's entry, and an array there reads as "no Nodes" to the table.
   */
  it("writes the table's shape when the utilisation view reads the list itself", async () => {
    drawn.nodes = [];
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/nodes?view=utilisation"]}>
          <NodeList />
        </MemoryRouter>
      </QueryClientProvider>
    );
    await waitFor(() => expect(drawn.nodes).toEqual([node]));
    expect(
      client.getQueryData(queryKeys.resources(ResourceType.Node, null))
    ).toEqual({ rows: [node], unread: [] });
  });
});
