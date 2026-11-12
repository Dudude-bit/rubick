import { describe, expect, it, vi } from "vite-plus/test";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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
    listPods: vi.fn(async () => []),
    listDeploymentsIn: vi.fn(async () => ({ rows: [], unread: [] })),
  },
}));
const podRows = vi.hoisted(() => ({
  list: vi.fn(async (_scope: string[] | null, _signal?: AbortSignal) => ({
    rows: [],
    unread: [],
  })),
  watched: vi.fn((_: { enabled: boolean; queryKey: unknown }) => ({
    live: true,
    refresh: false as const,
    resyncing: false,
    watchFailed: false,
  })),
}));
vi.mock("@/lib/pod-rows", () => ({ listPodRows: podRows.list }));
vi.mock("@/hooks/useLiveQuery", async (original) => {
  const real = await original<typeof import("@/hooks/useLiveQuery")>();
  return { ...real, useLiveQuery: vi.fn(real.useLiveQuery) };
});
vi.mock("@/hooks/useWatchedList", async (original) => ({
  ...(await original<typeof import("@/hooks/useWatchedList")>()),
  useWatchedList: podRows.watched,
}));
vi.mock("@/integrations", async (original) => ({
  ...(await original<typeof import("@/integrations")>()),
  useBackingLists: () => ({ data: undefined, error: page.backingError }),
}));

const refused = new Error("tcproutes is forbidden (code: 403)");
vi.mock("../../../../-object/useGatewayRoutes", () => ({
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
import { queryKeys } from "@/lib/query-keys";
import { useLiveQuery } from "@/hooks/useLiveQuery";

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

describe("the routes page opened from a link to one kind's rows", () => {
  const api = { ...web, name: "api" };
  const stream = { ...web, kind: "TCPRoute", name: "stream" };

  /**
   * The breadcrumb of an HTTPRoute and the Overview's "N HTTPRoutes" arrive
   * as `?listOf=httproutes`, which the page ignored: the link named one kind
   * and the page listed every kind.
   */
  it("lists only the kind the link was for", async () => {
    page.refused = false;
    page.backingError = null;
    page.routes = [web, stream];
    await renderRoutes("?listOf=httproutes");

    expect(await screen.findAllByText("web")).not.toHaveLength(0);
    expect(screen.queryByText("stream")).toBeNull();
  });

  /**
   * The Overview's link carries `?names=` for the routes it counted. Fails
   * if the page lists the others too, or narrows without saying so, or
   * leaves a named route that is gone unmentioned.
   */
  it("lists only the named routes and says that it does", async () => {
    page.refused = false;
    page.backingError = null;
    page.routes = [web, api];
    await renderRoutes("?listOf=httproutes&names=shop/web,shop/gone");

    expect(await screen.findAllByText("web")).not.toHaveLength(0);
    expect(screen.queryByText("api")).toBeNull();
    expect(
      screen.getByText(
        "Showing only the 2 rows the Overview listed as needing attention."
      )
    ).toBeVisible();
    expect(
      screen.getByText("1 of them is not in this list now.")
    ).toBeVisible();
  });
});

describe("the routes page a link narrowed to named routes, with a kind unread", () => {
  /**
   * A named route may be of the kind that was refused. Fails if it is said
   * to be "not in this list now", which reads as fixed or deleted.
   */
  it("does not call a named route gone while a kind could not be read", async () => {
    page.refused = true;
    page.backingError = null;
    page.routes = [web];
    await renderRoutes("?names=shop/web,shop/stream");

    expect(
      await screen.findByText(
        "1 of them is not among the rows that could be read."
      )
    ).toBeVisible();
    expect(screen.queryByText(/not in this list now/)).toBeNull();
    page.refused = false;
  });
});

describe("the kind filter on a page a link narrowed to one kind", () => {
  /**
   * `listOf` stands in for `kind` until the reader picks one. Fails if
   * "All kinds" leaves it in the address, where it would put the filter
   * straight back.
   */
  it("shows every kind once the reader asks for all of them", async () => {
    page.refused = false;
    page.backingError = null;
    page.routes = [web, { ...web, kind: "TCPRoute", name: "stream" }];
    // Radix's Select asks jsdom for three things it does not have.
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.releasePointerCapture ??= () => {};
    Element.prototype.scrollIntoView ??= () => {};
    const { router } = await renderRoutes("?listOf=httproutes");
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole("combobox", { name: "Filter by kind" })
    );
    await user.click(await screen.findByRole("option", { name: "All kinds" }));

    expect(await screen.findAllByText("stream")).not.toHaveLength(0);
    expect(router.state.location.searchStr).toBe("");
  });
});

describe("the routes map", () => {
  /**
   * The map counts the pods behind each backend. It read every pod of the
   * cluster whole, in one answer, every ten seconds: 78 MiB a read on 10 000
   * pods. Fails if it asks for whole pods again, polls a list its watch
   * keeps, or reads anything before the map is opened.
   */
  it("reads the cluster's pods as rows kept by a watch, and only once opened", async () => {
    const { commands } = await import("@/lib/commands");
    const EVERY_POD = queryKeys.podRows(null);
    page.refused = false;
    page.backingError = null;
    page.routes = [web];
    await renderRoutes();
    await screen.findAllByText("web");

    expect(podRows.list).not.toHaveBeenCalled();
    expect(podRows.watched).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false })
    );

    await userEvent.setup().click(screen.getByRole("button", { name: "Map" }));

    await waitFor(() => expect(podRows.list).toHaveBeenCalledTimes(1));
    expect(podRows.list.mock.calls[0][0]).toBeNull();
    expect(podRows.watched).toHaveBeenLastCalledWith(
      expect.objectContaining({
        enabled: true,
        queryKey: EVERY_POD,
      })
    );
    const asked = vi
      .mocked(useLiveQuery)
      .mock.calls.map(([query]) => query)
      .filter((query) => String(query.queryKey) === String(EVERY_POD));
    expect(asked.at(-1)).toMatchObject({ enabled: true, refresh: false });
    expect(commands.listPods).not.toHaveBeenCalled();
    expect(commands.listDeploymentsIn).not.toHaveBeenCalled();
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

const refusedGateway = (name: string, namespace: string) => ({
  name,
  namespace,
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
});

const traefik = {
  name: "traefik",
  uid: "",
  controllerName: "traefik.io/gateway-controller",
  description: null,
  accepted: true,
  conditions: [],
  labels: {},
  annotations: {},
  createdAt: null,
};

describe("a Gateway its controller refused, above the routes", () => {
  /**
   * The sidebar's dot for a Gateway its controller refused is red, and the
   * line naming it above the routes was amber. Fails if the line is drawn
   * in a softer tone than the break it names.
   */
  it("names the Gateway in the tone of a break", async () => {
    const { commands } = await import("@/lib/commands");
    vi.mocked(commands.listGateways).mockResolvedValue([
      refusedGateway("bad-gw", "infra"),
    ]);
    vi.mocked(commands.listGatewayClasses).mockResolvedValue([traefik]);
    page.refused = false;
    page.backingError = null;
    page.gateways = true;
    page.routes = [web];
    await renderRoutes();

    const line = (await screen.findByText("bad-gw")).closest("div");
    expect(line).toHaveTextContent(
      "is not programmed by its controller: ListenersNotValid"
    );
    expect(line).toHaveClass("border-err/45");
    vi.mocked(commands.listGateways).mockResolvedValue([]);
    vi.mocked(commands.listGatewayClasses).mockResolvedValue([]);
    page.gateways = false;
  });

  /**
   * A window on one team's namespace carried a banner about another team's
   * Gateway that none of its routes ride. Fails if the banner is not held
   * to the window and the Gateways its routes cross.
   */
  it("leaves out a Gateway outside the window that none of its routes ride", async () => {
    const { commands } = await import("@/lib/commands");
    vi.mocked(commands.listGateways).mockResolvedValue([
      refusedGateway("theirs", "infra"),
      refusedGateway("ours", "shop"),
    ]);
    vi.mocked(commands.listGatewayClasses).mockResolvedValue([traefik]);
    store.state.namespaceScope = ["shop"];
    page.refused = false;
    page.backingError = null;
    page.gateways = true;
    page.routes = [web];
    await renderRoutes();

    expect(await screen.findByText("ours")).toBeVisible();
    expect(screen.queryByText("theirs")).toBeNull();
    store.state.namespaceScope = [];
    vi.mocked(commands.listGateways).mockResolvedValue([]);
    vi.mocked(commands.listGatewayClasses).mockResolvedValue([]);
    page.gateways = false;
  });
});
