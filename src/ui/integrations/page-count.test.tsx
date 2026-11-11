import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const ran = vi.hoisted(() => ({ selects: 0, joins: 0 }));

vi.mock("./cilium/data", async (original) => {
  const real = await original<typeof import("./cilium/data")>();
  return {
    ...real,
    countUnrestricted: (
      picture: Parameters<typeof real.countUnrestricted>[0]
    ) => {
      ran.selects += 1;
      return real.countUnrestricted(picture);
    },
  };
});

vi.mock("./cilium/coverage", async (original) => {
  const real = await original<typeof import("./cilium/coverage")>();
  return {
    ...real,
    coverageOf: (...args: Parameters<typeof real.coverageOf>) => {
      ran.joins += 1;
      return real.coverageOf(...args);
    },
  };
});

vi.mock("@/lib/commands", () => ({
  commands: {
    detectInClusterExtensions: vi.fn(async () => [
      { id: "cilium", installed: true, version: "1.20.1" },
    ]),
    getPrometheusConnection: vi.fn(async () => null),
    getLokiConnection: vi.fn(async () => null),
    checkListAccess: vi.fn(async () => []),
    listNetworkPoliciesIn: vi.fn(async () => ({ rows: [], unread: [] })),
    listCustomResources: vi.fn(async (crd: string) =>
      crd.startsWith("ciliumendpoints.")
        ? [
            {
              name: "api",
              namespace: "shop",
              kind: "CiliumEndpoint",
              spec: null,
              status: { identity: { id: 1, labels: ["k8s:app=api"] } },
            },
          ]
        : []
    ),
  },
}));

import { useClusterStore } from "@/stores/clusterStore";
import { useIntegrationPages } from "./index";

describe("the number beside a vendor's row", () => {
  let client: QueryClient;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );

  beforeEach(() => {
    ran.selects = 0;
    ran.joins = 0;
    client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    useClusterStore.setState({ currentContext: "prod-eu", isConnected: true });
  });

  async function settled() {
    const hook = renderHook(() => useIntegrationPages(), { wrapper });
    await waitFor(() =>
      expect(
        hook.result.current.pages.find((page) => page.id === "cilium")?.count
      ).toBe(1)
    );
    return hook;
  }

  /**
   * The `select` was an arrow made per render, and React Query runs a new
   * function again: every sidebar render re-read every vendor's payload,
   * which for Cilium is the endpoint × policy join, over 100 ms at 5000 pods.
   * Fails if the select stops being the same function between renders.
   */
  it("is not worked out again when the sidebar only renders again", async () => {
    const { rerender } = await settled();
    const before = { ...ran };
    for (let at = 0; at < 5; at += 1) rerender();
    expect(ran).toEqual(before);
  });

  /**
   * The count and its dot each ran the whole join for themselves. Fails if
   * one picture is joined more than once.
   */
  it("joins Cilium's endpoints and policies once for the number and its dot", async () => {
    await settled();
    expect(ran.joins).toBe(1);
  });
});
