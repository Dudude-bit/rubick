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

const WEB_PUBLISHED = {
  service: {
    kind: "Service",
    name: "web",
    namespace: "net",
    existence: "present",
    facts: null,
  },
  source: "slices",
  slices: 1,
  ready: 2,
  draining: 0,
  notReady: 0,
  unrouted: 0,
  unroutedReady: 0,
  ports: [],
  endpoints: [],
  whole: true,
  unpublished: [],
  stop: null,
} satisfies ServiceBacking["published"][number];

describe("what the Services of a scope publish", () => {
  /**
   * Two namespaces in scope, one refused: its rows must read as not
   * checked, never as Services with no endpoints. Fails if a refused
   * namespace is answered with an empty list.
   */
  it("keeps a refused namespace apart from one that has no Services", async () => {
    listServiceBacking.mockImplementation(async (namespace) => {
      if (namespace === "secret-ns") throw new Error("services is forbidden");
      return {
        services: [],
        published: namespace === "net" ? [WEB_PUBLISHED] : [],
        readAt: new Date().toISOString(),
      };
    });

    const { result } = renderHook(
      () => useServiceBacking(["net", "secret-ns", "empty"]),
      { wrapper: wrapper() }
    );

    await waitFor(() =>
      expect(result.current.published("net", "web")?.ready).toBe(2)
    );
    expect(result.current.why("secret-ns")).toBe("services is forbidden");
    expect(result.current.why("empty")).toBeNull();
    expect(result.current.why("net")).toBeNull();
    expect(listServiceBacking).toHaveBeenCalledTimes(3);
  });
});
