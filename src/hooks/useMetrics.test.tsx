import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
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
});
