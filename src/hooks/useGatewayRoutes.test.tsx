import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/hooks/useGatewayApi", () => ({
  useGatewayApi: () => ({
    data: {
      installed: true,
      kinds: [{ kind: "HTTPRoute" }, { kind: "TCPRoute" }],
    },
    isLoading: false,
    error: null,
  }),
}));
const watch = vi.hoisted(() => ({ live: false }));
vi.mock("@/hooks/useWatchedList", () => ({
  useWatchedList: () => ({
    live: watch.live,
    refresh: "resourceList",
    resyncing: false,
    watchFailed: false,
  }),
}));
const route = { name: "web", namespace: "team-a" };
vi.mock("@/lib/commands", () => ({
  commands: {
    listGatewayRoutesIn: vi.fn(async (kind: string) => {
      if (kind === "TCPRoute") throw new Error("tcproutes is forbidden");
      return { rows: [route], unread: [] };
    }),
  },
}));

import { useGatewayRoutes } from "./useGatewayRoutes";

describe("every route in scope, one query per served kind", () => {
  /**
   * A kind that failed whole joined as `whole([])`: no rows and no unread,
   * so the page counted a kind it could not read as one with no routes.
   */
  it("carries a kind that could not be read instead of reading it as empty", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(() => useGatewayRoutes(["team-a"]), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });

    await waitFor(() => expect(result.current.refusedKinds).toHaveLength(1));
    expect(result.current.refusedKinds[0].kind).toBe("TCPRoute");
    expect(result.current.routes).toEqual([route]);
    expect(result.current.error).toBeNull();
  });

  /**
   * A re-read under a live watch that timed out in one namespace keeps the
   * rows the watch holds for it, as every list page does.
   */
  it("keeps a watched namespace's routes when a re-read misses it", async () => {
    watch.live = true;
    const { commands } = await import("@/lib/commands");
    const { queryKeys } = await import("@/lib/query-keys");
    const kept = { name: "kept", namespace: "team-b" };
    vi.mocked(commands.listGatewayRoutesIn).mockImplementation(
      async () =>
        ({
          rows: [route],
          unread: [{ namespace: "team-b", code: "READ_DEADLINE", message: "" }],
        }) as never
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    for (const kind of ["HTTPRoute", "TCPRoute"] as const) {
      client.setQueryData(queryKeys.resources(kind, "team-a,team-b"), {
        rows: [route, kept],
        unread: [],
      });
    }
    try {
      const { result } = renderHook(
        () => useGatewayRoutes(["team-a", "team-b"]),
        {
          wrapper: ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={client}>
              {children}
            </QueryClientProvider>
          ),
        }
      );
      await client.refetchQueries();
      await waitFor(() => expect(result.current.routes).toContainEqual(kept));
      expect(result.current.unread).toEqual([]);
    } finally {
      watch.live = false;
    }
  });
});
