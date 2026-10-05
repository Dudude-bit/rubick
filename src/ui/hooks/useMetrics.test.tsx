import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/commands", () => ({
  commands: {
    getPodsMetrics: vi.fn(async () => ({ status: null, data: [] })),
    getPodsMetricsIn: vi.fn(async () => ({ status: null, data: [] })),
    getNodesMetrics: vi.fn(async () => ({ status: null, data: [] })),
  },
}));

import { commands } from "@/lib/commands";
import { REFRESH_INTERVALS } from "@/lib/refresh";
import { useMetrics } from "./useMetrics";

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>
    {children}
  </QueryClientProvider>
);

describe("pod metrics for a selection", () => {
  /**
   * A selection is read per namespace in the backend. Sending it as one
   * cluster-wide read is what a namespace-scoped token is refused.
   */
  it("asks for the selection's namespaces, not the whole cluster", async () => {
    renderHook(
      () => useMetrics({ scope: ["team-a", "team-b"], includeNodes: false }),
      { wrapper }
    );
    await waitFor(() =>
      expect(commands.getPodsMetricsIn).toHaveBeenCalledWith([
        "team-a",
        "team-b",
      ])
    );
    expect(commands.getPodsMetrics).not.toHaveBeenCalled();
  });

  /** Dropped here, a namespace refused beside one that answered reaches the
   *  pages as an "available" status with no word about it. */
  it("hands on the namespaces whose metrics were not read", async () => {
    const staging = {
      namespace: "staging",
      code: "PERMISSION_DENIED",
      message: "forbidden",
    };
    vi.mocked(commands.getPodsMetricsIn).mockResolvedValueOnce({
      status: { status: "available", message: null },
      data: [],
      unread: [staging],
    });
    const { result } = renderHook(
      () => useMetrics({ scope: ["prod", "staging"], includeNodes: false }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.podUnread).toEqual([staging]));
  });
});

describe("how often an unserved metrics API is asked", () => {
  const answer = (status: "notInstalled" | "forbidden" | "error") => ({
    status: { status, message: "404 page not found" },
    data: [],
    unread: [],
  });

  /**
   * 460 WARN lines in fifteen minutes: the 404 was asked for every two
   * seconds. Fails if a missing metrics-server stays on the two-second rate.
   */
  it.each(["notInstalled", "forbidden"] as const)(
    "asks again only every few minutes once it is %s",
    async (status) => {
      vi.mocked(commands.getPodsMetrics).mockResolvedValue(answer(status));
      const { result } = renderHook(() => useMetrics({ includeNodes: false }), {
        wrapper,
      });
      await waitFor(() =>
        expect(result.current.podMetricsQuery.freshness.everyMs).toBe(
          REFRESH_INTERVALS.unserved
        )
      );
    }
  );

  /** A failing API may come back on its own, so it keeps the usual rate. */
  it("keeps asking a failing API at the usual rate", async () => {
    vi.mocked(commands.getPodsMetrics).mockResolvedValue(answer("error"));
    const { result } = renderHook(() => useMetrics({ includeNodes: false }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.podStatus?.status).toBe("error"));
    expect(result.current.podMetricsQuery.freshness.everyMs).not.toBe(
      REFRESH_INTERVALS.unserved
    );
  });
});
