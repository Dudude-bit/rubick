import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/commands", () => ({
  commands: {
    listDeployments: vi.fn(async () => []),
    listServices: vi.fn(async () => []),
  },
}));
vi.mock("@/lib/pod-rows", () => ({
  listPodRows: vi.fn(async () => []),
}));

import { queryKeys } from "@/lib/query-keys";
import { useClusterStore } from "@/stores/clusterStore";
import { usePrefetchCoreLists } from "./usePrefetchCoreLists";

/**
 * The warm-up is also the flush: a connection landing is the one moment
 * every cached answer is stale, because everything asked before it stood
 * was answered by nothing. That must hold for EVERY landing — the session
 * that expired and reconnected re-lands on the same cluster and scope, and
 * keying the flush "once per scope" left the disconnect window's failures
 * (a probe told "No cluster is connected", a list told "Client not found")
 * on screen over a healthy session.
 */
describe("usePrefetchCoreLists", () => {
  let client: QueryClient;
  let invalidate: ReturnType<typeof vi.spyOn>;

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );

  beforeEach(() => {
    client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    invalidate = vi.spyOn(client, "invalidateQueries");
    useClusterStore.setState({
      currentContext: "prod-eu",
      currentNamespace: "",
      isConnected: true,
    });
  });

  afterEach(() => {
    useClusterStore.setState({ isConnected: false, currentContext: null });
  });

  it("flushes the cache once per landing, not once per scope", async () => {
    renderHook(() => usePrefetchCoreLists(), { wrapper });
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));

    // The session ends and the same cluster reconnects — same context, same
    // scope, new landing. Everything asked in between was asked of nothing.
    act(() => useClusterStore.setState({ isConnected: false }));
    act(() => useClusterStore.setState({ isConnected: true }));
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(2));
  });

  /**
   * A resource key carries no context, so an invalidation leaves the cluster
   * the reader just left on screen until the refetch answers — and where the
   * new cluster refuses the read, it never answers and those rows stay. The
   * pods of one cluster were drawn under another cluster's name, ages
   * ticking, for as long as the window was open.
   */
  it("drops the answers of the cluster left behind, rather than marking them stale", async () => {
    // Nothing observes this entry, and the harness collects those at once —
    // which would empty it whatever the hook did, and the assertion would
    // hold over the bug it is written to catch.
    client.setQueryDefaults(queryKeys.pods(null), { gcTime: Infinity });
    client.setQueryData(queryKeys.pods(null), [{ name: "shop-db-1" }]);
    renderHook(() => usePrefetchCoreLists(), { wrapper });
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));

    act(() => useClusterStore.setState({ currentContext: "staging-eu" }));
    await waitFor(() =>
      expect(client.getQueryData(queryKeys.pods(null))).toBeUndefined()
    );
  });

  /**
   * The same cluster reconnecting is the case the flush exists for, and it
   * must stay a flush: dropping every answer there would send every open
   * screen back to its skeleton on a session that merely renewed.
   */
  it("keeps what it has when the landing is the same cluster again", async () => {
    renderHook(() => usePrefetchCoreLists(), { wrapper });
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));

    client.setQueryDefaults(queryKeys.pods(null), { gcTime: Infinity });
    client.setQueryData(queryKeys.pods(null), [{ name: "shop-db-1" }]);
    act(() => useClusterStore.setState({ isConnected: false }));
    act(() => useClusterStore.setState({ isConnected: true }));
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(2));
    expect(client.getQueryData(queryKeys.pods(null))).toEqual([
      { name: "shop-db-1" },
    ]);
  });

  it("does not flush again for a mere re-render of the same landing", async () => {
    const { rerender } = renderHook(() => usePrefetchCoreLists(), { wrapper });
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
    rerender();
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});
