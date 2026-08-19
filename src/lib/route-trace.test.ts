import { describe, expect, it } from "vitest";

import { routeTraces } from "./route-trace";
import type {
  ConditionInfo,
  GatewayClassInfo,
  GatewayInfo,
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
  generation: 1,
  labels: {},
  annotations: {},
  createdAt: null,
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

const sources = (over: Partial<Parameters<typeof routeTraces>[1]> = {}) => ({
  gateways: [gateway("edge")],
  classes: [gatewayClass("envoy", true)],
  topologyKnown: true,
  backing: {
    services: [service("healthy")],
    published: [published("healthy", 1)],
    backingKnown: true,
  },
  ...over,
});

const ids = (trace: { steps: { id: string }[] }) =>
  trace.steps.map((step) => step.id);

describe("routeTraces", () => {
  it("walks a healthy route green, leaving only the last mile unchecked", () => {
    const [trace] = routeTraces(route("healthy"), sources());

    expect(trace.gateway).toEqual({ name: "edge", namespace: "gwtest" });
    expect(trace.serving).toBe(true);
    expect(trace.stopStep).toBeNull();
    expect(ids(trace)).toEqual([
      "class",
      "gateway",
      "listener",
      "namespace",
      "refs",
      "backend",
      "endpoints",
      "reachable",
    ]);
    const states = trace.steps.map((step) => step.state);
    expect(states.slice(0, 7)).toEqual(Array(7).fill("ok"));
    expect(trace.steps[7].state).toBe("blind");
    expect(trace.steps[7].who).toBe("machine");
    expect(trace.steps[0].who).toBe("infra");
    expect(trace.steps[6].say).toContain("1 ready");
    expect(trace.probe).toEqual({
      host: "healthy.example.com",
      address: "203.0.113.10",
      port: 80,
    });
  });

  it("stops at the listener when hostnames do not intersect, quoting both sides", () => {
    const refused = route("wrong-host", {
      hostnames: ["wrong.example.org"],
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
    const [trace] = routeTraces(refused, sources());

    expect(trace.serving).toBe(false);
    expect(trace.stopStep).toBe(3);
    const listener = trace.steps[2];
    expect(listener.state).toBe("err");
    expect(listener.who).toBe("yours");
    expect(listener.detail?.quote).toEqual({
      asks: "wrong.example.org",
      serves: "*.gwtest.example.com",
    });
    expect(listener.detail?.body).toContain("no listener hostname matches");
    // Everything after the break is not reached, not broken.
    expect(trace.steps.slice(3).every((step) => step.state === "off")).toBe(
      true
    );
  });

  it("blames the namespace step, not the listener, when the listener refused the namespace", () => {
    const outsider = route("outsider", {
      parents: [
        parentStatus("edge", [
          condition(
            "Accepted",
            "False",
            "NotAllowedByListeners",
            "namespace not allowed"
          ),
        ]),
      ],
    });
    const [trace] = routeTraces(outsider, sources());

    expect(trace.stopStep).toBe(4);
    expect(trace.steps[2].state).toBe("ok");
    expect(trace.steps[3].state).toBe("err");
    expect(trace.steps[3].detail?.body).toContain("namespace not allowed");
  });

  it("writes the exact ReferenceGrant that would fix RefNotPermitted", () => {
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
          condition(
            "ResolvedRefs",
            "False",
            "RefNotPermitted",
            "reference not permitted"
          ),
        ]),
      ],
    });
    const [trace] = routeTraces(denied, sources());

    expect(trace.stopStep).toBe(5);
    const scaffold = trace.steps[4].detail?.scaffold ?? "";
    expect(scaffold).toContain("kind: ReferenceGrant");
    expect(scaffold).toContain("namespace: gwtest-other");
    expect(scaffold).toContain("kind: HTTPRoute");
    expect(scaffold).toContain("namespace: gwtest");
    expect(scaffold).toContain("apiVersion: gateway.networking.k8s.io/v1beta1");
  });

  it("marks a verdict about an older generation stale without calling it broken", () => {
    const edited = route("edited", {
      generation: 4,
      parents: [
        parentStatus("edge", [
          condition("Accepted", "True", "Accepted", null, 3),
          condition("ResolvedRefs", "True", "ResolvedRefs", null, 3),
        ]),
      ],
    });
    const [trace] = routeTraces(
      edited,
      sources({
        backing: {
          services: [service("edited")],
          published: [published("edited", 1)],
          backingKnown: true,
        },
      })
    );

    expect(trace.serving).toBe(true);
    expect(trace.steps[2].state).toBe("warn");
    expect(trace.steps[2].freshness).toEqual({ observed: 3, current: 4 });
  });

  it("stops at step 1 when nothing claims the gateway's class", () => {
    const [trace] = routeTraces(
      route("orphaned", { parents: [] }),
      sources({ classes: [gatewayClass("envoy", null)] })
    );

    expect(trace.stopStep).toBe(1);
    expect(trace.steps[0].state).toBe("err");
    expect(trace.steps[0].say).toContain("envoy");
  });

  it("stops at the gateway when the parent does not exist", () => {
    const ghost = route("ghost", {
      parentRefs: [
        {
          group: "gateway.networking.k8s.io",
          kind: "Gateway",
          name: "ghost-gw",
          namespace: null,
          sectionName: null,
          port: null,
        },
      ],
      parents: [],
    });
    const [trace] = routeTraces(ghost, sources());

    expect(trace.stopStep).toBe(2);
    expect(trace.steps[0].state).toBe("blind");
    expect(trace.steps[1].state).toBe("err");
    expect(trace.steps[1].say).toContain("ghost-gw");
  });

  it("stops at the listener when the controller stays silent about an existing gateway", () => {
    const [trace] = routeTraces(route("silent", { parents: [] }), sources());

    expect(trace.stopStep).toBe(3);
    expect(trace.steps[2].detail?.body).toContain("No controller");
  });

  it("stops at the gateway while its address is still pending", () => {
    const [trace] = routeTraces(
      route("pending"),
      sources({ gateways: [gateway("edge", { addresses: [] })] })
    );

    expect(trace.stopStep).toBe(2);
    expect(trace.steps[1].detail?.body).toContain("address");
  });

  it("goes dashed, not red, where the gateway list cannot be read", () => {
    const [trace] = routeTraces(
      route("healthy"),
      sources({ gateways: [], classes: [], topologyKnown: false })
    );

    expect(trace.serving).toBe(true);
    expect(trace.steps[0].state).toBe("blind");
    expect(trace.steps[1].state).toBe("blind");
    expect(trace.steps[2].state).toBe("ok");
  });

  it("stops at the backend when the Service is missing", () => {
    const [trace] = routeTraces(
      route("healthy"),
      sources({
        backing: { services: [], published: [], backingKnown: true },
      })
    );

    expect(trace.stopStep).toBe(6);
    expect(trace.steps[5].say).toContain("healthy");
  });

  it("stops at the backend when the Service does not serve the ref's port", () => {
    const [trace] = routeTraces(
      route("healthy"),
      sources({
        backing: {
          services: [service("healthy", [9999])],
          published: [published("healthy", 1)],
          backingKnown: true,
        },
      })
    );

    expect(trace.stopStep).toBe(6);
    expect(trace.steps[5].detail?.quote).toEqual({
      asks: "8080",
      serves: "9999",
    });
  });

  it("stops at endpoints when nothing behind the Service is ready", () => {
    const [trace] = routeTraces(
      route("healthy"),
      sources({
        backing: {
          services: [service("healthy")],
          published: [published("healthy", 0)],
          backingKnown: true,
        },
      })
    );

    expect(trace.stopStep).toBe(7);
    expect(trace.steps[6].state).toBe("err");
  });

  it("reads a redirect-only route as configuration, not breakage", () => {
    const redirect = route("redirect", {
      rules: [
        { matches: [], backendRefs: [], hasRedirect: true, extensionRefs: [] },
      ],
    });
    const [trace] = routeTraces(redirect, sources());

    expect(trace.serving).toBe(true);
    expect(trace.steps[5].state).toBe("ok");
    expect(trace.steps[5].say).toContain("redirect");
  });

  it("keeps the backend steps dashed while backing is still being read", () => {
    const [trace] = routeTraces(
      route("healthy"),
      sources({
        backing: { services: [], published: [], backingKnown: false },
      })
    );

    expect(trace.steps[5].state).toBe("blind");
    expect(trace.steps[6].state).toBe("blind");
    expect(trace.serving).toBe(true);
  });

  it("returns one trace per gateway parent and none for mesh parents", () => {
    const twin = route("twin", {
      parentRefs: [
        {
          group: "gateway.networking.k8s.io",
          kind: "Gateway",
          name: "edge",
          namespace: null,
          sectionName: null,
          port: null,
        },
        {
          group: "gateway.networking.k8s.io",
          kind: "Gateway",
          name: "second",
          namespace: "infra",
          sectionName: null,
          port: null,
        },
        {
          group: "",
          kind: "Service",
          name: "mesh-app",
          namespace: null,
          sectionName: null,
          port: null,
        },
      ],
    });
    const traces = routeTraces(twin, sources());

    expect(traces).toHaveLength(2);
    expect(traces[1].gateway).toEqual({ name: "second", namespace: "infra" });
  });

  it("probes by gateway address and listener port when the route has no hostname", () => {
    const tcp = route("tcp", {
      kind: "TCPRoute",
      hostnames: [],
    });
    const [trace] = routeTraces(tcp, sources());

    expect(trace.probe).toEqual({
      host: null,
      address: "203.0.113.10",
      port: 80,
    });
  });
});
