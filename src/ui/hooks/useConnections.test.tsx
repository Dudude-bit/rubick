import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";

const getResourceConnections = vi.hoisted(() => vi.fn());
const detectGatewayApi = vi.hoisted(() => vi.fn());
vi.mock("@/lib/commands", () => ({
  commands: { getResourceConnections, detectGatewayApi },
}));

import type {
  GatewayApiDetection,
  ResourceConnections,
} from "@/generated/types";
import { useClusterStore } from "@/stores/clusterStore";
import { testQueryClient } from "@/test/render";
import { useConnections } from "./useConnections";

const answer = (name: string): ResourceConnections => ({
  subject: {
    kind: "Deployment",
    name,
    namespace: "shop",
    existence: "present",
    facts: null,
  },
  edges: [],
  stops: [],
  published: [],
  notLookedAt: [],
});

const scan = (installed: boolean): GatewayApiDetection => ({
  installed,
  bundleVersion: null,
  channel: null,
  mixedBundle: false,
  kinds: installed
    ? [
        {
          kind: "HTTPRoute",
          plural: "httproutes",
          versions: ["v1"],
          readVersion: "v1",
        },
      ]
    : [],
});

let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);

beforeEach(() => {
  client = testQueryClient();
  getResourceConnections.mockReset();
  detectGatewayApi.mockReset().mockResolvedValue(scan(false));
  useClusterStore.setState({ isConnected: true, currentContext: "prod" });
});

describe("a neighbourhood asked again under a new key", () => {
  /** Without the old answer the chain blanked when the Gateway API scan landed. */
  it("keeps the same object's answer while the scan's read is in flight", async () => {
    getResourceConnections
      .mockResolvedValueOnce(answer("web"))
      .mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(
      () => useConnections("Deployment", "web", "shop"),
      { wrapper }
    );
    await waitFor(() => expect(result.current.data).toEqual(answer("web")));
    act(() => client.setQueryData(["gateway-api", "prod"], scan(true)));
    await waitFor(() =>
      expect(getResourceConnections).toHaveBeenCalledTimes(2)
    );
    expect(result.current.data).toEqual(answer("web"));
  });

  /** One row menu's observer drew cart's autoscaler in search's Scale dialog. */
  it("never answers for another object with the last one's neighbourhood", async () => {
    getResourceConnections
      .mockResolvedValueOnce(answer("cart"))
      .mockReturnValue(new Promise(() => {}));
    const { result, rerender } = renderHook(
      ({ name }) => useConnections("Deployment", name, "shop"),
      { wrapper, initialProps: { name: "cart" } }
    );
    await waitFor(() => expect(result.current.data).toEqual(answer("cart")));
    rerender({ name: "search" });
    await waitFor(() =>
      expect(getResourceConnections).toHaveBeenCalledTimes(2)
    );
    expect(result.current.data).toBeUndefined();
  });
});
