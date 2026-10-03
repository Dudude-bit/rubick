import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const getClusterOverview = vi.fn();
vi.mock("@/lib/commands", () => ({
  commands: {
    getClusterOverview: (scope: string[] | null) => getClusterOverview(scope),
  },
}));

import { useClusterStore } from "@/stores/clusterStore";
import { useClusterOverview, useScopedOverview } from "./useClusterOverview";

const overview = (pods: number) => ({ counts: { pods } }) as never;

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
  useClusterStore.setState({
    isConnected: false,
    currentContext: null,
    namespaceScope: [],
  });
});

/**
 * The rail states counts beside the name of the cluster the window is on.
 * `keepPreviousData` answers a brand-new key with the last one's answer, and
 * a context switch is a brand-new key — so one cluster's totals were drawn
 * under another cluster's name, including on a cluster that refuses to list
 * the things being counted.
 */
describe("useClusterOverview", () => {
  it("holds no counts for a cluster it has not read yet", async () => {
    getClusterOverview.mockResolvedValueOnce(overview(51));
    const { result } = renderHook(() => useClusterOverview([]), { wrapper });
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
      ({ scope }: { scope: string[] }) => useClusterOverview(scope),
      { wrapper, initialProps: { scope: [] as string[] } }
    );
    await waitFor(() => expect(result.current.data).toBeDefined());

    getClusterOverview.mockImplementationOnce(
      () => new Promise(() => undefined)
    );
    rerender({ scope: ["shop"] });

    await waitFor(() => expect(getClusterOverview).toHaveBeenCalledTimes(2));
    expect(result.current.data).toEqual(overview(51));
  });

  /**
   * Would put the last selection's totals under a label naming several
   * namespaces. The skeleton is one read away; a number beside the wrong
   * label is not a placeholder.
   */
  it("holds no counts while a new set of namespaces is read", async () => {
    getClusterOverview.mockResolvedValueOnce(overview(51));
    const { result, rerender } = renderHook(
      ({ scope }: { scope: string[] }) => useClusterOverview(scope),
      { wrapper, initialProps: { scope: [] as string[] } }
    );
    await waitFor(() => expect(result.current.data).toBeDefined());

    getClusterOverview.mockImplementationOnce(
      () => new Promise(() => undefined)
    );
    rerender({ scope: ["prod", "staging"] });

    await waitFor(() => expect(getClusterOverview).toHaveBeenCalledTimes(2));
    expect(result.current.data).toBeUndefined();
  });

  /**
   * The backend refuses an empty list rather than read it as the whole
   * cluster, so "every namespace" has to go over the wire as `null`.
   */
  it("asks for the whole cluster as null", async () => {
    getClusterOverview.mockResolvedValueOnce(overview(51));
    renderHook(() => useClusterOverview([]), { wrapper });
    await waitFor(() => expect(getClusterOverview).toHaveBeenCalledWith(null));
  });
});

describe("useScopedOverview", () => {
  /**
   * The point of moving the join to Rust. Asked once per namespace, every
   * part re-read the cluster's nodes and — when listing — its every pod, so
   * four namespaces were five whole-cluster pod lists a poll.
   */
  it("asks once for a window on several namespaces, naming every one", async () => {
    useClusterStore.setState({ namespaceScope: ["prod", "staging"] });
    getClusterOverview.mockResolvedValue(overview(11));

    const { result } = renderHook(() => useScopedOverview(), { wrapper });

    await waitFor(() => expect(result.current.data).toEqual(overview(11)));
    expect(getClusterOverview).toHaveBeenCalledTimes(1);
    expect(getClusterOverview).toHaveBeenCalledWith(["prod", "staging"]);
  });
});
