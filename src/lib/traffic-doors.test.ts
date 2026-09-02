import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";

/** The tests read the English catalogue — the same strings as before. */
const t = ((section, key, values) =>
  translate("en", section, key, values)) as T;

import { trafficDoors } from "./traffic-doors";
import type {
  GatewayInfo,
  ObjectRef,
  Relation,
  ResourceConnections,
} from "@/generated/types";

const ref = (
  kind: string,
  name: string,
  namespace = "gwtest",
  existence: ObjectRef["existence"] = "present"
): ObjectRef => ({ kind, name, namespace, existence, facts: null });

const gatewayRef = (
  name: string,
  className = "envoy",
  existence: ObjectRef["existence"] = "present"
): ObjectRef => ({
  kind: "Gateway",
  name,
  namespace: "gwtest",
  existence,
  facts: { kind: "gateway", className },
});

const edge = (from: ObjectRef, to: ObjectRef, relation: Relation) => ({
  from,
  to,
  relation,
});

const ruleRoutes = (
  hostnames: string[],
  port: string | null = "8080"
): Relation => ({ verb: "ruleRoutes", hostnames, port, weight: null });

const conns = (
  over: Partial<ResourceConnections> = {}
): ResourceConnections => ({
  subject: ref("Service", "app"),
  edges: [],
  stops: [],
  published: [],
  notLookedAt: [],
  ...over,
});

const gateway = (
  name: string,
  addresses: string[],
  listeners: Array<{ name: string; port: number; protocol: string }> = []
): GatewayInfo => ({
  name,
  namespace: "gwtest",
  apiVersion: "gateway.networking.k8s.io/v1",
  className: "envoy",
  listenerSets: [],
  listenerSetsKnown: true,
  listeners: listeners.map((listener) => ({
    ...listener,
    hostname: null,
    tlsMode: null,
    certificateRefs: [],
    allowedNamespaces: null,
    attachedRoutes: null,
    conditions: [],
    fromListenerSet: null,
  })),
  addresses,
  conditions: [],
  generation: null,
  labels: {},
  annotations: {},
  createdAt: null,
});

describe("trafficDoors", () => {
  /** A route whose parentRef names a ListenerSet the app could not read
   *  arrives with `to.kind === "ListenerSet"`. Reading that as "no gateway
   *  parent" filed it under mesh, and the peek printed "GAMMA, not through
   *  any gateway" — a confident claim about a route that does attach to one.
   *  Every other reader of that parentRef was taught this in #97; this one
   *  was not. */
  it("does not call a route mesh because its ListenerSet went unread", () => {
    const model = trafficDoors(
      conns({
        edges: [
          edge(
            ref("HTTPRoute", "set-route"),
            ref("Service", "app"),
            ruleRoutes(["app.example.com"])
          ),
          edge(
            ref("HTTPRoute", "set-route"),
            ref("ListenerSet", "app-tls", "gwtest", "notChecked"),
            { verb: "attachesTo", sectionName: null }
          ),
        ],
      }),
      [],
      t
    );

    expect(model.mesh).toHaveLength(0);
    expect(model.unresolved).toHaveLength(1);
    expect(model.unresolved[0].name).toBe("set-route");
  });

  /** The other side: a route with no gateway parent at all is still mesh,
   *  and saying so is the whole point of that bucket. */
  it("still calls a route with no gateway parent mesh", () => {
    const model = trafficDoors(
      conns({
        edges: [
          edge(
            ref("HTTPRoute", "gamma"),
            ref("Service", "app"),
            ruleRoutes(["app.example.com"])
          ),
        ],
      }),
      [],
      t
    );

    expect(model.unresolved).toHaveLength(0);
    expect(model.mesh).toHaveLength(1);
  });

  it("stacks a gateway's doors under it, address and class on the entry", () => {
    const model = trafficDoors(
      conns({
        edges: [
          edge(
            ref("HTTPRoute", "healthy-route"),
            ref("Service", "app"),
            ruleRoutes(["healthy.example.com"])
          ),
          edge(ref("HTTPRoute", "healthy-route"), gatewayRef("edge"), {
            verb: "attachesTo",
            sectionName: "http",
          }),
        ],
      }),
      [gateway("edge", ["203.0.113.10"])],
      t
    );

    expect(model.entries).toHaveLength(1);
    const entry = model.entries[0];
    expect(entry.object.name).toBe("edge");
    expect(entry.ghost).toBe(false);
    expect(entry.meta).toBe("Gateway · class envoy");
    expect(entry.address).toBe("203.0.113.10");
    expect(entry.doors).toEqual([
      {
        host: "healthy.example.com",
        copy: "healthy.example.com",
        broken: null,
        route: {
          kind: "HTTPRoute",
          name: "healthy-route",
          namespace: "gwtest",
        },
        note: null,
      },
    ]);
  });

  it("marks a refused door with one word and keeps it in place", () => {
    const model = trafficDoors(
      conns({
        edges: [
          edge(
            ref("HTTPRoute", "wrong-host"),
            ref("Service", "app"),
            ruleRoutes(["wrong.example.org"])
          ),
          edge(ref("HTTPRoute", "wrong-host"), gatewayRef("edge"), {
            verb: "attachesTo",
            sectionName: null,
          }),
        ],
        stops: [
          {
            reason: "routeNotAccepted",
            route: ref("HTTPRoute", "wrong-host"),
            gateway: gatewayRef("edge"),
            conditionReason: "NoMatchingListenerHostname",
            message: "no match",
          },
        ],
      }),
      [gateway("edge", ["203.0.113.10"])],
      t
    );

    expect(model.entries[0].doors[0].broken).toBe("refused");
  });

  it("says refs are the break where ResolvedRefs failed", () => {
    const model = trafficDoors(
      conns({
        edges: [
          edge(
            ref("HTTPRoute", "no-grant"),
            ref("Service", "app"),
            ruleRoutes(["no-grant.example.com"])
          ),
          edge(ref("HTTPRoute", "no-grant"), gatewayRef("edge"), {
            verb: "attachesTo",
            sectionName: null,
          }),
        ],
        stops: [
          {
            reason: "routeRefsUnresolved",
            route: ref("HTTPRoute", "no-grant"),
            conditionReason: "RefNotPermitted",
            message: "not permitted",
          },
        ],
      }),
      [gateway("edge", ["203.0.113.10"])],
      t
    );

    expect(model.entries[0].doors[0].broken).toBe("broken refs");
  });

  it("wears the ghost mark on a gateway that is not there, doors broken", () => {
    const model = trafficDoors(
      conns({
        edges: [
          edge(
            ref("HTTPRoute", "ghost-parent"),
            ref("Service", "app"),
            ruleRoutes(["ghost.example.com"])
          ),
          edge(
            ref("HTTPRoute", "ghost-parent"),
            gatewayRef("ghost-gw", "envoy", "missing"),
            { verb: "attachesTo", sectionName: null }
          ),
        ],
        stops: [
          {
            reason: "gatewayMissing",
            route: ref("HTTPRoute", "ghost-parent"),
            gateway: gatewayRef("ghost-gw", "envoy", "missing"),
          },
        ],
      }),
      [],
      t
    );

    const entry = model.entries[0];
    expect(entry.ghost).toBe(true);
    expect(entry.address).toBeNull();
    expect(entry.doors[0].broken).toBe("gateway missing");
  });

  it("keys a hostless route by its LISTENER's port — the actual door", () => {
    const model = trafficDoors(
      conns({
        edges: [
          edge(
            ref("TCPRoute", "tcp-route"),
            ref("Service", "app"),
            // The relation's port is the backendRef's — the service side,
            // never the door. It must not leak into the label.
            ruleRoutes([], "8080")
          ),
          edge(ref("TCPRoute", "tcp-route"), gatewayRef("edge"), {
            verb: "attachesTo",
            sectionName: "tcp",
          }),
        ],
      }),
      [
        gateway(
          "edge",
          ["203.0.113.10"],
          [{ name: "tcp", port: 9000, protocol: "TCP" }]
        ),
      ],
      t
    );

    const door = model.entries[0].doors[0];
    expect(door.host).toBe(":9000 TCP");
    // What the reader pastes into nc: the gateway's address with the
    // listener's port — the label alone dials nothing.
    expect(door.copy).toBe("203.0.113.10:9000");
  });

  it("claims no port at all where the listener cannot be known", () => {
    const model = trafficDoors(
      conns({
        edges: [
          edge(
            ref("TCPRoute", "tcp-route"),
            ref("Service", "app"),
            ruleRoutes([], "8080")
          ),
          edge(ref("TCPRoute", "tcp-route"), gatewayRef("edge"), {
            verb: "attachesTo",
            sectionName: null,
          }),
        ],
      }),
      // Two listeners and no sectionName — guessing would be a lie.
      [
        gateway(
          "edge",
          ["203.0.113.10"],
          [
            { name: "tcp-a", port: 9000, protocol: "TCP" },
            { name: "tcp-b", port: 9001, protocol: "TCP" },
          ]
        ),
      ],
      t
    );

    const door = model.entries[0].doors[0];
    expect(door.host).toBe("TCP");
    expect(door.host).not.toContain("8080");
    expect(door.copy).toBeNull();
  });

  it("gives a two-gateway route a door under EACH gateway", () => {
    const model = trafficDoors(
      conns({
        edges: [
          edge(
            ref("HTTPRoute", "twin"),
            ref("Service", "app"),
            ruleRoutes(["twin.example.com"])
          ),
          edge(ref("HTTPRoute", "twin"), gatewayRef("edge"), {
            verb: "attachesTo",
            sectionName: null,
          }),
          edge(ref("HTTPRoute", "twin"), gatewayRef("internal"), {
            verb: "attachesTo",
            sectionName: null,
          }),
        ],
      }),
      [],
      t
    );

    expect(model.entries.map((entry) => entry.object.name).sort()).toEqual([
      "edge",
      "internal",
    ]);
    for (const entry of model.entries) {
      expect(entry.doors).toHaveLength(1);
      expect(entry.doors[0].host).toBe("twin.example.com");
    }
  });

  it("keeps a per-gateway refusal on ITS door only — the healthy door stays green", () => {
    const model = trafficDoors(
      conns({
        edges: [
          edge(
            ref("HTTPRoute", "split"),
            ref("Service", "app"),
            ruleRoutes(["split.example.com"])
          ),
          edge(ref("HTTPRoute", "split"), gatewayRef("edge"), {
            verb: "attachesTo",
            sectionName: null,
          }),
          edge(ref("HTTPRoute", "split"), gatewayRef("internal"), {
            verb: "attachesTo",
            sectionName: null,
          }),
        ],
        stops: [
          {
            reason: "routeNotAccepted",
            route: ref("HTTPRoute", "split"),
            gateway: gatewayRef("internal"),
            conditionReason: "NoMatchingListenerHostname",
            message: null,
          },
        ],
      }),
      [],
      t
    );

    const doorOn = (name: string) =>
      model.entries.find((entry) => entry.object.name === name)!.doors[0];
    expect(doorOn("edge").broken).toBeNull();
    expect(doorOn("internal").broken).toBe("refused");
  });

  it("keeps same-named routes from different namespaces as separate doors", () => {
    const model = trafficDoors(
      conns({
        edges: [
          edge(
            ref("HTTPRoute", "api", "team-a"),
            ref("Service", "app"),
            ruleRoutes(["api.example.com"])
          ),
          edge(ref("HTTPRoute", "api", "team-a"), gatewayRef("edge"), {
            verb: "attachesTo",
            sectionName: null,
          }),
          edge(
            ref("HTTPRoute", "api", "team-b"),
            ref("Service", "app"),
            ruleRoutes(["api.example.com"])
          ),
          edge(ref("HTTPRoute", "api", "team-b"), gatewayRef("edge"), {
            verb: "attachesTo",
            sectionName: null,
          }),
        ],
      }),
      [],
      t
    );

    expect(model.entries[0].doors).toHaveLength(2);
  });

  it("keeps mesh parents out of the entries, named in their own place", () => {
    const model = trafficDoors(
      conns({
        edges: [
          edge(
            ref("HTTPRoute", "mesh-route"),
            ref("Service", "app"),
            ruleRoutes([])
          ),
        ],
      }),
      [],
      t
    );

    expect(model.entries).toHaveLength(0);
    expect(model.mesh).toEqual([
      { kind: "HTTPRoute", name: "mesh-route", namespace: "gwtest" },
    ]);
  });

  /**
   * The backend fan-out emits one edge per backendRef, so a route with two
   * rules naming the same Service arrives twice. Counting it twice inflated
   * "also named by N" and handed React two children on one key.
   */
  it("names a multi-rule mesh route once", () => {
    const model = trafficDoors(
      conns({
        edges: [
          edge(
            ref("HTTPRoute", "mesh-route"),
            ref("Service", "app"),
            ruleRoutes([])
          ),
          edge(
            ref("HTTPRoute", "mesh-route"),
            ref("Service", "app"),
            ruleRoutes([])
          ),
        ],
      }),
      [],
      t
    );

    expect(model.mesh).toEqual([
      { kind: "HTTPRoute", name: "mesh-route", namespace: "gwtest" },
    ]);
  });

  it("reads Ingress edges as the same shape — an entry with host doors", () => {
    const model = trafficDoors(
      conns({
        edges: [
          edge(ref("Ingress", "front"), ref("Service", "app"), {
            verb: "routes",
            host: "shop.example.com",
            path: "/",
            pathType: "Prefix",
            port: "3000",
            tls: true,
          }),
        ],
      }),
      [],
      t
    );

    const entry = model.entries[0];
    expect(entry.object.kind).toBe("Ingress");
    expect(entry.meta).toBe("Ingress");
    expect(entry.doors[0]).toEqual({
      host: "shop.example.com",
      copy: "shop.example.com",
      broken: null,
      route: null,
      note: "/ · TLS",
    });
  });

  it("caps the doors and counts the rest", () => {
    const routes = Array.from({ length: 9 }, (_, i) => i);
    const model = trafficDoors(
      conns({
        edges: routes.flatMap((i) => [
          edge(
            ref("HTTPRoute", `route-${i}`),
            ref("Service", "app"),
            ruleRoutes([`host-${i}.example.com`])
          ),
          edge(ref("HTTPRoute", `route-${i}`), gatewayRef("edge"), {
            verb: "attachesTo",
            sectionName: null,
          }),
        ]),
      }),
      [gateway("edge", ["203.0.113.10"])],
      t
    );

    expect(model.entries[0].doors).toHaveLength(6);
    expect(model.entries[0].moreDoors).toBe(3);
  });

  it("floats broken doors above the cap so they are never the hidden ones", () => {
    const routes = Array.from({ length: 7 }, (_, i) => i);
    const model = trafficDoors(
      conns({
        edges: routes.flatMap((i) => [
          edge(
            ref("HTTPRoute", `route-${i}`),
            ref("Service", "app"),
            ruleRoutes([`host-${i}.example.com`])
          ),
          edge(ref("HTTPRoute", `route-${i}`), gatewayRef("edge"), {
            verb: "attachesTo",
            sectionName: null,
          }),
        ]),
        stops: [
          {
            reason: "routeNotAccepted",
            route: ref("HTTPRoute", "route-6"),
            gateway: gatewayRef("edge"),
            conditionReason: "NoMatchingListenerHostname",
            message: null,
          },
        ],
      }),
      [gateway("edge", ["203.0.113.10"])],
      t
    );

    const doors = model.entries[0].doors;
    expect(doors).toHaveLength(6);
    expect(doors.some((door) => door.broken === "refused")).toBe(true);
  });
});
