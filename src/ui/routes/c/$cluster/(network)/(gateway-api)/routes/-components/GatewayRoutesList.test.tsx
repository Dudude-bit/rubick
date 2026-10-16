import { describe, expect, it, vi } from "vite-plus/test";
import { screen } from "@testing-library/react";

const store = vi.hoisted(() => ({
  state: { isConnected: true, namespaceScope: [] as string[] },
}));
const page = vi.hoisted(() => ({
  routes: [] as unknown[],
  refused: true,
  loading: false,
  backingError: null as Error | null,
  gateways: false,
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
    served: new Set([
      "HTTPRoute",
      "TCPRoute",
      ...(page.gateways ? ["Gateway", "GatewayClass"] : []),
    ]),
    routes: page.routes,
    unread: [],
    refusedKinds: page.refused ? [{ kind: "TCPRoute", error: refused }] : [],
    isLoading: page.loading,
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

/** A mesh route, whose verdict waits on the Services list. */
const meshed = {
  ...web,
  parentRefs: [
    {
      group: "",
      kind: "Service",
      name: "app",
      namespace: null,
      sectionName: null,
      port: null,
    },
  ],
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
    page.routes = [meshed];
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

describe("the routes page before its first answer", () => {
  /** Fails if a read still on its way is counted as no routes. */
  it("draws no count while the routes are still being read", async () => {
    page.refused = false;
    page.backingError = null;
    page.routes = [];
    page.loading = true;
    await renderRoutes();

    expect(screen.queryByTestId("section-count")).toBeNull();
    page.loading = false;
  });
});

describe("the routes page when the gateways could not be read", () => {
  /**
   * A developer bound to their namespace cannot list Gateways, and a route
   * its controller refused sat muted under "no verdict below is a verdict"
   * beside the healthy-looking rest. A refusal the controller wrote is read,
   * not guessed. Fails if it is drawn muted with the routes nobody can judge,
   * or if its truncated sentence cannot be read whole.
   */
  it("still names a route its controller refused as not serving", async () => {
    const { commands } = await import("@/lib/commands");
    vi.mocked(commands.listGateways).mockRejectedValue(
      new Error("gateways is forbidden (code: 403)")
    );
    const edge = {
      group: "gateway.networking.k8s.io",
      kind: "Gateway",
      name: "edge",
      namespace: "infra",
      sectionName: null,
      port: null,
    };
    page.refused = false;
    page.backingError = null;
    page.gateways = true;
    page.routes = [
      {
        ...web,
        parentRefs: [edge],
        parents: [
          {
            parent: edge,
            controllerName: "example.net/gateway",
            conditions: [
              {
                type: "Accepted",
                status: "False",
                reason: "NoMatchingListenerHostname",
                message: null,
                lastTransitionTime: null,
                observedGeneration: 1,
              },
            ],
          },
        ],
      },
      { ...meshed, name: "quiet", hostnames: ["quiet.example.com"] },
    ];
    await renderRoutes();

    expect(
      await screen.findByText(
        "The gateways could not be read, so no verdict below is a verdict."
      )
    ).toBeVisible();
    expect(screen.getByText("Not serving")).toBeVisible();
    // The cell truncates; its whole sentence is one hover away.
    expect(
      screen.getByTitle(/^stops at .+: hostnames don't intersect$/)
    ).toBeVisible();
    vi.mocked(commands.listGateways).mockResolvedValue([]);
    page.gateways = false;
  });
});

describe("a Gateway its controller refused, above the routes", () => {
  /**
   * The sidebar's dot for a Gateway its controller refused is red, and the
   * line naming it above the routes was amber. Fails if the line is drawn
   * in a softer tone than the break it names.
   */
  it("names the Gateway in the tone of a break", async () => {
    const { commands } = await import("@/lib/commands");
    vi.mocked(commands.listGateways).mockResolvedValue([
      {
        name: "bad-gw",
        namespace: "infra",
        uid: "",
        apiVersion: "gateway.networking.k8s.io/v1",
        className: "traefik",
        listeners: [],
        listenerSets: [],
        listenerSetsKnown: true,
        addresses: ["10.0.0.1"],
        conditions: [
          {
            type: "Accepted",
            status: "False",
            reason: "ListenersNotValid",
            message: null,
            lastTransitionTime: null,
          },
        ],
        generation: 1,
        labels: {},
        annotations: {},
        createdAt: null,
      },
    ]);
    vi.mocked(commands.listGatewayClasses).mockResolvedValue([
      {
        name: "traefik",
        uid: "",
        controllerName: "traefik.io/gateway-controller",
        description: null,
        accepted: true,
        conditions: [],
        labels: {},
        annotations: {},
        createdAt: null,
      },
    ]);
    page.refused = false;
    page.backingError = null;
    page.gateways = true;
    page.routes = [web];
    await renderRoutes();

    const line = (await screen.findByText("bad-gw")).closest("div");
    expect(line).toHaveTextContent("is not programmed by its controller");
    expect(line).toHaveClass("border-err/45");
    vi.mocked(commands.listGateways).mockResolvedValue([]);
    vi.mocked(commands.listGatewayClasses).mockResolvedValue([]);
    page.gateways = false;
  });
});
