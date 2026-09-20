import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const getClusterOverview = vi.fn();
vi.mock("@/lib/commands", () => ({
  commands: {
    getClusterOverview: (namespace: string | null) =>
      getClusterOverview(namespace),
  },
}));

import { useClusterStore } from "@/stores/clusterStore";
import { useClusterOverview } from "./useClusterOverview";

const overview = (pods: number) => ({ counts: { pods } }) as never;

/**
 * The rail states counts beside the name of the cluster the window is on.
 * `keepPreviousData` answers a brand-new key with the last one's answer, and
 * a context switch is a brand-new key — so one cluster's totals were drawn
 * under another cluster's name, including on a cluster that refuses to list
 * the things being counted.
 */
describe("useClusterOverview", () => {
  let client: QueryClient;

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );

  beforeEach(() => {
    getClusterOverview.mockReset();
    client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    useClusterStore.setState({
      currentContext: "prod-eu",
      isConnected: true,
    });
  });

  afterEach(() => {
    useClusterStore.setState({ isConnected: false, currentContext: null });
  });

  it("holds no counts for a cluster it has not read yet", async () => {
    getClusterOverview.mockResolvedValueOnce(overview(51));
    const { result } = renderHook(() => useClusterOverview(null), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());

    // The second cluster is slow, or refuses: either way nothing has come
    // back from it, and the rail must not fill the gap with the first one.
    getClusterOverview.mockImplementationOnce(
      () => new Promise(() => undefined)
    );
    act(() => useClusterStore.setState({ currentContext: "staging-eu" }));

    await waitFor(() => expect(getClusterOverview).toHaveBeenCalledTimes(2));
    expect(result.current.data).toBeUndefined();
  });

  it("keeps the counts it has while the same cluster is asked a narrower question", async () => {
    getClusterOverview.mockResolvedValueOnce(overview(51));
    const { result, rerender } = renderHook(
      ({ ns }: { ns: string | null }) => useClusterOverview(ns),
      { wrapper, initialProps: { ns: null as string | null } }
    );
    await waitFor(() => expect(result.current.data).toBeDefined());

    getClusterOverview.mockImplementationOnce(
      () => new Promise(() => undefined)
    );
    rerender({ ns: "shop" });

    await waitFor(() => expect(getClusterOverview).toHaveBeenCalledTimes(2));
    expect(result.current.data).toEqual(overview(51));
  });
});
