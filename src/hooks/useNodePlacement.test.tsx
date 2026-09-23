import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/commands", () => ({
  commands: { getNode: vi.fn(async () => ({ labels: {} })) },
}));

import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";
import { useNodePlacement } from "./useNodePlacement";

/**
 * Five pods on one node are one `get_node`, and a pod opened from its node's
 * page is none: the placement reads the entry the Node page fills. Fails if
 * the two key the node apart and every pod page asks again.
 */
describe("a pod's placement", () => {
  it("reads the node the Node page already holds", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(queryKeys.detail("Node", undefined, "node-a"), {
      name: "node-a",
      labels: { "topology.kubernetes.io/zone": "eu-west-1a" },
      providerId: null,
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useNodePlacement("node-a"), {
      wrapper,
    });

    await waitFor(() => expect(result.current?.zone).toBe("eu-west-1a"));
    expect(commands.getNode).not.toHaveBeenCalled();
  });
});
