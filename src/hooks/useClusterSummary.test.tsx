/**
 * The chrome's counts come from the cluster-wide overview, which a token
 * without cluster read rights is refused. A refusal must leave the counts
 * unknown (`null`), never fold to `0` — the status bar and the namespace
 * picker draw "—" from that null, so a scoped user is never told their
 * cluster is empty and healthy while the Overview page says "no access".
 */

import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/commands", () => ({
  commands: {
    getClusterOverview: vi.fn(),
    listNamespaces: vi.fn(),
  },
}));

import { commands } from "@/lib/commands";
import { useClusterStore } from "@/stores/clusterStore";
import { useClusterSummary } from "./useClusterSummary";

const getClusterOverview = vi.mocked(commands.getClusterOverview);
const listNamespaces = vi.mocked(commands.listNamespaces);

let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  getClusterOverview.mockReset();
  listNamespaces.mockReset();
  useClusterStore.setState({ isConnected: true, currentContext: "prod" });
});

describe("cluster summary counts when the overview is refused", () => {
  it("leaves the counts unknown, keeping the namespace names it can still read", async () => {
    getClusterOverview.mockRejectedValue("pods is forbidden (code: 403)");
    // listNamespaces is a separate read and can still succeed.
    listNamespaces.mockResolvedValue([
      { name: "team-a" },
      { name: "team-b" },
    ] as never);

    const { result } = renderHook(() => useClusterSummary(), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.podCount).toBeNull();
    expect(result.current.problemCount).toBeNull();
    expect(result.current.namespaces.map((n) => n.name).sort()).toEqual([
      "team-a",
      "team-b",
    ]);
    // The names are known; the counts inside them are not — never 0.
    for (const ns of result.current.namespaces) {
      expect(ns.podCount).toBeNull();
      expect(ns.problemCount).toBeNull();
    }
  });

  it("reports the real counts when the overview answers", async () => {
    getClusterOverview.mockResolvedValue({
      namespaces: [{ name: "team-a", podCount: 3 }],
      problems: [{ namespace: "team-a" }],
      problemsTruncated: 0,
      counts: { pods: 3 },
    } as never);
    listNamespaces.mockResolvedValue([{ name: "team-a" }] as never);

    const { result } = renderHook(() => useClusterSummary(), { wrapper });

    await waitFor(() => expect(result.current.podCount).toBe(3));
    expect(result.current.namespaces[0].podCount).toBe(3);
    expect(result.current.namespaces[0].problemCount).toBe(1);
  });
});
