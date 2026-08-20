import { describe, expect, it } from "vitest";

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

const gateway = (name: string, addresses: string[]): GatewayInfo => ({
  name,
  namespace: "gwtest",
  apiVersion: "gateway.networking.k8s.io/v1",
  className: "envoy",
  listeners: [],
  addresses,
  conditions: [],
  generation: null,
  labels: {},
  annotations: {},
  createdAt: null,
});

describe("trafficDoors", () => {
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
      [gateway("edge", ["203.0.113.10"])]
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
        copyable: true,
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
      [gateway("edge", ["203.0.113.10"])]
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
      [gateway("edge", ["203.0.113.10"])]
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
      []
    );

    const entry = model.entries[0];
    expect(entry.ghost).toBe(true);
    expect(entry.address).toBeNull();
    expect(entry.doors[0].broken).toBe("gateway missing");
  });

  it("collapses a hostless route to its service port with the protocol", () => {
    const model = trafficDoors(
      conns({
        edges: [
          edge(
            ref("TCPRoute", "tcp-route"),
            ref("Service", "app"),
            ruleRoutes([], "9000")
          ),
          edge(ref("TCPRoute", "tcp-route"), gatewayRef("edge"), {
            verb: "attachesTo",
            sectionName: "tcp",
          }),
        ],
      }),
      [gateway("edge", ["203.0.113.10"])]
    );

    const door = model.entries[0].doors[0];
    expect(door.host).toBe(":9000 TCP");
    expect(door.copyable).toBe(false);
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
      []
    );

    expect(model.entries).toHaveLength(0);
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
      []
    );

    const entry = model.entries[0];
    expect(entry.object.kind).toBe("Ingress");
    expect(entry.meta).toBe("Ingress");
    expect(entry.doors[0]).toEqual({
      host: "shop.example.com",
      copyable: true,
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
      [gateway("edge", ["203.0.113.10"])]
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
      [gateway("edge", ["203.0.113.10"])]
    );

    const doors = model.entries[0].doors;
    expect(doors).toHaveLength(6);
    expect(doors.some((door) => door.broken === "refused")).toBe(true);
  });
});
