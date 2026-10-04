import { describe, expect, it, vi } from "vite-plus/test";
import { screen } from "@testing-library/react";

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
vi.mock("../../../../-object/useGatewayRoutes", () => ({
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

import { renderWithRouter } from "@/test/render";
import { GatewayRoutesList } from "./GatewayRoutesList";

const web = {
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
};

const renderRoutes = (search = "") =>
  renderWithRouter(<GatewayRoutesList />, {
    at: `/c/prod/routes${search}`,
    route: "/c/$cluster/routes",
  });

describe("the routes page with a route kind it could not read", () => {
  /**
   * A kind refused in every namespace used to join as no rows at all, and
   * the page said the scope held no routes, with a count of 0, while the
   * same refusal in one namespace of two named it and blanked the count.
   */
  it("names the kind and claims no routes for it", async () => {
    await renderRoutes();

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
    page.routes = [web];
    await renderRoutes();

    expect(
      await screen.findByText(
        "The Services behind these routes could not be read, so no verdict below is a verdict."
      )
    ).toBeVisible();
    expect(screen.queryByText(/still on their way/)).toBeNull();
  });
});

describe("the routes page opened on one route kind", () => {
  /**
   * `/c/prod/tcproutes` lands here as `?kind=tcproutes`. A page that ignored
   * the query listed every kind under a link that asked for one.
   */
  it("hides the routes of the other kinds", async () => {
    page.refused = false;
    page.backingError = null;
    page.routes = [web];
    await renderRoutes("?kind=tcproutes");

    expect(
      await screen.findByText("Nothing matches the filter.")
    ).toBeVisible();
    expect(screen.queryByText("web")).toBeNull();
  });

  it("lists the routes of the kind the address names", async () => {
    page.refused = false;
    page.backingError = null;
    page.routes = [web];
    await renderRoutes("?kind=httproutes");

    expect(await screen.findAllByText("web")).not.toHaveLength(0);
    expect(screen.queryByText("Nothing matches the filter.")).toBeNull();
  });
});
