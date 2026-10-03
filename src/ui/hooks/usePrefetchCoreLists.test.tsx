import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/commands", () => ({
  commands: {
    listDeploymentsIn: vi.fn(async () => ({ rows: [], unread: [] })),
    listServicesIn: vi.fn(async () => ({ rows: [], unread: [] })),
    // The overview prefetch was added without its mock, so the hook's most
    // expensive warm-up threw into a swallowed promise and every assertion
    // about it would have passed over a hook that fetched nothing.
    getClusterOverview: vi.fn(async () => ({ counts: { pods: 3 } })),
  },
}));
vi.mock("@/lib/pod-rows", () => ({
  listPodRows: vi.fn(async () => ({ rows: [], unread: [] })),
}));

import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";
import { ResourceType } from "@/lib/resource-registry";
import { useClusterStore } from "@/stores/clusterStore";
import { useClusterOverview } from "./useClusterOverview";
import { usePrefetchCoreLists } from "./usePrefetchCoreLists";

/** A list some page reads and the landing does not warm. */
const PARKED = queryKeys.resources(ResourceType.ConfigMap, null);

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
      namespaceScope: [],
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
    client.setQueryDefaults(PARKED, { gcTime: Infinity });
    client.setQueryData(PARKED, [{ name: "shop-db-1" }]);
    renderHook(() => usePrefetchCoreLists(), { wrapper });
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));

    act(() => useClusterStore.setState({ currentContext: "staging-eu" }));
    await waitFor(() => expect(client.getQueryData(PARKED)).toBeUndefined());
  });

  /**
   * The same cluster reconnecting is the case the flush exists for, and it
   * must stay a flush: dropping every answer there would send every open
   * screen back to its skeleton on a session that merely renewed.
   */
  it("keeps what it has when the landing is the same cluster again", async () => {
    renderHook(() => usePrefetchCoreLists(), { wrapper });
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));

    client.setQueryDefaults(PARKED, { gcTime: Infinity });
    client.setQueryData(PARKED, [{ name: "shop-db-1" }]);
    act(() => useClusterStore.setState({ isConnected: false }));
    act(() => useClusterStore.setState({ isConnected: true }));
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(2));
    expect(client.getQueryData(PARKED)).toEqual([{ name: "shop-db-1" }]);
  });

  it("does not flush again for a mere re-render of the same landing", async () => {
    const { rerender } = renderHook(() => usePrefetchCoreLists(), { wrapper });
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
    rerender();
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  /**
   * The claim the hook is for: it warms the exact keys those pages read.
   * Nothing asserted it — every prefetch could be deleted with all 3044
   * frontend tests green — so a key that drifts from `useClusterOverview`'s
   * or from `queryKeys` would warm an entry no screen ever reads, and the
   * landing would go back to spending its first second asking.
   */
  it("warms the keys the first screens read, not keys of its own", async () => {
    // Nothing observes a prefetched entry, and the harness collects those at
    // once — which would empty every key whatever the hook did.
    client.setDefaultOptions({ queries: { retry: false, gcTime: Infinity } });
    renderHook(() => usePrefetchCoreLists(), { wrapper });

    await waitFor(() => {
      expect(client.getQueryData(queryKeys.clusterOverview("prod-eu"))).toEqual(
        { counts: { pods: 3 } }
      );
    });
    const nothing = { rows: [], unread: [] };
    await waitFor(() => {
      expect(client.getQueryData(queryKeys.podRows(null))).toEqual(nothing);
    });
    expect(
      client.getQueryData(queryKeys.resources(ResourceType.Deployment, null))
    ).toEqual(nothing);
    expect(
      client.getQueryData(queryKeys.resources(ResourceType.Service, null))
    ).toEqual(nothing);
  });

  /**
   * Several namespaces have no wire value, and the store's `""` for them
   * warmed the whole cluster's lists: keys no page on that selection reads,
   * and lists a namespace-scoped token is refused.
   */
  it("warms the selection's own keys when several namespaces are selected", async () => {
    client.setDefaultOptions({ queries: { retry: false, gcTime: Infinity } });
    useClusterStore.setState({ namespaceScope: ["shop", "staging"] });
    renderHook(() => usePrefetchCoreLists(), { wrapper });

    await waitFor(() => {
      expect(
        client.getQueryData(queryKeys.podRows("shop,staging"))
      ).toBeDefined();
    });
    expect(commands.listDeploymentsIn).toHaveBeenCalledWith([
      "shop",
      "staging",
    ]);
    expect(
      client.getQueryData(queryKeys.resources(ResourceType.Service, null))
    ).toBeUndefined();
  });

  /**
   * The store says "every namespace" as `""` and the page asks with an empty
   * scope; the overview was keyed by hand on both sides. Fails if the prefetch and
   * `useClusterOverview` key one scope apart: the page asks again on mount
   * and the landing's most expensive request was spent for nothing.
   */
  it.each([
    ["every namespace", [], []],
    ["one namespace", ["shop"], ["shop"]],
    ["several namespaces", ["shop", "staging"], ["shop", "staging"]],
  ])(
    "opens the overview on the answer the landing asked for, for %s",
    async (_, storeSays, pageAsks) => {
      const getClusterOverview = vi.mocked(commands.getClusterOverview);
      getClusterOverview.mockClear();
      client.setDefaultOptions({ queries: { retry: false, gcTime: Infinity } });
      useClusterStore.setState({ namespaceScope: storeSays });
      renderHook(() => usePrefetchCoreLists(), { wrapper });
      await waitFor(() =>
        expect(
          client.getQueryData(queryKeys.clusterOverview("prod-eu", pageAsks))
        ).toBeDefined()
      );

      const { result } = renderHook(() => useClusterOverview(pageAsks), {
        wrapper,
      });
      await waitFor(() =>
        expect(result.current.data).toEqual({ counts: { pods: 3 } })
      );
      expect(getClusterOverview).toHaveBeenCalledTimes(1);
    }
  );
});
