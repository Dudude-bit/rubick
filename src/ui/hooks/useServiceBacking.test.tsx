import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { ServiceBacking } from "@/generated/types";

const listServiceBacking =
  vi.fn<(namespace: string | null) => Promise<ServiceBacking>>();

vi.mock("@/lib/commands", () => ({
  commands: {
    listServiceBacking: (namespace: string | null) =>
      listServiceBacking(namespace),
  },
}));

const { useServiceBacking } = await import("./useServiceBacking");

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

const WEB = {
  name: "web",
  namespace: "net",
  uid: "web",
  type: "ClusterIP",
  sessionAffinity: "None",
  clusterIp: "10.0.0.1",
  externalIps: [],
  loadBalancerIps: [],
  ports: [],
  selector: { app: "web" },
  labels: {},
  annotations: {},
  createdAt: null,
};

describe("what the Services of a scope publish", () => {
  /**
   * Two namespaces in scope, one refused: its rows must read as not
   * checked, never as Services with no endpoints. Fails if a refused
   * namespace is answered with an empty list.
   */
  it("keeps a refused namespace apart from one that has no Services", async () => {
    listServiceBacking.mockImplementation(async (namespace) => {
      if (namespace === "secret-ns") throw new Error("services is forbidden");
      return { services: namespace === "net" ? [WEB] : [], published: [] };
    });

    const { result } = renderHook(
      () => useServiceBacking(["net", "secret-ns", "empty"]),
      { wrapper: wrapper() }
    );

    await waitFor(() => expect(result.current.in("net").known).toBe(true));
    expect(result.current.in("secret-ns")).toEqual({
      known: false,
      why: "services is forbidden",
    });
    expect(result.current.in("empty")).toEqual({
      known: true,
      value: { services: [], published: [] },
    });
    expect(result.current.service("net", "web")?.name).toBe("web");
    expect(listServiceBacking).toHaveBeenCalledTimes(3);
  });
});
