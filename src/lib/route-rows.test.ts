import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";

/** The tests read the English catalogue — the same strings as before. */
const t = ((section, key, values) =>
  translate("en", section, key, values)) as T;

import { boardMark, gatewaysMark, routesBoard } from "./route-rows";
import type {
  ConditionInfo,
  GatewayClassInfo,
  GatewayInfo,
  ParentRefInfo,
  RouteInfo,
  RouteParentStatusInfo,
  ServiceInfo,
  ServicePublished,
} from "@/generated/types";

const condition = (
  type: string,
  status: string,
  reason: string | null = null,
  message: string | null = null,
  observedGeneration?: number
): ConditionInfo => ({
  type,
  status,
  reason,
  message,
  lastTransitionTime: null,
  observedGeneration,
});

const gateway = (
  name: string,
  overrides: Partial<GatewayInfo> = {}
): GatewayInfo => ({
  name,
  namespace: "gwtest",
  apiVersion: "gateway.networking.k8s.io/v1",
  className: "envoy",
  listenerSets: [],
  listenerSetsKnown: true,
  listeners: [
    {
      name: "http",
      port: 80,
      protocol: "HTTP",
      hostname: null,
      tlsMode: null,
      certificateRefs: [],
      allowedNamespaces: "All",
      attachedRoutes: null,
      conditions: [],
      fromListenerSet: null,
    },
    {
      name: "tcp",
      port: 9000,
      protocol: "TCP",
      hostname: null,
      tlsMode: null,
      certificateRefs: [],
      allowedNamespaces: null,
      attachedRoutes: null,
      conditions: [],
      fromListenerSet: null,
    },
  ],
  addresses: ["203.0.113.10"],
  conditions: [condition("Programmed", "True", "Programmed")],
  generation: 1,
  labels: {},
  annotations: {},
  createdAt: null,
  ...overrides,
});

const gatewayClass = (
  name: string,
  accepted: boolean | null
): GatewayClassInfo => ({
  name,
  controllerName: "example.net/gw",
  description: null,
  accepted,
  conditions: [],
  labels: {},
  annotations: {},
  createdAt: null,
});

const parentRef = (
  name: string,
  overrides: Partial<ParentRefInfo> = {}
): ParentRefInfo => ({
  group: "gateway.networking.k8s.io",
  kind: "Gateway",
  name,
  namespace: null,
  sectionName: "http",
  port: null,
  ...overrides,
});

const parentStatus = (
  gatewayName: string,
  conditions: ConditionInfo[]
): RouteParentStatusInfo => ({
  parent: parentRef(gatewayName, { sectionName: null }),
  controllerName: "example.net/gw",
  conditions,
});

const route = (
  name: string,
  overrides: Partial<RouteInfo> = {}
): RouteInfo => ({
  kind: "HTTPRoute",
  apiVersion: "gateway.networking.k8s.io/v1",
  name,
  namespace: "gwtest",
  hostnames: [`${name}.example.com`],
  parentRefs: [parentRef("edge")],
  rules: [
    {
      matches: [],
      backendRefs: [
        {
          group: "",
          kind: "Service",
          name: "app",
          namespace: null,
          port: 8080,
          weight: null,
        },
      ],
      hasRedirect: false,
      extensionRefs: [],
    },
  ],
  parents: [
    parentStatus("edge", [
      condition("Accepted", "True", "Accepted"),
      condition("ResolvedRefs", "True", "ResolvedRefs"),
    ]),
  ],
  generation: 1,
  labels: {},
  annotations: {},
  createdAt: "2026-08-19T20:00:00Z",
  ...overrides,
});

const service = (name: string, ports: number[] = [8080]): ServiceInfo => ({
  name,
  namespace: "gwtest",
  uid: `uid-${name}`,
  type: "ClusterIP",
  sessionAffinity: "None",
  clusterIp: "10.0.0.1",
  externalIps: [],
  loadBalancerIps: [],
  ports: ports.map((port) => ({
    name: null,
    port,
    targetPort: String(port),
    nodePort: null,
    protocol: "TCP",
  })),
  selector: { app: name },
  labels: {},
  annotations: {},
  createdAt: null,
});

const published = (name: string, ready: number): ServicePublished => ({
  service: {
    kind: "Service",
    name,
    namespace: "gwtest",
    existence: "present",
    facts: null,
  },
  source: "slices",
  slices: 1,
  ready,
  draining: 0,
  notReady: ready === 0 ? 1 : 0,
  unrouted: 0,
  ports: [],
  endpoints: [],
  whole: true,
  unpublished: [],
});

const sources = (over: Partial<Parameters<typeof routesBoard>[1]> = {}) => ({
  gateways: [gateway("edge")],
  classes: [gatewayClass("envoy", true)],
  topologyKnown: true,
  backing: {
    services: [service("app")],
    published: [published("app", 1)],
    backingKnown: true,
  },
  ...over,
});

describe("routesBoard", () => {
  it("splits serving from not-serving in the trace's own words", () => {
    const refused = route("wrong-host", {
      hostnames: ["wrong.example.org"],
      parents: [
        parentStatus("edge", [
          condition(
            "Accepted",
            "False",
            "NoMatchingListenerHostname",
            "no match"
          ),
        ]),
      ],
    });
    const board = routesBoard([route("healthy"), refused], sources(), t);

    expect(board.verdictsKnown).toBe(true);
    expect(board.serving.map((row) => row.name)).toEqual(["healthy"]);
    expect(board.notServing).toHaveLength(1);
    const row = board.notServing[0];
    expect(row.serves).toBe("wrong.example.org");
    expect(row.stop).toEqual({
      at: "listener",
      short: "hostnames don't intersect",
    });
    expect(row.via).toBe("edge :http");
    // The way in is an object that exists — so the row can offer its peek.
    expect(row.viaRef).toEqual({
      kind: "Gateway",
      name: "edge",
      namespace: "gwtest",
    });
  });

  it("orders the broken by break depth — a dead gateway above a missing grant", () => {
    const ghost = route("ghost", {
      parentRefs: [parentRef("ghost-gw", { sectionName: null })],
      parents: [],
    });
    const denied = route("no-grant", {
      rules: [
        {
          matches: [],
          backendRefs: [
            {
              group: "",
              kind: "Service",
              name: "private",
              namespace: "gwtest-other",
              port: 8080,
              weight: null,
            },
          ],
          hasRedirect: false,
          extensionRefs: [],
        },
      ],
      parents: [
        parentStatus("edge", [
          condition("Accepted", "True", "Accepted"),
          condition("ResolvedRefs", "False", "RefNotPermitted", "not allowed"),
        ]),
      ],
    });
    const board = routesBoard([denied, ghost], sources(), t);

    expect(board.notServing.map((row) => row.name)).toEqual([
      "ghost",
      "no-grant",
    ]);
    expect(board.notServing[0].stop?.at).toBe("gateway");
    // A missing gateway gets no reference — a link to a 404 is worse
    // than the plain name — but it is named as missing, so the row can
    // wear the "?" and say why.
    expect(board.notServing[0].viaRef).toBeNull();
    expect(board.notServing[0].viaGhost).toEqual({
      kind: "Gateway",
      name: "ghost-gw",
      namespace: "gwtest",
    });
    expect(board.notServing[1].viaGhost).toBeNull();
    expect(board.notServing[1].stop).toEqual({
      at: "refs",
      short: "needs a ReferenceGrant in gwtest-other",
    });
  });

  it("keys a hostless route by its listener's port and protocol", () => {
    const tcp = route("tcp", {
      kind: "TCPRoute",
      hostnames: [],
      parentRefs: [parentRef("edge", { sectionName: "tcp" })],
    });
    const board = routesBoard([tcp], sources(), t);

    expect(board.serving[0].serves).toBe(":9000 TCP");
    expect(board.serving[0].via).toBe("edge :tcp");
    // The dialable pair — the label alone dials nothing.
    expect(board.serving[0].servesCopy).toBe("203.0.113.10:9000");
  });

  it("counts extra hostnames instead of listing them", () => {
    const wide = route("wide", {
      hostnames: ["a.example.com", "b.example.com", "c.example.com"],
    });
    const board = routesBoard([wide], sources(), t);

    expect(board.serving[0].serves).toBe("a.example.com");
    expect(board.serving[0].more).toBe(2);
    expect(board.serving[0].servesCopy).toBe("a.example.com");
  });

  it("keeps mesh routes out of the verdict groups, said as GAMMA", () => {
    const mesh = route("mesh", {
      parentRefs: [
        parentRef("app", { group: "", kind: "Service", sectionName: null }),
      ],
      parents: [],
    });
    const board = routesBoard([mesh], sources(), t);

    expect(board.notServing).toHaveLength(0);
    expect(board.serving).toHaveLength(0);
    expect(board.mesh).toHaveLength(1);
    expect(board.mesh[0].tail).toContain("GAMMA");
    expect(board.mesh[0].via).toBe("app");
    expect(board.mesh[0].viaRef).toEqual({
      kind: "Service",
      name: "app",
      namespace: "gwtest",
    });
  });

  it("calls a route with no parentRefs broken, not quiet", () => {
    const orphan = route("orphan", { parentRefs: [], parents: [] });
    const board = routesBoard([orphan], sources(), t);

    expect(board.notServing).toHaveLength(1);
    expect(board.notServing[0].stop?.short).toContain("no parentRefs");
  });

  it("reads a redirect-only route as serving, with the note as its tail", () => {
    const redirect = route("redirect", {
      rules: [
        { matches: [], backendRefs: [], hasRedirect: true, extensionRefs: [] },
      ],
    });
    const board = routesBoard([redirect], sources(), t);

    expect(board.serving[0].tail).toContain("redirect");
  });

  it("reads an ExtensionRef-only route as serving, with the filter note as its tail", () => {
    const direct = route("direct", {
      rules: [
        {
          matches: [],
          backendRefs: [],
          hasRedirect: false,
          extensionRefs: [
            {
              group: "gateway.envoyproxy.io",
              kind: "HTTPRouteFilter",
              name: "direct-response",
            },
          ],
        },
      ],
    });
    const board = routesBoard([direct], sources(), t);

    expect(board.serving[0].tail).toContain("filter");
  });

  it("carries the stale-generation tag onto the row", () => {
    const edited = route("edited", {
      generation: 4,
      parents: [
        parentStatus("edge", [
          condition("Accepted", "True", "Accepted", null, 3),
          condition("ResolvedRefs", "True", "ResolvedRefs", null, 3),
        ]),
      ],
    });
    const board = routesBoard([edited], sources(), t);

    expect(board.serving[0].stale).toEqual({ observed: 3, current: 4 });
  });

  it("raises a pulse for a gateway whose class nothing claims — routes or not", () => {
    const board = routesBoard(
      [route("healthy")],
      sources({
        gateways: [gateway("edge"), gateway("orphan", { className: "nobody" })],
        classes: [gatewayClass("envoy", true), gatewayClass("nobody", null)],
      }),
      t
    );

    expect(board.pulse).toHaveLength(1);
    expect(board.pulse[0].gateway).toBe("orphan");
    expect(board.pulse[0].say).toContain("nobody");
  });

  it("stays quiet on the pulse when every gateway is claimed and addressed", () => {
    const board = routesBoard([route("healthy")], sources(), t);
    expect(board.pulse).toHaveLength(0);
  });

  it("does not pretend to know verdicts while the sources are still loading", () => {
    const board = routesBoard(
      [route("healthy")],
      sources({
        backing: { services: [], published: [], backingKnown: false },
      }),
      t
    );

    expect(board.verdictsKnown).toBe(false);
  });

  it("does not call a gateway a ghost while the gateway list is unread", () => {
    const board = routesBoard(
      [route("healthy")],
      sources({ gateways: [], classes: [], topologyKnown: false }),
      t
    );

    expect(board.serving[0].viaRef).toBeNull();
    expect(board.serving[0].viaGhost).toBeNull();
  });

  it("marks the younger claimant of a contested host — the older route wins", () => {
    const older = route("older", {
      hostnames: ["contested.example.com"],
      createdAt: "2026-08-01T00:00:00Z",
    });
    const younger = route("younger", {
      hostnames: ["contested.example.com"],
      createdAt: "2026-08-15T00:00:00Z",
    });
    const board = routesBoard([younger, older], sources(), t);

    const by = (name: string) => board.serving.find((row) => row.name === name);
    expect(by("older")?.contested).toBeNull();
    expect(by("younger")?.contested).toEqual({ by: "older" });
  });

  /**
   * Splitting one hostname across routes by path is how the Gateway API is
   * meant to be used — the spec merges HTTPRoutes on a hostname and resolves
   * precedence per match. Calling it a contest put a warn badge on a healthy
   * cluster and a standing mark in the sidebar.
   */
  const atPath = (name: string, path: string, createdAt?: string) => {
    const base = route(name, { hostnames: ["shop.example.com"] });
    return {
      ...base,
      ...(createdAt ? { createdAt } : {}),
      rules: base.rules.map((rule) => ({
        ...rule,
        matches: [
          {
            path,
            pathType: "PathPrefix",
            method: null,
            grpcService: null,
            grpcMethod: null,
            headers: [],
            queryParams: [],
          },
        ],
      })),
    };
  };

  it("does not call a path split across two routes a contested host", () => {
    const board = routesBoard(
      [atPath("cart", "/cart"), atPath("checkout", "/checkout")],
      sources(),
      t
    );

    const rows = [...board.serving, ...board.notServing];
    expect(rows.map((row) => row.name).sort()).toEqual(["cart", "checkout"]);
    expect(rows.every((row) => row.contested === null)).toBe(true);
  });

  /** Overlapping paths on one hostname are a contest, and still read as one. */
  it("still marks two routes whose paths do meet", () => {
    const board = routesBoard(
      [
        atPath("younger", "/cart/items", "2026-08-15T00:00:00Z"),
        atPath("older", "/cart", "2026-08-01T00:00:00Z"),
      ],
      sources(),
      t
    );

    const rows = [...board.serving, ...board.notServing];
    const by = (name: string) => rows.find((row) => row.name === name);
    expect(by("older")?.contested).toBeNull();
    expect(by("younger")?.contested).toEqual({ by: "older" });
  });

  it("does not call hosts on different gateways a conflict", () => {
    const onEdge = route("on-edge", { hostnames: ["same.example.com"] });
    const elsewhere = route("elsewhere", {
      hostnames: ["same.example.com"],
      parentRefs: [parentRef("second", { sectionName: null })],
      parents: [
        parentStatus("second", [
          condition("Accepted", "True", "Accepted"),
          condition("ResolvedRefs", "True", "ResolvedRefs"),
        ]),
      ],
    });
    const board = routesBoard(
      [onEdge, elsewhere],
      sources({ gateways: [gateway("edge"), gateway("second")] }),
      t
    );

    expect(board.serving.every((row) => row.contested === null)).toBe(true);
  });

  it("marks the worst parent's verdict on a route attached to two gateways", () => {
    const twin = route("twin", {
      parentRefs: [
        parentRef("edge", { sectionName: null }),
        parentRef("ghost-gw", { sectionName: null }),
      ],
      parents: [
        parentStatus("edge", [
          condition("Accepted", "True", "Accepted"),
          condition("ResolvedRefs", "True", "ResolvedRefs"),
        ]),
      ],
    });
    const board = routesBoard([twin], sources(), t);

    expect(board.notServing).toHaveLength(1);
    expect(board.notServing[0].stop?.at).toBe("gateway");
    expect(board.notServing[0].via).toBe("edge +1");
  });
});

describe("the sidebar marks", () => {
  it("stays silent while the verdicts are unknown", () => {
    const board = routesBoard(
      [route("healthy")],
      sources({ topologyKnown: false }),
      t
    );
    expect(boardMark(board)).toBeUndefined();
  });

  it("goes red when anything is dead, yellow for stale or contested", () => {
    const dead = route("dead", {
      parents: [parentStatus("edge", [condition("Accepted", "False")])],
    });
    expect(boardMark(routesBoard([dead], sources(), t))).toBe("err");

    const stale = route("stale", {
      generation: 4,
      parents: [
        parentStatus("edge", [
          condition("Accepted", "True", null, null, 3),
          condition("ResolvedRefs", "True", null, null, 3),
        ]),
      ],
    });
    expect(boardMark(routesBoard([stale], sources(), t))).toBe("warn");

    expect(
      boardMark(routesBoard([route("healthy")], sources(), t))
    ).toBeUndefined();
  });

  it("marks the gateways row from the pulse, then from silence", () => {
    const board = routesBoard(
      [],
      sources({ gateways: [gateway("edge", { className: "ghost" })] }),
      t
    );
    expect(gatewaysMark([gateway("edge")], board.pulse, true)).toBe("err");

    const silent = gateway("quiet", { conditions: [] });
    expect(gatewaysMark([silent], [], true)).toBe("warn");
    expect(gatewaysMark([silent], [], false)).toBeUndefined();
    expect(gatewaysMark([gateway("edge")], [], true)).toBeUndefined();
  });
});

describe("routes that reach a gateway through a ListenerSet", () => {
  /**
   * They used to land in `mesh`, the group for routes attached to a Service
   * — "nothing about a gateway applies to them". Everything about a gateway
   * applies to these; they just name the set that carries its listeners.
   */
  it("are judged, not filed as mesh", () => {
    const board = routesBoard(
      [
        route("healthy", {
          parentRefs: [
            {
              group: "gateway.networking.k8s.io",
              kind: "ListenerSet",
              name: "app-tls",
              namespace: null,
              sectionName: null,
              port: null,
            },
          ],
          parents: [],
        }),
      ],
      sources({
        gateways: [
          gateway("edge", {
            listenerSets: [{ name: "app-tls", namespace: "gwtest" }],
          }),
        ],
      }),
      t
    );

    expect(board.mesh).toHaveLength(0);
    expect(board.serving.length + board.notServing.length).toBe(1);
    expect([...board.serving, ...board.notServing][0].via).toContain("edge");
  });
});
