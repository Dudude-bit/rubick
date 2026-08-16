import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/commands", () => ({
  commands: {
    listPods: vi.fn(async () => []),
    listDeployments: vi.fn(async () => []),
    listServices: vi.fn(async () => []),
  },
}));

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

  it("does not flush again for a mere re-render of the same landing", async () => {
    const { rerender } = renderHook(() => usePrefetchCoreLists(), { wrapper });
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
    rerender();
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});
