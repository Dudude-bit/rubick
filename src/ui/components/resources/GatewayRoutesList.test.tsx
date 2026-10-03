import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { TooltipProvider } from "@/components/ui/tooltip";

const store = vi.hoisted(() => ({
  state: { isConnected: true, namespaceScope: [] as string[] },
}));
const page = vi.hoisted(() => ({
  routes: [] as unknown[],
  refused: true,
  backingError: null as Error | null,
}));
vi.mock("@/stores/clusterStore", () => ({
  useClusterStore: vi.fn(<T,>(selector?: (s: typeof store.state) => T) =>
    typeof selector === "function" ? selector(store.state) : store.state
  ),
}));
vi.mock("@/lib/commands", () => ({
  commands: {
    listGateways: vi.fn(async () => []),
    listGatewayClasses: vi.fn(async () => []),
  },
}));
vi.mock("@/integrations", async (original) => ({
  ...(await original<typeof import("@/integrations")>()),
  useBackingLists: () => ({ data: undefined, error: page.backingError }),
}));

const refused = new Error("tcproutes is forbidden (code: 403)");
vi.mock("@/hooks/useGatewayRoutes", () => ({
  GATEWAY_ROUTE_KINDS: ["HTTPRoute", "TCPRoute"],
  useGatewayRoutes: () => ({
    detection: { installed: true, kinds: [] },
    detectionLoading: false,
    detectionError: null,
    served: new Set(["HTTPRoute", "TCPRoute"]),
    routes: page.routes,
    unread: [],
    refusedKinds: page.refused ? [{ kind: "TCPRoute", error: refused }] : [],
    isLoading: false,
    error: null,
    dataUpdatedAt: 0,
    live: false,
    resyncing: false,
  }),
}));

import { GatewayRoutesList } from "./GatewayRoutesList";

describe("the routes page with a route kind it could not read", () => {
  /**
   * A kind refused in every namespace used to join as no rows at all, and
   * the page said the scope held no routes, with a count of 0, while the
   * same refusal in one namespace of two named it and blanked the count.
   */
  it("names the kind and claims no routes for it", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={["/network/routes"]}>
          <TooltipProvider>
            <GatewayRoutesList />
          </TooltipProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );

    expect(
      await screen.findByText("Could not read TCPRoute in this scope.")
    ).toBeVisible();
    expect(
      screen.getByText("No routes of the kinds that could be read.")
    ).toBeVisible();
    expect(screen.queryByText("No routes in the current scope.")).toBeNull();
    expect(screen.queryByText("0")).toBeNull();
  });
});

describe("the routes page when the Services could not be read", () => {
  /**
   * A refused Services list left the verdicts unknown for good, and the
   * page said "reading verdicts… still on their way" forever.
   */
  it("says the Services could not be read instead of still reading", async () => {
    page.refused = false;
    page.backingError = new Error("services is forbidden (code: 403)");
    page.routes = [
      {
        kind: "HTTPRoute",
        apiVersion: "gateway.networking.k8s.io/v1",
        name: "web",
        namespace: "shop",
        hostnames: ["web.example.com"],
        parentRefs: [],
        rules: [],
        parents: [],
        generation: 1,
        labels: {},
        annotations: {},
        createdAt: null,
      },
    ];
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={["/network/routes"]}>
          <TooltipProvider>
            <GatewayRoutesList />
          </TooltipProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );

    expect(
      await screen.findByText(
        "The Services behind these routes could not be read, so no verdict below is a verdict."
      )
    ).toBeVisible();
    expect(screen.queryByText(/still on their way/)).toBeNull();
  });
});
