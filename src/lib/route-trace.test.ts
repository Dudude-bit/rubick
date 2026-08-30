import { describe, expect, it } from "vitest";

import { routeTraces, gatewayProgrammed, selfAnswered } from "./route-trace";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";

/** The tests read the English catalogue — the same strings as before. */
const t = ((section, key, values) =>
  translate("en", section, key, values)) as T;

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
  listenerSets: [],
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

const parentRef2 = (name: string, sectionName: string | null) => ({
  group: "gateway.networking.k8s.io",
  kind: "Gateway",
  name,
  namespace: null,
  sectionName,
  port: null,
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

/**
 * Some controllers still write only the legacy `Ready` condition. The list
 * column and the detail page used to look for `Programmed` alone and say
 * "no controller answered" about a gateway the map, the pulse and the peek
 * all called programmed — one cluster, two answers.
 */
describe("gatewayProgrammed", () => {
  it("reads the legacy Ready condition when Programmed is absent", () => {
    const legacy = {
      ...gateway("edge"),
      conditions: [condition("Ready", "True", "Ready")],
    };
    expect(gatewayProgrammed(legacy)?.type).toBe("Ready");
  });

  it("prefers Programmed where a controller writes both", () => {
    const both = {
      ...gateway("edge"),
      conditions: [
        condition("Ready", "True", "Ready"),
        condition("Programmed", "False", "Pending"),
      ],
    };
    expect(gatewayProgrammed(both)?.type).toBe("Programmed");
  });
});

describe("routeTraces", () => {
  /**
   * The whole point of a verdict is that somebody checked. A namespace-scoped
   * reader gets a 403 on the cluster-wide Gateway list, every step that needs
   * it comes back blind, and nothing broke — so the old arithmetic, which
   * counted only `err`, called that "Serving" and painted it green forever.
   */
  it("does not call a route serving when it could not read the sources", () => {
    const [trace] = routeTraces(
      route("healthy"),
      sources({ topologyKnown: false }),
      t
    );

    expect(trace.steps.some((step) => step.state === "blind")).toBe(true);
    expect(trace.steps.some((step) => step.state === "err")).toBe(false);
    expect(trace.servingKnown).toBe(false);
  });

  /** A refusal is an answer: nothing unread makes it less of one. */
  it("still knows the verdict when a step refused rather than went unread", () => {
    const [trace] = routeTraces(
      route("healthy"),
      sources({ topologyKnown: false, gateways: [] }),
      t
    );

    if (trace.steps.some((step) => step.state === "err")) {
      expect(trace.servingKnown).toBe(true);
      expect(trace.serving).toBe(false);
    }
  });

  it("walks a healthy route green, leaving only the last mile unchecked", () => {
    const [trace] = routeTraces(route("healthy"), sources(), t);

    expect(trace.gateway).toEqual({
      name: "edge",
      namespace: "gwtest",
      sectionName: "http",
    });
    expect(trace.serving).toBe(true);
    expect(trace.servingKnown).toBe(true);
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
    // The objects a step vouches for are peekable, like everywhere else.
    expect(trace.steps[0].subject).toEqual({
      kind: "GatewayClass",
      name: "envoy",
      namespace: null,
    });
    expect(trace.steps[1].subject).toEqual({
      kind: "Gateway",
      name: "edge",
      namespace: "gwtest",
    });
    expect(trace.steps[3].subject).toEqual({
      kind: "Namespace",
      name: "gwtest",
      namespace: null,
    });
    expect(trace.steps[5].subject).toEqual({
      kind: "Service",
      name: "healthy",
      namespace: "gwtest",
    });
    // The port rides beside the sentence, so the UI can offer a forward.
    expect(trace.steps[5].forwardPort).toBe(8080);
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
    const [trace] = routeTraces(refused, sources(), t);

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
    const [trace] = routeTraces(outsider, sources(), t);

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
    const [trace] = routeTraces(denied, sources(), t);

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
      }),
      t
    );

    expect(trace.serving).toBe(true);
    expect(trace.steps[2].state).toBe("warn");
    expect(trace.steps[2].freshness).toEqual({ observed: 3, current: 4 });
  });

  it("stops at step 1 when nothing claims the gateway's class", () => {
    const [trace] = routeTraces(
      route("orphaned", { parents: [] }),
      sources({ classes: [gatewayClass("envoy", null)] }),
      t
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
    const [trace] = routeTraces(ghost, sources(), t);

    expect(trace.stopStep).toBe(2);
    expect(trace.steps[0].state).toBe("blind");
    expect(trace.steps[1].state).toBe("err");
    expect(trace.steps[1].say).toContain("ghost-gw");
  });

  /**
   * Was "stops at the listener when the controller stays silent". It stops
   * only when the silence means nobody is there — with a claimed class and a
   * gateway its controller has not refused, see the block at the end of this
   * file. Here nothing claims the class, so the silence is real.
   */
  it("stops at the listener when nothing could have answered", () => {
    const [trace] = routeTraces(
      route("healthy", { parents: [] }),
      sources({ classes: [gatewayClass("envoy", null)] }),
      t
    );

    expect(trace.stopStep).toBe(1);
    expect(trace.steps[0].state).toBe("err");
  });

  /**
   * Was "stops at the gateway while its address is still pending", asserting
   * an error on the assumption that no address means an address is coming.
   * A Gateway actually waiting for one says so — `Programmed: False`, reason
   * `AddressNotAssigned` — and still stops at the test below. What is left
   * here is an implementation that publishes no address because it has none
   * to publish, and calling that broken was simply wrong.
   */
  it("goes dashed at a programmed gateway with no address to read", () => {
    const [trace] = routeTraces(
      route("healthy"),
      sources({ gateways: [gateway("edge", { addresses: [] })] }),
      t
    );

    expect(trace.steps[1].state).toBe("blind");
    expect(trace.steps[1].detail?.body).toContain("address");
    expect(trace.stopStep).toBe(null);
  });

  it("goes dashed, not red, where the gateway list cannot be read", () => {
    const [trace] = routeTraces(
      route("healthy"),
      sources({ gateways: [], classes: [], topologyKnown: false }),
      t
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
      }),
      t
    );

    expect(trace.stopStep).toBe(6);
    expect(trace.steps[5].say).toContain("healthy");
    // A missing Service has no page to peek at — no subject, no dead link.
    expect(trace.steps[5].subject).toBeUndefined();
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
      }),
      t
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
      }),
      t
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
    const [trace] = routeTraces(redirect, sources(), t);

    expect(trace.serving).toBe(true);
    expect(trace.steps[5].state).toBe("ok");
    expect(trace.steps[5].say).toContain("redirect");
  });

  it("reads an ExtensionRef-filtered rule with no backends as configuration, not breakage", () => {
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
    const [trace] = routeTraces(direct, sources(), t);

    // Not breakage — that is the whole point of the change.
    expect(trace.serving).toBe(true);
    expect(trace.stopStep).toBe(null);
    // And not a clean bill of health either. This app does not read the
    // filter, so it cannot say the route is fine; `blind` and an unknown
    // verdict are how it says so. Asserting the state alone would pass with
    // "ok", and asserting the copy contains "filter" passes with a sentence
    // saying the opposite — both were true of this test before.
    expect(trace.steps[5].state).toBe("blind");
    expect(trace.steps[6].state).toBe("blind");
    expect(trace.servingKnown).toBe(false);
    expect(trace.steps[5].say).toContain("does not read");
  });

  /**
   * The case the wording used to get wrong. Most ExtensionRef filters are not
   * direct responses: a Kong plugin rate-limits and still needs somewhere to
   * send the request, and this repo's own parser test uses a Traefik
   * `Middleware` that rewrites a path. A route like this one is dead — every
   * matched request gets an immediate gateway error — and the app must not
   * claim otherwise in either direction.
   */
  it("does not vouch for a filter it cannot read", () => {
    const plugin = route("plugin", {
      rules: [
        {
          matches: [],
          backendRefs: [],
          hasRedirect: false,
          extensionRefs: [
            {
              group: "configuration.konghq.com",
              kind: "KongPlugin",
              name: "rate-limit",
            },
          ],
        },
      ],
    });
    const [trace] = routeTraces(plugin, sources(), t);

    expect(trace.servingKnown).toBe(false);
    expect(trace.steps[5].state).toBe("blind");
    expect(trace.steps[5].say).not.toContain("none needed");
  });

  /** A rule that names a filter AND a backend is an ordinary backed route:
   *  the filter decorates it. The guard has to be "names no backend", not
   *  "names no Service" — a non-Service backendRef is still somewhere to go. */
  it("is not self-answered when the route names a backend as well", () => {
    const decorated = route("decorated", {
      rules: [
        {
          matches: [],
          backendRefs: [
            {
              group: "gateway.envoyproxy.io",
              kind: "Backend",
              name: "s3-bucket",
              namespace: null,
              port: null,
              weight: null,
            },
          ],
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

    expect(selfAnswered(decorated)).toBe(false);
  });

  /** Every rule, not some: one rule that neither redirects nor names a filter
   *  and has no backend is a hole, and the route is not configuration. */
  it("is not self-answered when one rule answers nothing at all", () => {
    const half = route("half", {
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
        { matches: [], backendRefs: [], hasRedirect: false, extensionRefs: [] },
      ],
    });

    expect(selfAnswered(half)).toBe(false);
  });

  it("reads a mix of redirect and ExtensionRef rules as configuration too", () => {
    const mixed = route("mixed", {
      rules: [
        { matches: [], backendRefs: [], hasRedirect: true, extensionRefs: [] },
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
    const [trace] = routeTraces(mixed, sources(), t);

    expect(trace.serving).toBe(true);
    // The filter half is the unreadable half, so the whole route is unread.
    expect(trace.steps[5].state).toBe("blind");
    expect(trace.servingKnown).toBe(false);
  });

  /** Redirects stay confident: the spec says a redirect is terminal, so
   *  "no backend needed" is this app's to say. */
  it("still vouches for a redirect-only route", () => {
    const redirect = route("redirect", {
      rules: [
        { matches: [], backendRefs: [], hasRedirect: true, extensionRefs: [] },
      ],
    });
    const [trace] = routeTraces(redirect, sources(), t);

    expect(trace.steps[5].state).toBe("ok");
    expect(trace.servingKnown).toBe(true);
  });

  it("keeps the backend steps dashed while backing is still being read", () => {
    const [trace] = routeTraces(
      route("healthy"),
      sources({
        backing: { services: [], published: [], backingKnown: false },
      }),
      t
    );

    expect(trace.steps[5].state).toBe("blind");
    expect(trace.steps[6].state).toBe("blind");
    expect(trace.serving).toBe(true);
  });

  it("keeps each listener's verdict on its own trace when one gateway is named twice", () => {
    const both = route("both", {
      parentRefs: [parentRef2("edge", "http"), parentRef2("edge", "https")],
      parents: [
        {
          parent: parentRef2("edge", "http"),
          controllerName: "example.net/gw",
          conditions: [
            condition("Accepted", "True", "Accepted"),
            condition("ResolvedRefs", "True", "ResolvedRefs"),
          ],
        },
        {
          parent: parentRef2("edge", "https"),
          controllerName: "example.net/gw",
          conditions: [
            condition(
              "Accepted",
              "False",
              "NoMatchingListenerHostname",
              "no match on https"
            ),
          ],
        },
      ],
    });
    const traces = routeTraces(
      both,
      sources({
        backing: {
          services: [service("both")],
          published: [published("both", 1)],
          backingKnown: true,
        },
      }),
      t
    );

    expect(traces).toHaveLength(2);
    // Distinct identities, so React keys and section labels never collide.
    expect(traces[0].gateway.sectionName).toBe("http");
    expect(traces[1].gateway.sectionName).toBe("https");
    expect(traces[0].serving).toBe(true);
    expect(traces[1].serving).toBe(false);
    expect(traces[1].stopStep).toBe(3);
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
    const traces = routeTraces(twin, sources(), t);

    expect(traces).toHaveLength(2);
    expect(traces[1].gateway).toEqual({
      name: "second",
      namespace: "infra",
      sectionName: null,
    });
  });

  it("probes by gateway address and listener port when the route has no hostname", () => {
    const tcp = route("tcp", {
      kind: "TCPRoute",
      hostnames: [],
    });
    const [trace] = routeTraces(tcp, sources(), t);

    expect(trace.probe).toEqual({
      host: null,
      address: "203.0.113.10",
      port: 80,
    });
  });
});

describe("a gateway that publishes no address", () => {
  /**
   * Reported against 4.6.0 by a reader whose Netbird gateway worked
   * perfectly while five routes under it read "traffic has nowhere to
   * arrive". `status.addresses` is optional in the spec, and an overlay
   * implementation has nothing to publish there — so an empty list, next to
   * a controller saying Programmed, is this app not seeing where traffic
   * arrives. Which is not what it said.
   */
  it("does not call a programmed gateway broken for keeping its address private", () => {
    const trace = routeTraces(
      route("healthy"),
      sources({
        gateways: [
          gateway("edge", {
            addresses: [],
            conditions: [condition("Programmed", "True", "Programmed")],
          }),
        ],
      }),
      t
    )[0];

    const step = trace.steps.find((s) => s.id === "gateway");
    expect(step?.state).toBe("blind");
    expect(trace.serving).toBe(true);
    // And it says so: a verdict nobody checked must not read as checked.
    expect(trace.servingKnown).toBe(false);
  });

  /** Nothing vouched for it and there is no address: both halves unknown,
   *  and the old reading is the right one. */
  it("still reports an unvouched gateway with no address as broken", () => {
    const trace = routeTraces(
      route("healthy"),
      sources({
        gateways: [gateway("edge", { addresses: [], conditions: [] })],
      }),
      t
    )[0];

    expect(trace.steps.find((s) => s.id === "gateway")?.state).toBe("err");
    expect(trace.serving).toBe(false);
  });

  /** A controller that said no is an answer, not a silence. */
  it("keeps reporting a gateway the controller refused", () => {
    const trace = routeTraces(
      route("healthy"),
      sources({
        gateways: [
          gateway("edge", {
            addresses: [],
            conditions: [condition("Programmed", "False", "Pending")],
          }),
        ],
      }),
      t
    )[0];

    expect(trace.steps.find((s) => s.id === "gateway")?.state).toBe("err");
    expect(trace.servingKnown).toBe(true);
  });
});

describe("a route whose controller writes no status", () => {
  /**
   * Reported from a live Netbird cluster: the class is claimed, the gateway
   * is programmed, the TCPRoutes carry traffic — and every one of them read
   * "No controller answered for this parent … the route is invisible to the
   * data plane either way". Both halves of that sentence were contradicted by
   * the two steps directly above it on the same screen.
   */
  it("does not call a route dead when the controller is demonstrably there", () => {
    const [trace] = routeTraces(
      route("healthy", { parents: [] }),
      sources(),
      t
    );

    expect(trace.steps[2].state).toBe("blind");
    expect(trace.serving).toBe(true);
    // Blind, so the verdict does not claim to be checked.
    expect(trace.servingKnown).toBe(false);
    // And the steps below it still run, instead of reading NOT REACHED.
    expect(trace.steps[3].state).toBe("ok");
  });

  /** Nothing claims the class: now the silence really is nobody there. */
  it("still reports a route no controller could have answered", () => {
    const [trace] = routeTraces(
      route("healthy", { parents: [] }),
      sources({
        classes: [gatewayClass("envoy", false)],
      }),
      t
    );

    expect(trace.steps[0].state).toBe("err");
    expect(trace.serving).toBe(false);
  });

  /** The controller refused the gateway itself: also an answer, not silence. */
  it("still reports a route whose gateway the controller refused", () => {
    const [trace] = routeTraces(
      route("healthy", { parents: [] }),
      sources({
        gateways: [
          gateway("edge", {
            conditions: [condition("Programmed", "False", "Pending")],
          }),
        ],
      }),
      t
    );

    expect(trace.serving).toBe(false);
    expect(trace.servingKnown).toBe(true);
  });
});

describe("a route attached through a ListenerSet", () => {
  /**
   * Reported by a maintainer who keeps his Gateway bare and puts every
   * listener in a ListenerSet per app. Every one of his routes names the
   * *set*, so the app saw no Gateway parent, filed them among the mesh
   * routes, and drew no trace at all.
   */
  const withSet = () =>
    gateway("edge", {
      listenerSets: [{ name: "app-tls", namespace: "gwtest" }],
    });

  const viaSet = () =>
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
    });

  it("traces it against the Gateway the set belongs to", () => {
    const traces = routeTraces(viaSet(), sources({ gateways: [withSet()] }), t);

    expect(traces).toHaveLength(1);
    expect(traces[0].gateway.name).toBe("edge");
    expect(traces[0].steps[0].state).toBe("ok");
  });

  /** The set has to actually belong to that Gateway. */
  it("does not attach it to a Gateway that never claimed the set", () => {
    const traces = routeTraces(
      viaSet(),
      sources({ gateways: [gateway("edge")] }),
      t
    );

    expect(traces).toHaveLength(1);
    // The parent resolves to nothing, which is the gateway step's business.
    expect(traces[0].steps[1].state).toBe("err");
  });
});
