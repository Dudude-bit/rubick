import { describe, expect, it } from "vitest";

import { gatewayHosts } from "./gateway-hosts";
import type {
  ConditionInfo,
  GatewayClassInfo,
  GatewayInfo,
  RouteInfo,
  RouteParentStatusInfo,
} from "@/generated/types";

const condition = (
  type: string,
  status: string,
  reason: string | null = null,
  message: string | null = null
): ConditionInfo => ({
  type,
  status,
  reason,
  message,
  lastTransitionTime: null,
});

const gateway = (
  name: string,
  overrides: Partial<GatewayInfo> = {}
): GatewayInfo => ({
  name,
  namespace: "gwtest",
  apiVersion: "gateway.networking.k8s.io/v1",
  className: "envoy",
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
      name: "https",
      port: 443,
      protocol: "HTTPS",
      hostname: "*.gwtest.example.com",
      tlsMode: "Terminate",
      certificateRefs: [],
      allowedNamespaces: null,
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
  generation: null,
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

const parentStatus = (
  gatewayName: string,
  conditions: ConditionInfo[]
): RouteParentStatusInfo => ({
  parent: {
    group: "gateway.networking.k8s.io",
    kind: "Gateway",
    name: gatewayName,
    namespace: null,
    sectionName: null,
    port: null,
  },
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
  parentRefs: [
    {
      group: "gateway.networking.k8s.io",
      kind: "Gateway",
      name: "edge",
      namespace: null,
      sectionName: "http",
      port: null,
    },
  ],
  rules: [
    {
      matches: [],
      backendRefs: [
        {
          group: "",
          kind: "Service",
          name,
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
  generation: null,
  labels: {},
  annotations: {},
  createdAt: null,
  ...overrides,
});

const ok = [gateway("edge")];
const classes = [gatewayClass("envoy", true)];

describe("the hosts-first model", () => {
  it("puts an accepted hostname route under served, with its chain", () => {
    const model = gatewayHosts([route("healthy")], ok, classes, undefined);

    expect(model.broken).toHaveLength(0);
    expect(model.served).toHaveLength(1);
    const row = model.served[0];
    expect(row.address).toBe("healthy.example.com");
    expect(row.kindTag).toBe("HTTPRoute");
    expect(row.gateway?.name).toBe("edge");
    expect(row.gateway?.listener).toBe(":http");
    expect(row.backends[0].name).toBe("healthy");
    expect(model.counts).toEqual({ served: 1, broken: 0 });
  });

  it("sorts a refused route into broken, with the controller's words and the listener's own hostnames as the fix", () => {
    const refused = route("wrong-host", {
      parentRefs: [
        {
          group: "gateway.networking.k8s.io",
          kind: "Gateway",
          name: "edge",
          namespace: null,
          sectionName: "https",
          port: null,
        },
      ],
      hostnames: ["wrong.example.org"],
      parents: [
        parentStatus("edge", [
          condition(
            "Accepted",
            "False",
            "NoMatchingListenerHostname",
            "no listener hostname matches"
          ),
        ]),
      ],
    });
    const model = gatewayHosts([refused], ok, classes, undefined);

    expect(model.served).toHaveLength(0);
    const row = model.broken[0];
    expect(row.stop?.title).toBe("edge does not accept this route");
    expect(row.stop?.fix).toContain("no listener hostname matches");
    // The actual mismatch, quoted from the listener the route asked for.
    expect(row.stop?.fix).toContain("*.gwtest.example.com");
  });

  it("names a missing gateway as the stop the cluster cannot say", () => {
    const ghost = route("ghost-parent", {
      parentRefs: [
        {
          group: "gateway.networking.k8s.io",
          kind: "Gateway",
          name: "ghost",
          namespace: null,
          sectionName: null,
          port: null,
        },
      ],
      parents: [],
    });
    const model = gatewayHosts([ghost], ok, classes, undefined);
    const row = model.broken[0];
    expect(row.gateway?.exists).toBe(false);
    expect(row.stop?.title).toBe("Names a Gateway that does not exist");
  });

  it("keys a hostless TCP route by its listener's port", () => {
    const tcp = route("tcp", {
      kind: "TCPRoute",
      hostnames: [],
      parentRefs: [
        {
          group: "gateway.networking.k8s.io",
          kind: "Gateway",
          name: "edge",
          namespace: null,
          sectionName: "tcp",
          port: null,
        },
      ],
    });
    const model = gatewayHosts([tcp], ok, classes, undefined);
    expect(model.ports).toHaveLength(1);
    expect(model.ports[0].address).toBe(":9000 / TCP");
  });

  it("keeps a mesh route quiet — no gateway, no missing lie", () => {
    const mesh = route("mesh", {
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
      parents: [],
    });
    const model = gatewayHosts([mesh], ok, classes, undefined);
    expect(model.broken).toHaveLength(0);
    expect(model.quiet).toHaveLength(1);
    expect(model.quiet[0].tail).toContain("mesh routing");
  });

  it("reads a redirect-only route as configuration, not breakage", () => {
    const redirect = route("redirect", {
      rules: [
        { matches: [], backendRefs: [], hasRedirect: true, extensionRefs: [] },
      ],
    });
    const model = gatewayHosts([redirect], ok, classes, undefined);
    expect(model.served[0].tail).toContain("redirect");
    expect(model.served[0].stop).toBeNull();
  });

  it("lists a gateway whose class nothing claimed, apart from the routes", () => {
    const orphanGateway = gateway("orphan", {
      className: "nobody",
      conditions: [],
    });
    const model = gatewayHosts(
      [],
      [...ok, orphanGateway],
      [...classes, gatewayClass("nobody", null)],
      undefined
    );
    expect(model.unclaimed).toHaveLength(1);
    expect(model.unclaimed[0].name).toBe("orphan");
    // The claimed one is the pulse, not a finding.
    expect(model.gateways.map((g) => g.name)).toContain("edge");
  });
});
