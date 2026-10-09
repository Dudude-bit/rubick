import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { describe, expect, it } from "vite-plus/test";
import { CRASH_LOOP_WINDOW_MS } from "@/lib/crash-loop";

/** The English catalogue — what these expectations are written in. */
const t: T = (section, key, values) => translate("en", section, key, values);

import {
  chainSilence,
  connectionCount,
  connectionGroups,
  dependentsOf,
  describeStop,
  describeUsages,
  hopTone,
  stopUnder,
  trafficChains,
  type RoutedIngress,
} from "./connections";
import type {
  ChainStop,
  NotServing,
  PublishedEndpoint,
  ServicePublished,
  ConnectionEdge,
  ObjectFacts,
  ObjectRef,
  ResourceConnections,
  Rollout,
  Usage,
} from "@/generated/types";

const ref = (
  kind: string,
  name: string,
  facts: ObjectFacts | null = null,
  existence: ObjectRef["existence"] = "present"
): ObjectRef => ({
  kind,
  name,
  namespace: "k8s-gui-test",
  existence,
  facts,
});

const pod = (name: string, ready: boolean): ObjectRef =>
  ref("Pod", name, {
    kind: "pod",
    phase: "Running",
    display: ready ? "Running" : "NotReady",
    ready,
    loopingUntil: null,
    exitUnreported: false,
  });

const service = (name: string, selector: string | null): ObjectRef =>
  ref("Service", name, {
    kind: "service",
    type: "ClusterIP",
    clusterIp: "10.43.0.9",
    externalName: null,
    selector,
    ports: [
      {
        name: null,
        port: 80,
        targetPort: "8080",
        nodePort: null,
        protocol: "TCP",
      },
    ],
  });

const connections = (
  subject: ObjectRef,
  edges: ConnectionEdge[],
  stops: ChainStop[] = [],
  notLookedAt: ResourceConnections["notLookedAt"] = [],
  published: ServicePublished[] = []
): ResourceConnections => ({
  subject,
  edges,
  stops,
  published,
  notLookedAt,
});

/** What a Service publishes, as its slices state it. */
const publishes = (
  name: string,
  counts: Partial<
    Pick<ServicePublished, "ready" | "draining" | "notReady" | "unrouted">
  >,
  extra: Partial<ServicePublished> = {}
): ServicePublished => ({
  service: {
    kind: "Service",
    name,
    namespace: "k8s-gui-test",
    existence: "present",
    facts: null,
  },
  source: "slices",
  slices: 1,
  ready: 0,
  draining: 0,
  notReady: 0,
  unrouted: 0,
  unroutedReady: 0,
  ports: [],
  endpoints: [],
  whole: true,
  unpublished: [],
  stop: null,
  ...counts,
  ...extra,
});

const endpointOf = (pod: string, state: Partial<PublishedEndpoint> = {}) => ({
  address: "10.42.1.51",
  target: {
    kind: "Pod",
    name: pod,
    namespace: "k8s-gui-test",
    existence: "present" as const,
    facts: null,
  },
  ready: true,
  serving: true,
  terminating: false,
  nodeName: "server-0",
  zone: null,
  hintZones: [],
  ports: [8080],
  ...state,
});

describe("the traffic chain", () => {
  it("draws a Service in front of a workload as a hop, and the pods behind it", () => {
    /** The whole point of the view: a Deployment cannot say today whether
     *  anything fronts it. If the Service edge stops becoming a hop, the
     *  Overview goes back to showing an unreachable workload as fine. */
    const deployment = ref("Deployment", "log-demo");
    const svc = service("log-demo", "app=log-demo");
    const path = trafficChains(
      connections(
        deployment,
        [
          {
            from: svc,
            to: deployment,
            relation: { verb: "selects", selector: "app=log-demo" },
          },
        ],
        [],
        [],
        [
          publishes(
            "log-demo",
            { ready: 2 },
            { endpoints: [endpointOf("log-demo-a"), endpointOf("log-demo-b")] }
          ),
        ]
      ),
      t
    )[0];

    expect(path.hops.map((hop) => hop.at)).toEqual([
      "object",
      "object",
      "published",
    ]);
    expect(path.broken).toBe(false);
    const svcHop = path.hops[0];
    if (svcHop.at !== "object") throw new Error("expected the Service hop");
    expect(svcHop.detail).toBe(":80 → 8080");
    expect(svcHop.via).toContain("selects app=log-demo");
    const last = path.hops[2];
    if (last.at !== "published") throw new Error("expected the published hop");
    expect(last.summary).toBe("and 1 more · 2 published");
  });

  it("puts an Ingress above the Service that routes to it", () => {
    /** The hop the reader came for. Losing it turns "how does traffic get
     *  here" back into a visit to the Ingress list page. */
    const deployment = ref("Deployment", "log-demo");
    const svc = service("log-demo", "app=log-demo");
    const ingress = ref("Ingress", "log-demo", {
      kind: "ingress",
      className: "nginx",
    });
    const path = trafficChains(
      connections(deployment, [
        {
          from: svc,
          to: deployment,
          relation: { verb: "selects", selector: "app=log-demo" },
        },
        {
          from: svc,
          to: pod("log-demo-a", true),
          relation: { verb: "selects", selector: "app=log-demo" },
        },
        {
          from: ingress,
          to: svc,
          relation: {
            verb: "routes",
            host: "log-demo.local",
            path: "/",
            pathType: "Prefix",
            port: "80",
            tls: false,
          },
        },
      ]),
      t
    )[0];

    const hop = path.hops[0];
    if (hop.at !== "object") throw new Error("expected the Ingress hop");
    expect(hop.object.kind).toBe("Ingress");
    expect(hop.detail).toBe("log-demo.local/");
    expect(hop.via).toBe("over plain HTTP · nginx");
    // The one line on this whole view somebody can act on.
    expect(hop.urls).toEqual(["http://log-demo.local/"]);
  });

  it("puts a Gateway above the route, and the route above the Service", () => {
    const deployment = ref("Deployment", "promo");
    const svc = service("promo", "app=promo");
    const route = ref("HTTPRoute", "promo");
    const gateway = ref("Gateway", "edge", {
      kind: "gateway",
      className: "envoy",
    });
    const path = trafficChains(
      connections(deployment, [
        {
          from: svc,
          to: deployment,
          relation: { verb: "selects", selector: "app=promo" },
        },
        {
          from: route,
          to: svc,
          relation: {
            verb: "ruleRoutes",
            hostnames: ["promo.example.com"],
            port: "8080",
            weight: null,
          },
        },
        {
          from: route,
          to: gateway,
          relation: { verb: "attachesTo", sectionName: "https" },
        },
      ]),
      t
    )[0];

    const [gatewayHop, routeHopDrawn] = path.hops;
    if (gatewayHop.at !== "object") throw new Error("expected the Gateway hop");
    expect(gatewayHop.object.kind).toBe("Gateway");
    expect(gatewayHop.detail).toBe("section https");
    expect(gatewayHop.via).toBe("envoy");

    if (routeHopDrawn.at !== "object")
      throw new Error("expected the route hop");
    expect(routeHopDrawn.object.kind).toBe("HTTPRoute");
    expect(routeHopDrawn.detail).toBe("promo.example.com");
    // No URL: whether that hostname is served over TLS is the listener's
    // fact, and the chain does not invent a scheme.
    expect(routeHopDrawn.urls).toEqual([]);
    expect(path.broken).toBe(false);
  });

  it("breaks the path on the route where its controller refused it", () => {
    const deployment = ref("Deployment", "promo");
    const svc = service("promo", "app=promo");
    const route = ref("HTTPRoute", "promo");
    const path = trafficChains(
      connections(
        deployment,
        [
          {
            from: svc,
            to: deployment,
            relation: { verb: "selects", selector: "app=promo" },
          },
          {
            from: route,
            to: svc,
            relation: {
              verb: "ruleRoutes",
              hostnames: ["promo.example.com"],
              port: "8080",
              weight: null,
            },
          },
        ],
        [
          {
            reason: "routeNotAccepted",
            route,
            gateway: ref("Gateway", "edge"),
            conditionReason: "NoMatchingListenerHostname",
            message: "no listener hostname matches",
          },
        ]
      ),
      t
    )[0];

    const stop = path.hops.find((hop) => hop.at === "stop");
    if (!stop || stop.at !== "stop") throw new Error("expected a stop hop");
    expect(stop.title).toBe("edge does not accept this route");
    expect(stop.note).toContain("NoMatchingListenerHostname");
    expect(path.broken).toBe(true);
  });

  it("draws a missing Gateway as the missing thing, not as a healthy hop", () => {
    const deployment = ref("Deployment", "promo");
    const svc = service("promo", "app=promo");
    const route = ref("HTTPRoute", "promo");
    const ghost = ref("Gateway", "ghost", null, "missing");
    const path = trafficChains(
      connections(
        deployment,
        [
          {
            from: svc,
            to: deployment,
            relation: { verb: "selects", selector: "app=promo" },
          },
          {
            from: route,
            to: svc,
            relation: {
              verb: "ruleRoutes",
              hostnames: [],
              port: null,
              weight: null,
            },
          },
          {
            from: route,
            to: ghost,
            relation: { verb: "attachesTo", sectionName: null },
          },
        ],
        [{ reason: "gatewayMissing", route, gateway: ghost }]
      ),
      t
    )[0];

    const gatewayHop = path.hops[0];
    if (gatewayHop.at !== "object") throw new Error("expected the Gateway hop");
    expect(gatewayHop.object.existence).toBe("missing");
    const stop = path.hops.find((hop) => hop.at === "stop");
    if (!stop || stop.at !== "stop") throw new Error("expected a stop hop");
    expect(stop.title).toBe("Names a Gateway that does not exist");
    expect(path.broken).toBe(true);
  });

  it("says a drained weight-0 backend is configuration, not an outage", () => {
    const deployment = ref("Deployment", "promo");
    const svc = service("promo", "app=promo");
    const route = ref("HTTPRoute", "promo");
    const path = trafficChains(
      connections(deployment, [
        {
          from: svc,
          to: deployment,
          relation: { verb: "selects", selector: "app=promo" },
        },
        {
          from: route,
          to: svc,
          relation: {
            verb: "ruleRoutes",
            hostnames: ["promo.example.com"],
            port: "8080",
            weight: 0,
          },
        },
      ]),
      t
    )[0];

    const routeHopDrawn = path.hops[0];
    if (routeHopDrawn.at !== "object")
      throw new Error("expected the route hop");
    expect(routeHopDrawn.via).toBe("weight 0: deliberately gets no traffic");
    expect(path.broken).toBe(false);
  });

  it("says what serves the host and under which certificate", () => {
    /** A workload page could always name the hostname that reached it and
     *  never what answers on it or whether it is encrypted — the half people
     *  actually ask about. Losing the two hops puts them back on the Ingress
     *  page to find out. */
    const deployment = ref("Deployment", "log-demo");
    const svc = service("log-demo", "app=log-demo");
    const ingress = ref("Ingress", "log-demo", {
      kind: "ingress",
      className: "traefik",
    });
    const path = trafficChains(
      connections(deployment, [
        {
          from: svc,
          to: deployment,
          relation: { verb: "selects", selector: "app=log-demo" },
        },
        {
          from: ingress,
          to: svc,
          relation: {
            verb: "routes",
            host: "log-demo.local",
            path: "/",
            pathType: "Prefix",
            port: "80",
            tls: true,
          },
        },
      ]),
      t,
      {
        routing: new Map([
          [
            "Ingress/k8s-gui-test/log-demo",
            {
              tls: [{ secretName: "log-demo-tls", hosts: ["log-demo.local"] }],
              addresses: ["203.0.113.10"],
              binding: {
                requested: "traefik",
                resolved: "traefik",
                controller: "traefik.io/ingress-controller",
                viaDefault: false,
                available: [],
              },
            },
          ],
        ]),
      }
    )[0];

    expect(path.hops.map((hop) => hop.at)).toEqual([
      "certificate",
      "controller",
      "object",
      "object",
      "object",
    ]);
    const certificate = path.hops[0];
    if (certificate.at !== "certificate") throw new Error("expected TLS");
    expect(certificate.secret.name).toBe("log-demo-tls");
    const controller = path.hops[1];
    if (controller.at !== "controller")
      throw new Error("expected a controller");
    expect(controller.binding.controller).toBe("traefik.io/ingress-controller");
    const route = path.hops[2];
    if (route.at !== "object") throw new Error("expected the Ingress hop");
    expect(route.urls).toEqual(["https://log-demo.local/"]);
    // The URL is half an address until the hostname resolves somewhere.
    expect(route.address).toEqual({
      state: "assigned",
      addresses: ["203.0.113.10"],
    });
  });

  it("tells an unread address from one the controller never published", () => {
    /** An Ingress with no address is never reached whatever its rules say,
     *  and it is the most common reason a correct one "does not work". `null`
     *  is a page that has not looked; `[]` is a finding. Collapsing the two
     *  would make the chain either silent about a real outage or noisy on
     *  every page that has not read the Ingress. */
    const deployment = ref("Deployment", "log-demo");
    const svc = service("log-demo", "app=log-demo");
    const ingress = ref("Ingress", "log-demo", {
      kind: "ingress",
      className: null,
    });
    const edges: ConnectionEdge[] = [
      {
        from: svc,
        to: deployment,
        relation: { verb: "selects", selector: "app=log-demo" },
      },
      {
        from: ingress,
        to: svc,
        relation: {
          verb: "routes",
          host: "log-demo.local",
          path: "/",
          pathType: "Prefix",
          port: "80",
          tls: false,
        },
      },
    ];

    const unread = trafficChains(connections(deployment, edges), t)[0];
    const first = unread.hops[0];
    if (first.at !== "object") throw new Error("expected the Ingress hop");
    expect(first.address).toBeNull();

    const served = {
      requested: null,
      resolved: "nginx",
      controller: "k8s.io/ingress-nginx",
      viaDefault: true,
      available: [],
    };
    const read = trafficChains(connections(deployment, edges), t, {
      routing: new Map([
        [
          "Ingress/k8s-gui-test/log-demo",
          { tls: [], binding: served, addresses: [] },
        ],
      ]),
    })[0];
    const hop = read.hops[1];
    if (hop.at !== "object") throw new Error("expected the Ingress hop");
    expect(hop.address).toEqual({ state: "pending", addresses: [] });
  });

  it("does not call an Ingress no controller serves one still waiting for its address", () => {
    /** The Service and Pod pages said "No address yet: the controller has
     *  published none" right under "No IngressClass named nginx ... never
     *  will". Fails if an unserved class reads as a pending address. */
    const pod = ref("Pod", "log-demo-84c4d9749c-pws9g");
    const svc = service("log-demo", "app=log-demo");
    const ingress = ref("Ingress", "plain-nginx", {
      kind: "ingress",
      className: "nginx",
    });
    const edges: ConnectionEdge[] = [
      {
        from: svc,
        to: pod,
        relation: { verb: "selects", selector: "app=log-demo" },
      },
      {
        from: ingress,
        to: svc,
        relation: {
          verb: "routes",
          host: "plain.k8s-gui.test",
          path: "/",
          pathType: "Prefix",
          port: "80",
          tls: false,
        },
      },
    ];
    const chain = (binding: RoutedIngress["binding"]) =>
      trafficChains(connections(pod, edges), t, {
        routing: new Map([
          [
            "Ingress/k8s-gui-test/plain-nginx",
            { tls: [], binding, addresses: [] },
          ],
        ]),
      })[0].hops.find((hop) => hop.at === "object");

    const unserved = chain({
      requested: "nginx",
      resolved: null,
      controller: null,
      viaDefault: false,
      available: [],
    });
    if (unserved?.at !== "object") throw new Error("expected the Ingress hop");
    expect(unserved.address?.state).toBe("noController");

    const unread = chain(null);
    if (unread?.at !== "object") throw new Error("expected the Ingress hop");
    expect(unread.address?.state).toBe("unknown");
  });

  it("draws no certificate hop for a host the Secret does not cover", () => {
    /** A wildcard entry covers everything, a named one covers what it names.
     *  Getting this wrong claims a host is served under a certificate that
     *  every browser would refuse. */
    const deployment = ref("Deployment", "log-demo");
    const svc = service("log-demo", "app=log-demo");
    const ingress = ref("Ingress", "log-demo", {
      kind: "ingress",
      className: null,
    });
    const path = trafficChains(
      connections(deployment, [
        {
          from: svc,
          to: deployment,
          relation: { verb: "selects", selector: "app=log-demo" },
        },
        {
          from: ingress,
          to: svc,
          relation: {
            verb: "routes",
            host: "log-demo.local",
            path: "/",
            pathType: "Prefix",
            port: "80",
            tls: false,
          },
        },
      ]),
      t,
      {
        routing: new Map([
          [
            "Ingress/k8s-gui-test/log-demo",
            {
              tls: [{ secretName: "other-tls", hosts: ["shop.example.com"] }],
              addresses: [],
              binding: null,
            },
          ],
        ]),
      }
    )[0];

    expect(path.hops.some((hop) => hop.at === "certificate")).toBe(false);
  });

  /**
   * A wildcard Secret is the ordinary shape, not the edge case — `*.example.com`
   * covering `shop.example.com` is exactly `covers`'s rule from
   * `certificates.ts`. If this regressed to exact string matching, the most
   * common TLS setup in any real cluster would draw no certificate hop at all.
   */
  it("draws a certificate hop for a host a wildcard Secret covers", () => {
    const chainFor = (tlsHosts: string[], routeHost: string) => {
      const deployment = ref("Deployment", "log-demo");
      const svc = service("log-demo", "app=log-demo");
      const ingress = ref("Ingress", "log-demo", {
        kind: "ingress",
        className: null,
      });
      return trafficChains(
        connections(deployment, [
          {
            from: svc,
            to: deployment,
            relation: { verb: "selects", selector: "app=log-demo" },
          },
          {
            from: ingress,
            to: svc,
            relation: {
              verb: "routes",
              host: routeHost,
              path: "/",
              pathType: "Prefix",
              port: "80",
              tls: true,
            },
          },
        ]),
        t,
        {
          routing: new Map([
            [
              "Ingress/k8s-gui-test/log-demo",
              {
                tls: [{ secretName: "wildcard-tls", hosts: tlsHosts }],
                addresses: [],
                binding: null,
              },
            ],
          ]),
        }
      )[0];
    };

    // Exact host: the ordinary case, and the one every prior version already
    // handled.
    expect(
      chainFor(["shop.example.com"], "shop.example.com").hops.some(
        (hop) => hop.at === "certificate"
      )
    ).toBe(true);

    // One label of wildcard: the setup exact matching missed entirely.
    expect(
      chainFor(["*.example.com"], "shop.example.com").hops.some(
        (hop) => hop.at === "certificate"
      )
    ).toBe(true);

    // Two labels under a wildcard is what a browser refuses, so the app must
    // refuse it too rather than draw a certificate hop that lies.
    expect(
      chainFor(["*.example.com"], "a.shop.example.com").hops.some(
        (hop) => hop.at === "certificate"
      )
    ).toBe(false);

    // No hosts on the `spec.tls` entry is the Ingress's own catch-all and
    // must keep matching everything — this is not the wildcard rule and must
    // not start going through it.
    expect(
      chainFor([], "anything.example.com").hops.some(
        (hop) => hop.at === "certificate"
      )
    ).toBe(true);
  });

  it("marks a chain that stops, and says which pods are not ready", () => {
    /** `noneReady` is the case every list page in the app draws as healthy.
     *  If it stops arriving as a hop of its own, the one screen that could
     *  have said so goes quiet too. */
    const svc = service("unready-demo", "app=unready-demo");
    const path = trafficChains(
      connections(
        svc,
        [
          {
            from: svc,
            to: pod("unready-demo-a", false),
            relation: { verb: "selects", selector: "app=unready-demo" },
          },
          {
            from: svc,
            to: pod("unready-demo-b", false),
            relation: { verb: "selects", selector: "app=unready-demo" },
          },
        ],
        [
          {
            reason: "noneReady",
            service: svc,
            selector: "app=unready-demo",
            pods: 2,
            why: "failingReadiness",
          },
        ]
      ),
      t
    )[0];

    expect(path.broken).toBe(true);
    const stop = path.hops[path.hops.length - 1];
    if (stop.at !== "stop") throw new Error("expected a stop hop");
    expect(stop.title).toBe(
      "2 pods carry app=unready-demo, and none of them is ready"
    );
  });

  it("says the three stops differently", () => {
    /** Three stops, three repairs. Collapsing them into one sentence is the
     *  difference between a tool and a red dot. */
    const svc = service("demo", "app=demo");
    const titles = (
      [
        {
          reason: "backendMissing",
          ingress: ref("Ingress", "ghost-demo"),
          service: svc,
        },
        {
          reason: "selectsNothing",
          service: svc,
          selector: "app=tls-demo",
          near: null,
        },
        {
          reason: "noneReady",
          service: svc,
          selector: "app=x",
          pods: 2,
          why: "failingReadiness",
        },
      ] satisfies ChainStop[]
    ).map((stop) => describeStop(stop, t).title);

    expect(new Set(titles).size).toBe(3);
    expect(titles[0]).toContain("No Service named demo");
    expect(titles[1]).toBe("No pod carries app=tls-demo");
  });

  /**
   * Marco's checkout-api: two pods carry app=checkout-api with track=canary,
   * and the page said only that no pod carries the selector. Fails if the
   * pods one label short go unnamed, or the label they lack is not said.
   */
  it("names the pods one label short of a selector that matches none", () => {
    const svc = service("checkout-api", "app=checkout-api,track=stable");
    const pods = ["a", "b", "c", "d"].map((x) =>
      ref("Pod", `checkout-api-${x}`)
    );
    const said = describeStop(
      {
        reason: "selectsNothing",
        service: svc,
        selector: "app=checkout-api,track=stable",
        near: { pods, carries: "app=checkout-api", lacks: "track=stable" },
      },
      t
    );
    expect(said.title).toBe(
      "4 pods carry app=checkout-api but not track=stable"
    );
    expect(
      said.note.startsWith(
        "Closest: checkout-api-a, checkout-api-b, checkout-api-c, and 1 more. "
      )
    ).toBe(true);
    expect(said.note).toContain("add track=stable to their template");
  });

  /**
   * Lena scaled hello-web to zero: the header read Idle and the chain said in
   * red that no pod carries app=hello-web. Fails if an idle workload's empty
   * selector is drawn as a label mismatch, or a running one's stops being.
   */
  it("says a workload scaled to zero has no pods by intent, not that its labels are wrong", () => {
    const front = service("hello-web", "app=hello-web");
    const chainOf = (rollout: Rollout) => {
      const deployment = ref("Deployment", "hello-web", {
        kind: "workload",
        replicas: 0,
        readyReplicas: 0,
        rollout,
        revision: null,
        current: null,
      });
      const [path] = trafficChains(
        connections(
          deployment,
          [
            {
              from: front,
              to: deployment,
              relation: { verb: "selects", selector: "app=hello-web" },
            },
          ],
          [
            {
              reason: "selectsNothing",
              service: front,
              selector: "app=hello-web",
              near: null,
            },
          ]
        ),
        t
      );
      return { path, stop: path.hops.at(-1)! };
    };

    const idle = chainOf({ state: "idle" });
    expect(idle.stop).toMatchObject({
      at: "stop",
      mood: "idle",
      title: "No pods by intent: hello-web is scaled to zero",
    });
    expect(hopTone(idle.stop)).toBe("on");
    expect(idle.path.broken).toBe(false);

    const short = chainOf({ state: "short", available: 0, desired: 2 });
    expect(short.stop).toMatchObject({
      mood: "fault",
      title: "No pod carries app=hello-web",
    });
    expect(hopTone(short.stop)).toBe("bad");
    expect(short.path.broken).toBe(true);
  });

  /**
   * Marco's ledger page drew "1 pod carries app=ledger, and it is not ready"
   * in red, counted from the slices while the pods were not read, under a
   * Deployment whose own verdict was the controller's alone. Fails if a
   * stop counted from the slices claims the pods were looked at, if one
   * waiting on unread pods or on pods still starting is drawn as a fault or
   * breaks its path, or if a plain fault stops being one.
   */
  it("draws a stop waiting on its pods by what it waits on, and counts the slices' addresses as theirs", () => {
    const front = service("ledger", "app=ledger");
    const subject = ref("Deployment", "ledger", {
      kind: "workload",
      replicas: 1,
      readyReplicas: 0,
      rollout: null,
      revision: null,
      current: null,
    });
    const chainOf = (why: NotServing) => {
      const [path] = trafficChains(
        connections(
          subject,
          [
            {
              from: front,
              to: subject,
              relation: { verb: "selects", selector: "app=ledger" },
            },
          ],
          [
            {
              reason: "noneReady",
              service: front,
              selector: "app=ledger",
              pods: 1,
              why,
            },
          ]
        ),
        t
      );
      return { path, stop: path.hops.at(-1)! };
    };

    const unread = chainOf("podsUnread");
    expect(unread.stop).toMatchObject({
      mood: "unchecked",
      title: "The endpoints list 1 address for app=ledger, and it is not ready",
    });
    expect(hopTone(unread.stop)).toBe("unknown");
    expect(unread.path.broken).toBe(false);

    const coming = chainOf("comingUp");
    expect(coming.stop).toMatchObject({
      mood: "coming",
      title: "1 pod carries app=ledger, and it is not ready",
    });
    expect(hopTone(coming.stop)).toBe("info");
    expect(coming.path.broken).toBe(false);

    expect(chainOf("inSlices").stop).toMatchObject({
      mood: "fault",
      title: "The endpoints list 1 address for app=ledger, and it is not ready",
    });
    const crashing = chainOf("crashLooping");
    expect(crashing.stop).toMatchObject({
      mood: "fault",
      title: "1 pod carries app=ledger, and it is not ready",
    });
    expect(hopTone(crashing.stop)).toBe("bad");
    expect(crashing.path.broken).toBe(true);
  });

  /**
   * Marco's ledger with no address listed at all: the slices say nothing is
   * published, the pods were not read, and the chain drew a red fault
   * beside the Deployment's grey unread verdict. Fails if that stop breaks
   * its path, loses its unread mood or note, or one behind no workload stops
   * being a fault.
   */
  it("draws a stop with nothing published and its pods unread as not checked", () => {
    const front = service("ledger", "app=ledger");
    const subject = ref("Deployment", "ledger", {
      kind: "workload",
      replicas: 1,
      readyReplicas: 0,
      rollout: null,
      revision: null,
      current: null,
    });
    const chainOf = (podsUnread: boolean) => {
      const stop = {
        reason: "publishesNothingYet" as const,
        service: front,
        selector: "app=ledger",
        podsUnread,
      };
      const [path] = trafficChains(
        connections(
          subject,
          [
            {
              from: front,
              to: subject,
              relation: { verb: "selects", selector: "app=ledger" },
            },
          ],
          [stop]
        ),
        t
      );
      return { path, hop: path.hops.at(-1)!, under: stopUnder(stop) };
    };

    const unread = chainOf(true);
    expect(unread.hop).toMatchObject({
      mood: "unchecked",
      title: "Nothing is published behind app=ledger yet",
      note: t("nav", "stopPodsUnreadNote"),
    });
    expect(unread.path.broken).toBe(false);
    expect(unread.under).toBe("podsNotRead");

    const nobody = chainOf(false);
    expect(nobody.hop).toMatchObject({ mood: "fault" });
    expect(nobody.path.broken).toBe(true);
    expect(nobody.under).toBe("stopNothingPublishedYet");
  });

  /**
   * The Service page of hello-web at zero said in red that no pod carries
   * app=hello-web and counted Connections 0, while the Deployment named the
   * Service. Fails if the backend's idle stop is drawn as a fault, or the
   * idle workload drops out of what answers here.
   */
  it("draws a Service in front of a workload scaled to zero calmly and names the workload", () => {
    const front = service("hello-web", "app=hello-web");
    const deployment = ref("Deployment", "hello-web", {
      kind: "workload",
      replicas: 0,
      readyReplicas: 0,
      rollout: { state: "idle" },
      revision: null,
      current: null,
    });
    const conns = connections(
      front,
      [
        {
          from: front,
          to: deployment,
          relation: { verb: "selects", selector: "app=hello-web" },
        },
      ],
      [
        {
          reason: "scaledToZero",
          service: front,
          selector: "app=hello-web",
          workloads: [deployment],
        },
      ]
    );

    const [path] = trafficChains(conns, t);
    const stop = path.hops.at(-1)!;
    expect(stop).toMatchObject({
      at: "stop",
      mood: "idle",
      title: "No pods by intent: hello-web is scaled to zero",
    });
    expect(hopTone(stop)).toBe("on");
    expect(path.broken).toBe(false);

    const answers = connectionGroups(conns, t).find(
      (group) => group.key === "answers"
    );
    expect(answers?.rows.map((row) => row.object?.name)).toEqual(["hello-web"]);
    expect(connectionCount(conns)).toBe(1);
  });

  it("costs one line when nothing fronts the workload", () => {
    /** A Deployment with no Service must not pay for a diagram to say so.
     *  A chain drawn from a single hop would be a rail and a dot saying
     *  what one sentence says. */
    const deployment = ref("Deployment", "quiet-demo");
    const conns = connections(deployment, [
      {
        from: deployment,
        to: pod("quiet-demo-a", true),
        relation: { verb: "selects", selector: "app=quiet-demo" },
      },
    ]);

    expect(trafficChains(conns, t)).toEqual([]);
    expect(chainSilence(conns, t)).toContain("No Service in this namespace");
  });

  it("says an ExternalName resolves elsewhere rather than drawing an empty chain", () => {
    /** A Service with no selector is not a broken one, and calling it a stop
     *  would be an accusation the cluster never made. */
    const svc = ref("Service", "external-demo", {
      kind: "service",
      type: "ExternalName",
      clusterIp: null,
      externalName: "example.com",
      selector: null,
      ports: [],
    });
    const conns = connections(svc, []);

    expect(trafficChains(conns, t)).toEqual([]);
    expect(chainSilence(conns, t)).toContain("example.com");
  });

  /** Marco's checkout-api pod said no Service selects it while the Service
   *  checkout-api was one label short. Fails if the near Service goes
   *  unnamed on a pod or on a workload, or is named beside an unread list. */
  it("names the Service one label short of a subject no Service selects", () => {
    const near = [
      {
        service: ref("Service", "checkout-api"),
        carries: "app=checkout-api",
        lacks: "track=stable",
      },
    ];
    const p = pod("checkout-api-a", true);
    const onPod = chainSilence(
      { ...connections(p, []), nearlySelectedBy: near },
      t
    );
    expect(onPod).toContain("Closest is checkout-api");
    expect(onPod).toContain("carries app=checkout-api but not track=stable");

    const deployment = ref("Deployment", "checkout-api");
    expect(
      chainSilence(
        { ...connections(deployment, []), nearlySelectedBy: near },
        t
      )
    ).toContain("they carry app=checkout-api but not track=stable");

    const unread = [
      {
        kind: "Service",
        why: { says: "unanswered", version: "v1", said: "forbidden" },
      },
    ] as unknown as ResourceConnections["notLookedAt"];
    expect(
      chainSilence(
        { ...connections(p, [], [], unread), nearlySelectedBy: near },
        t
      )
    ).toBeNull();
  });

  /**
   * Every sentence this returns states a negative, and a negative is only
   * ours to state about a list that answered. The guard was tested for a
   * Pod subject alone, so narrowing it to Pods — leaving a Deployment page
   * to say "No Service in this namespace" about Services nobody read —
   * survived the whole suite.
   */
  it("says nothing about Services on any subject when that list went unread", () => {
    const unread = [
      {
        kind: "Service",
        why: { says: "unanswered", version: "v1", said: "forbidden" },
      },
    ] as unknown as ResourceConnections["notLookedAt"];

    const deployment = ref("Deployment", "quiet-demo");
    const withDeployment = connections(
      deployment,
      [
        {
          from: deployment,
          to: pod("quiet-demo-a", true),
          relation: { verb: "selects", selector: "app=quiet-demo" },
        },
      ],
      [],
      unread
    );
    expect(chainSilence(withDeployment, t)).toBeNull();

    const p = pod("quiet-demo-a", true);
    expect(chainSilence(connections(p, [], [], unread), t)).toBeNull();
  });
});

describe("the groups", () => {
  const mount: Usage = {
    how: "mount",
    container: "app",
    path: "/etc/app",
    readOnly: false,
    subPath: null,
    volume: "config",
    projected: false,
  };
  const env: Usage = {
    how: "env",
    container: "app",
    name: "APP_MESSAGE",
    key: "app.conf",
    optional: false,
    keyPresent: null,
  };

  it("phrases a usage from what the backend sent, not from the pod spec", () => {
    /** `Usage` carries the path and the key. Rebuilding "mounted at /etc/app"
     *  from a volume list is how the two spellings drift apart. */
    expect(describeUsages([mount, env], t)).toEqual([
      "mounted at /etc/app, and APP_MESSAGE reads app.conf",
    ]);
  });

  /**
   * The environment clause was a template literal with an English verb,
   * so the Connections tab and every shared report read
   * "APP_PASSWORD reads password" between Russian clauses.
   */
  it("says which key a variable reads in the reader's language", () => {
    const ru: T = (section, key, values) =>
      translate("ru", section, key, values);
    expect(describeUsages([mount, env], ru)).toEqual([
      "смонтирован в /etc/app и APP_MESSAGE читает ключ app.conf",
    ]);
  });

  it("breaks a pile of usages into lines and names the containers", () => {
    /** A ConfigMap mounted by two containers at the same path, read as an
     *  environment variable and imported wholesale is five clauses in one
     *  sentence. Lines make it readable — and the two containers mounting
     *  one path share a line rather than printing that path twice. */
    expect(
      describeUsages(
        [
          mount,
          { ...mount, container: "seed" },
          env,
          { how: "envFrom", container: "app" },
        ],
        t
      )
    ).toEqual([
      "app, seed · mounted at /etc/app",
      "app · APP_MESSAGE reads app.conf",
      "app · every key becomes an environment variable",
    ]);
  });

  it("says one mount once, however many containers make it", () => {
    /** The service-account volume, which every container of every pod in
     *  the cluster mounts read-only at the longest path in Kubernetes. One
     *  line per container printed that path once per container, and the
     *  containers are left off a line no other line contends with. */
    expect(
      describeUsages(
        [
          { ...mount, container: "ingest", projected: true, readOnly: true },
          { ...mount, container: "web", projected: true, readOnly: true },
        ],
        t
      )
    ).toEqual(["projected into /etc/app, read-only"]);
  });

  it("keeps two mounts of one path apart where they differ", () => {
    /** An init container that writes what the app container only reads is
     *  two mounts, not one: grouping keys on what the line says, so the
     *  read-only flag splits them and the containers say which is which. */
    expect(
      describeUsages(
        [
          { ...mount, container: "seed" },
          { ...mount, readOnly: true },
        ],
        t
      )
    ).toEqual([
      "seed · mounted at /etc/app",
      "app · mounted at /etc/app, read-only",
    ]);
  });

  it("asks what this needs to run rather than listing kinds", () => {
    /** Grouping by kind is the pile this replaces: a ConfigMap and a claim
     *  are both "needs to run", under the two different labels a reader
     *  would look for them by. */
    const deployment = ref("Deployment", "mounts-demo");
    const groups = connectionGroups(
      connections(deployment, [
        {
          from: deployment,
          to: ref("ConfigMap", "demo-config", null, "notChecked"),
          relation: { verb: "uses", usages: [mount, env] },
        },
        {
          from: deployment,
          to: ref("PersistentVolumeClaim", "pvc-demo", {
            kind: "claim",
            phase: "Bound",
            capacity: "1Gi",
            storageClass: "local-path",
          }),
          relation: {
            verb: "uses",
            usages: [{ ...mount, path: "/var/lib/data" }],
          },
        },
      ]),
      t
    );

    const needs = groups.find((group) => group.key === "needs");
    expect(needs?.rows.map((row) => row.label)).toEqual([
      "Configuration",
      "Storage",
    ]);
    expect(needs?.rows[1].ways).toEqual(["mounted at /var/lib/data"]);
    expect(needs?.rows[1].detail).toBe("1Gi · local-path · Bound");
  });

  it("names the kinds nobody asked about", () => {
    /** An empty group that is simply not drawn tells the reader "there is no
     *  HPA on this Deployment" — a claim the app cannot make, because it
     *  never asked. */
    const groups = connectionGroups(
      connections(
        ref("Deployment", "log-demo"),
        [],
        [],
        [
          {
            kind: "HorizontalPodAutoscaler",
            why: { says: "unanswered", version: "autoscaling/v2", said: "404" },
          },
        ]
      ),
      t
    );

    const unasked = groups.find((group) => group.key === "unasked");
    expect(unasked?.rows).toHaveLength(1);
    expect(unasked?.rows[0].label).toBe("Autoscaling");
    expect(unasked?.rows[0].unasked).toBe(true);
  });

  const usedByOf = (keyPresent: boolean | null) => {
    const secret = ref("Secret", "checkout-db");
    const worker = ref("Deployment", "checkout-worker");
    const groups = connectionGroups(
      connections(secret, [
        {
          from: worker,
          to: secret,
          relation: {
            verb: "uses",
            usages: [
              { ...env, name: "DB_PASSWORD", key: "DB_PASSWORD", keyPresent },
            ],
          },
        },
      ]),
      t
    );
    return groups.find((group) => group.key === "used-by")?.rows[0];
  };

  /** The Secret's Connections tab listed checkout-worker as an ordinary user
   *  of a key the Secret does not hold. */
  it("marks a user that reads a key the subject does not hold", () => {
    expect(usedByOf(false)?.missingKeys).toEqual([
      { key: "DB_PASSWORD", optional: false, from: "Secret" },
    ]);
  });

  /** A Secret the session could not read says nothing about its keys, so a
   *  user of it must not be drawn broken. */
  it("does not mark a user whose key was never checked", () => {
    expect(usedByOf(null)?.missingKeys).toBeUndefined();
    expect(usedByOf(true)?.missingKeys).toBeUndefined();
  });

  const needsOf = (keyPresent: boolean | null) => {
    const secret = ref("Secret", "checkout-db");
    const worker = ref("Pod", "checkout-worker-7db8bc9ffd-km5ft");
    const groups = connectionGroups(
      connections(worker, [
        {
          from: worker,
          to: secret,
          relation: {
            verb: "uses",
            usages: [
              { ...env, name: "DB_PASSWORD", key: "DB_PASSWORD", keyPresent },
            ],
          },
        },
      ]),
      t
    );
    return groups.find((group) => group.key === "needs")?.rows[0];
  };

  /** The worker pod's and Deployment's Connections drew checkout-db as fine
   *  while the Secret's own tab said the key is not there. */
  it("marks a needed object that lacks the key on the user's side as on the object's", () => {
    expect(needsOf(false)?.missingKeys).toEqual([
      { key: "DB_PASSWORD", optional: false, from: "Secret" },
    ]);
    expect(needsOf(false)?.missingKeys).toEqual(usedByOf(false)?.missingKeys);
    expect(needsOf(null)?.missingKeys).toBeUndefined();
  });
});

describe("a governing edge says which query reached it", () => {
  const budget = (): ObjectRef =>
    ref("PodDisruptionBudget", "expr-demo", {
      kind: "budget",
      minAvailable: "1",
      maxUnavailable: null,
      disruptionsAllowed: 1,
      currentHealthy: 2,
      desiredHealthy: 1,
      expectedPods: 2,
      conditions: [],
    });

  it("prints the set-based form rather than the half of it that fits a map", () => {
    /** A budget names no workload. The selector is the only statement of why
     *  it applies here, and a `matchExpressions` one printed as `app=` — or
     *  as nothing — is a partial truth about which pods it will refuse to
     *  let go. */
    const subject = ref("Deployment", "expr-demo");
    const groups = connectionGroups(
      connections(subject, [
        {
          from: budget(),
          to: subject,
          relation: {
            verb: "governs",
            selector: "app in (expr-demo),track notin (canary)",
          },
        },
      ]),
      t
    );

    const row = groups.find((group) => group.key === "governs")?.rows[0];
    expect(row?.label).toBe("Disruption budget");
    expect(row?.ways).toEqual([
      "matched app in (expr-demo),track notin (canary)",
    ]);
  });

  it("keeps naming the far end where it is not the subject", () => {
    /** On a node, one budget covers one pod, and which pod is the whole
     *  question a drain asks. The selector joins that line, it does not
     *  replace it. */
    const node: ObjectRef = {
      kind: "Node",
      name: "server-0",
      namespace: null,
      existence: "present",
      facts: null,
    };
    const groups = connectionGroups(
      connections(node, [
        {
          from: budget(),
          to: pod("expr-demo-a", true),
          relation: { verb: "governs", selector: "app in (expr-demo)" },
        },
      ]),
      t
    );

    expect(
      groups.find((group) => group.key === "governs")?.rows[0].ways
    ).toEqual(["protects Pod expr-demo-a", "matched app in (expr-demo)"]);
  });
});

describe("a node, which is the same edge read from the other end", () => {
  const node = (podCapacity: number | null = 110): ObjectRef => ({
    kind: "Node",
    name: "server-0",
    namespace: null,
    existence: "present",
    facts: {
      kind: "node",
      schedulable: true,
      podCapacity,
      cpu: "4",
      memory: "8Gi",
    },
  });

  const placed = (name: string, namespace: string): ConnectionEdge => ({
    from: { ...pod(name, true), namespace },
    to: node(),
    relation: { verb: "runsOn" },
  });

  it("lists the pods on it, in every namespace, labelled by the one they are in", () => {
    /** The defect this closes: the command defaulted a missing namespace to
     *  `default`, so a Node answered with one namespace's pods and would
     *  have drawn that as the whole answer. */
    const groups = connectionGroups(
      connections(node(), [
        placed("log-demo-a", "k8s-gui-test"),
        placed("coredns-x", "kube-system"),
        placed("log-demo-b", "k8s-gui-test"),
      ]),
      t
    );

    const here = groups.find((group) => group.key === "placed");
    expect(here?.title).toBe("What runs here");
    // Sorted by namespace, and the label written once per namespace.
    expect(here?.rows.map((row) => [row.label, row.object?.name])).toEqual([
      ["k8s-gui-test", "log-demo-a"],
      ["", "log-demo-b"],
      ["kube-system", "coredns-x"],
    ]);
    expect(here?.caption).toBe(
      "3 pods across 2 namespaces, of the 110 this node will take · 4 CPU · 8Gi"
    );
  });

  /**
   * A Node's and a workload's Connections drew a crash-looping pod caught
   * between crashes as a plain Running, where the Pods list says it is up
   * between crashes. Fails if the row drops what the list says, or says it
   * of a pod whose last exit is past the loop's window.
   */
  it("says a pod is up between crashes where the Pods list does", () => {
    const at = (secondsAgo: number): ConnectionEdge => ({
      from: {
        ...pod("checkout-wz5f8", false),
        facts: {
          kind: "pod",
          phase: "Running",
          display: "Running",
          ready: false,
          loopingUntil: new Date(
            Date.now() + CRASH_LOOP_WINDOW_MS - secondsAgo * 1000
          ).toISOString(),
          exitUnreported: false,
        },
      },
      to: node(),
      relation: { verb: "runsOn" },
    });
    const detail = (edge: ConnectionEdge) =>
      connectionGroups(connections(node(), [edge]), t).find(
        (group) => group.key === "placed"
      )?.rows[0].detail;
    expect(detail(at(5))).toBe("Running · up between crashes");
    expect(detail(at(3600))).toBe("Running");
  });

  /**
   * Sam's checkout pod with fifteen restarts read plain Running while the
   * kubelet reported no last exit. Fails if Connections calls such a pod
   * Running and nothing more, or says it of one never restarted.
   */
  it("says a restarted pod's last exit was not reported where the kubelet gave none", () => {
    const placedPod = (exitUnreported: boolean): ConnectionEdge => ({
      from: {
        ...pod("checkout-fwk7g", true),
        facts: {
          kind: "pod",
          phase: "Running",
          display: "Running",
          ready: true,
          loopingUntil: null,
          exitUnreported,
        },
      },
      to: node(),
      relation: { verb: "runsOn" },
    });
    const detail = (edge: ConnectionEdge) =>
      connectionGroups(connections(node(), [edge]), t).find(
        (group) => group.key === "placed"
      )?.rows[0].detail;
    expect(detail(placedPod(true))).toBe("Running · last exit not reported");
    expect(detail(placedPod(false))).toBe("Running");
  });

  /** The tally was an English template literal under a Russian title. */
  it("counts the pods on it in the reader's language", () => {
    const ru: T = (section, key, values) =>
      translate("ru", section, key, values);
    const groups = connectionGroups(
      connections(node(), [
        placed("log-demo-a", "k8s-gui-test"),
        placed("coredns-x", "kube-system"),
      ]),
      ru
    );
    expect(groups.find((group) => group.key === "placed")?.caption).toContain(
      "2 пода в 2 пространствах имён, из 110 возможных на этом узле"
    );
  });

  it("says cordoned rather than drawing the room as available", () => {
    const cordoned: ObjectRef = {
      ...node(),
      facts: {
        kind: "node",
        schedulable: false,
        podCapacity: 110,
        cpu: "4",
        memory: "8Gi",
      },
    };
    const groups = connectionGroups(
      connections(cordoned, [placed("log-demo-a", "k8s-gui-test")]),
      t
    );
    expect(groups.find((group) => group.key === "placed")?.caption).toContain(
      "cordoned"
    );
  });

  it("still reads a pod's own page outwards", () => {
    /** One verb, two directions, and the pod page must not start listing
     *  itself under "What runs here". */
    const groups = connectionGroups(
      connections(ref("Pod", "log-demo-a"), [
        {
          from: ref("Pod", "log-demo-a"),
          to: node(),
          relation: { verb: "runsOn" },
        },
      ]),
      t
    );
    const placement = groups.find((group) => group.key === "placement");
    expect(placement?.title).toBe("Runs on");
    expect(placement?.rows[0].object?.name).toBe("server-0");
    expect(placement?.rows[0].detail).toBe("4 CPU · 8Gi");
  });
});

describe("what the Service publishes", () => {
  /**
   * The defect this replaced. A pod draining is `serving: true, ready: false`
   * and is exactly the address kube-proxy falls back to when nothing ready is
   * left — so a Service down to one of them is a rolling restart, not an
   * outage. Would break the moment the last hop goes back to counting `Ready`.
   */
  it("reads a draining endpoint as draining rather than as an outage", () => {
    const deployment = ref("Deployment", "draining-demo");
    const svc = service("draining-demo", "app=draining-demo");
    const path = trafficChains(
      connections(
        deployment,
        [
          {
            from: svc,
            to: deployment,
            relation: { verb: "selects", selector: "app=draining-demo" },
          },
        ],
        [],
        [],
        [
          publishes(
            "draining-demo",
            { ready: 0, draining: 1 },
            {
              endpoints: [
                endpointOf("draining-demo-a", {
                  ready: false,
                  serving: true,
                  terminating: true,
                }),
              ],
            }
          ),
        ]
      ),
      t
    )[0];

    expect(path.broken).toBe(false);
    const last = path.hops[path.hops.length - 1];
    if (last.at !== "published") throw new Error("expected the published hop");
    expect(last.tone).toBe("warn");
    expect(last.summary).toContain("1 draining");
    expect(last.summary).toContain("still taking traffic");
    expect(last.summary).not.toContain("not ready");
  });

  /**
   * The case worth building the whole thing for: a healthy selector, healthy
   * pods, a green everything, and no traffic. The reason is derived from two
   * things the app already holds — the `targetPort` the Service asks for and
   * the port names the containers declare — so it is named rather than left
   * as "it does not work".
   */
  it("names the port a Service asks for that no container declares", () => {
    const said = describeStop(
      {
        reason: "publishesNothing",
        service: service("named-port-demo", "app=named-port-demo"),
        selector: "app=named-port-demo",
        pods: 2,
        readyPods: 2,
        unnamedPorts: ["http"],
      },
      t
    );

    expect(said.title).toBe("This Service publishes no endpoint");
    expect(said.note).toContain("2 pods match its selector");
    expect(said.note).toContain("all of them are Ready");
    expect(said.note).toContain("targetPort: http");
    expect(said.note).toContain("Name the port in the container");
  });

  /**
   * topology-demo: Pending, no node, no address, an empty slice. The note
   * told the reader to debug a readiness probe on running pods. Fails if
   * the reason the backend read stops choosing the sentence.
   */
  it("says pods with no node are unscheduled, not failing a probe", () => {
    const stop = (why: NotServing): ChainStop => ({
      reason: "noneReady",
      service: service("topology-demo", "app=topology-demo"),
      selector: "app=topology-demo",
      pods: 2,
      why,
    });
    const pending = describeStop(stop("unscheduled"), t).note;
    expect(pending).toContain("Pending with no node");
    expect(pending).not.toContain("readiness probe");
    expect(describeStop(stop("failingReadiness"), t).note).toContain(
      "readiness probe"
    );

    const notes = (
      [
        "unscheduled",
        "starting",
        "crashLooping",
        "terminating",
        "failingReadiness",
        "finished",
        "mixed",
        "other",
        "inSlices",
      ] satisfies NotServing[]
    ).map((why) => describeStop(stop(why), t).note);
    expect(new Set(notes).size).toBe(notes.length);
    for (const note of notes) expect(note).not.toContain("list page");
  });
  /**
   * Lena read "трафик отклоняется, пока они работают" (refused while they
   * run) and "Что получила проверка" as machine Russian. Fails if either
   * comes back.
   */
  it("says in Russian that traffic is refused until the pods are ready", () => {
    const ru: T = (section, key, values) =>
      translate("ru", section, key, values);
    const note = describeStop(
      {
        reason: "noneReady",
        service: service("unready-demo", "app=unready-demo"),
        selector: "app=unready-demo",
        pods: 2,
        why: "failingReadiness",
      },
      ru
    ).note;
    expect(note).toContain("трафик отклоняется, пока они не готовы.");
    expect(note).toContain(
      "Почему проверка не проходит, видно в событиях подов."
    );
  });

  /** Three stops about routes were English literals, so a Russian screen
   *  printed "gwtest-edge does not accept this route" in English. */
  it("words every route stop through the catalogue", () => {
    const keyed: T = (section, key) => `${String(section)}.${String(key)}`;
    const stops: ChainStop[] = [
      {
        reason: "routeNotAccepted",
        route: ref("HTTPRoute", "r"),
        gateway: ref("Gateway", "g"),
        conditionReason: "NotAllowedByListeners",
        message: "no",
      },
      {
        reason: "routeRefsUnresolved",
        route: ref("HTTPRoute", "r"),
        conditionReason: "RefNotPermitted",
        message: null,
      },
      {
        reason: "routeRefsUnresolved",
        route: ref("HTTPRoute", "r"),
        conditionReason: "BackendNotFound",
        message: null,
      },
      {
        reason: "gatewayMissing",
        route: ref("HTTPRoute", "r"),
        gateway: ref("Gateway", "g"),
      },
    ];
    for (const stop of stops) {
      const said = describeStop(stop, keyed);
      expect(said.title).toMatch(/^nav\.stop/);
      expect(said.note).toMatch(/^nav\.stop/);
    }
    expect(describeStop(stops[1], keyed).title).toBe(
      "nav.stopRefNotPermittedTitle"
    );
    expect(describeStop(stops[2], keyed).title).toBe(
      "nav.stopRefUnresolvedTitle"
    );
  });

  /** And it declines to explain what it cannot see. A pod missing from every
   *  slice for a reason nothing states gets no invented cause. */
  it("says only what it holds when the reason is not derivable", () => {
    const said = describeStop(
      {
        reason: "publishesNothing",
        service: service("mystery", "app=mystery"),
        selector: "app=mystery",
        pods: 1,
        readyPods: 1,
        unnamedPorts: [],
      },
      t
    );

    expect(said.note).toContain("These objects do not say why");
    expect(said.note).not.toContain("targetPort");
  });

  /**
   * The app reads EndpointSlices now, so nothing may name them as unread. A
   * page saying "the app does not look at this" beside a list drawn from it
   * is worse than the gap it replaced.
   */
  it("never names EndpointSlice as a kind it did not look at", () => {
    const groups = connectionGroups(
      connections(
        ref("Service", "log-demo"),
        [],
        [],
        [
          {
            kind: "EndpointSlice",
            why: { says: "volumeMountsNotRead" },
          },
        ]
      ),
      t
    );

    const unasked = groups.find((group) => group.key === "unasked");
    expect(unasked?.rows.map((row) => row.label)).not.toContain("Endpoints");
    expect(unasked?.rows[0].label).toBe("EndpointSlice");
  });
});

/**
 * The route from a pod to the object whose replica count it is one of.
 *
 * A pod is not scalable and gets no Scale control anywhere. What it gets is
 * a chain that says which of its two owners is worth opening, and that is
 * the only place in the app where the answer to "where do I set the count"
 * is a link rather than a control.
 */
describe("where a pod's replica count is really set", () => {
  const owns = (from: ObjectRef, to: ObjectRef): ConnectionEdge => ({
    from,
    to,
    relation: { verb: "owns", controller: true },
  });

  const ownerRows = (subject: ObjectRef, edges: ConnectionEdge[]) =>
    connectionGroups(connections(subject, edges), t).find(
      (group) => group.key === "owners"
    )?.rows ?? [];

  it("marks the top of the chain, not the revision under it", () => {
    const pod = ref("Pod", "crash-demo-c688f57cf-abcde");
    const rs = ref("ReplicaSet", "crash-demo-c688f57cf");
    const deployment = ref("Deployment", "crash-demo");
    const rows = ownerRows(pod, [owns(rs, pod), owns(deployment, rs)]);

    expect(rows[0].object?.name).toBe("crash-demo-c688f57cf");
    expect(rows[0].detail ?? "").not.toContain("replica count");
    expect(rows[1].object?.name).toBe("crash-demo");
    expect(rows[1].detail).toContain("the replica count is set here");
  });

  it("says it of a StatefulSet's pod too — one hop is the whole chain", () => {
    const pod = ref("Pod", "stateful-demo-0");
    const set = ref("StatefulSet", "stateful-demo");
    const rows = ownerRows(pod, [owns(set, pod)]);

    expect(rows[0].detail).toContain("the replica count is set here");
  });

  /**
   * An OpenKruise StatefulSet is not the apps/v1 kind its name says, and its
   * page has no Scale control. Judged by the name, the clause sent the
   * reader to one.
   */
  it("stays quiet where the top of the chain is a namesake from another group", () => {
    const pod = ref("Pod", "kruise-db-0");
    const set = { ...ref("StatefulSet", "kruise-db"), group: "apps.kruise.io" };
    const builtIn = { ...ref("StatefulSet", "db"), group: "apps" };

    expect(ownerRows(pod, [owns(set, pod)])[0].detail ?? "").not.toContain(
      "replica count"
    );
    expect(ownerRows(pod, [owns(builtIn, pod)])[0].detail).toContain(
      "the replica count is set here"
    );
  });

  /**
   * A DaemonSet has no replica count to set, and a Job's parallelism is not
   * one either. Pointing at them would send the reader to a page with no
   * control on it.
   */
  it("stays quiet where the top of the chain cannot be scaled", () => {
    const pod = ref("Pod", "node-agent-xk29f");
    const ds = ref("DaemonSet", "node-agent");
    const rows = ownerRows(pod, [owns(ds, pod)]);

    expect(rows[0].detail ?? "").not.toContain("replica count");
  });

  /**
   * The owner row said "Stalled · 0/2 готовы" in a Russian tab, the app's own
   * verdict in the cluster's language. Fails if the row goes back to the code.
   */
  it("words an owner's rollout verdict in the reader's language", () => {
    const ru: T = (section, key, values) =>
      translate("ru", section, key, values);
    const pod = ref("Pod", "crash-demo-c688f57cf-abcde");
    const deployment = ref("Deployment", "crash-demo", {
      kind: "workload",
      replicas: 2,
      readyReplicas: 0,
      rollout: { state: "stalled", message: null, serving: 0 },
      revision: null,
      current: null,
    });
    const rows =
      connectionGroups(connections(pod, [owns(deployment, pod)]), ru).find(
        (group) => group.key === "owners"
      )?.rows ?? [];
    expect(rows[0].detail).toContain("Застрял · готовы 0 из 2");
    expect(rows[0].detail).not.toContain("Stalled");
  });

  /** A Russian Connections tab labelled its children "Revisions" and "Runs". */
  it("labels a Deployment's revisions in the reader's language", () => {
    const ru: T = (section, key, values) =>
      translate("ru", section, key, values);
    const deployment = ref("Deployment", "crash-demo");
    const rs = ref("ReplicaSet", "crash-demo-c688f57cf");
    const rows =
      connectionGroups(connections(deployment, [owns(deployment, rs)]), ru)
        .find((group) => group.key === "owners")
        ?.rows.filter((row) => row.object?.kind === "ReplicaSet") ?? [];
    expect(rows.map((row) => row.label)).toEqual(["Ревизии"]);
  });
});

describe("a list the cluster refused", () => {
  const pod = (): ResourceConnections => ({
    subject: {
      kind: "Pod",
      name: "shell-demo",
      namespace: "shop",
      existence: "present",
      facts: null,
    },
    edges: [],
    stops: [],
    published: [],
    notLookedAt: [],
  });

  /**
   * "No Service selects this pod" is a statement about the cluster, and it is
   * only ours to make about a list that answered. With Services unread it is
   * the app reporting its own blind spot as a fact, which is the failure this
   * whole module is organised against.
   */
  it("says nothing about Services nobody was allowed to read", () => {
    const conns = pod();
    conns.notLookedAt = [
      {
        kind: "Service",
        why: {
          says: "unanswered",
          version: "v1",
          said: "services is forbidden: User cannot list resource",
        },
      },
    ];
    expect(chainSilence(conns, t)).toBeNull();
  });

  it("still says so when the Services really were read", () => {
    expect(chainSilence(pod(), t)).not.toBeNull();
  });
});

describe("connections read the same from both ends", () => {
  const deployment = ref("Deployment", "log-demo");
  const replicas = ref("ReplicaSet", "log-demo-84c4d9749c");
  const running = pod("log-demo-84c4d9749c-c7s72", true);
  const front = service("log-demo", "app=log-demo");
  const ingress = ref("Ingress", "log-demo");
  const selects = { verb: "selects", selector: "app=log-demo" } as const;
  const routes = {
    verb: "routes",
    host: "logs.k8s-gui.test",
    path: "/",
    pathType: "Prefix",
    port: "80",
    tls: false,
  } as const;
  const names = (conns: ResourceConnections, group: string) =>
    connectionGroups(conns, t)
      .find((g) => g.key === group)
      ?.rows.map((row) => `${row.object?.kind}/${row.object?.name}`);

  /**
   * Sam's Service log-demo listed Deployment log-demo while the Deployment's
   * Connections had no Service row. Fails if either end stops naming the other.
   */
  it("names the Service on the Deployment that the Service names", () => {
    const fromService = connections(front, [
      { from: front, to: running, relation: selects },
      {
        from: replicas,
        to: running,
        relation: { verb: "owns", controller: true },
      },
      {
        from: deployment,
        to: replicas,
        relation: { verb: "owns", controller: true },
      },
      { from: ingress, to: front, relation: routes },
    ]);
    const fromDeployment = connections(deployment, [
      { from: front, to: deployment, relation: selects },
      { from: ingress, to: front, relation: routes },
      { from: deployment, to: running, relation: selects },
    ]);

    expect(names(fromService, "answers")).toEqual(["Deployment/log-demo"]);
    expect(names(fromDeployment, "reached")).toEqual([
      "Service/log-demo",
      "Ingress/log-demo",
    ]);
  });

  /**
   * Sam's Service log-demo Connections listed only its Deployment while its
   * Delete dialog named the Ingresses routing to it. Fails if the tab drops them.
   */
  it("names on a Service every Ingress and route its Delete dialog leaves behind", () => {
    const canary = ref("Ingress", "promo-nginx-canary");
    const http = ref("HTTPRoute", "log-demo");
    const fromService = connections(front, [
      { from: front, to: running, relation: selects },
      { from: ingress, to: front, relation: routes },
      { from: canary, to: front, relation: routes },
      {
        from: http,
        to: front,
        relation: {
          verb: "ruleRoutes",
          hostnames: ["logs.k8s-gui.test"],
          port: null,
          weight: null,
        },
      },
    ]);

    const routed = [
      "Ingress/log-demo",
      "Ingress/promo-nginx-canary",
      "HTTPRoute/log-demo",
    ];
    expect(names(fromService, "routed")).toEqual(routed);
    expect(
      dependentsOf(fromService, t).map(
        ({ object }) => `${object.kind}/${object.name}`
      )
    ).toEqual(routed);
  });

  /** A Service with no pods behind it says nothing on a workload it does not select. */
  it("leaves the group out where no Service selects the workload", () => {
    expect(names(connections(deployment, []), "reached")).toBeUndefined();
  });
});

describe("what a delete leaves pointing at the object", () => {
  const config = ref("ConfigMap", "app-config");
  const web = ref("Deployment", "web");
  const conns = (edges: ConnectionEdge[]): ResourceConnections => ({
    subject: config,
    edges,
    stops: [],
    published: [],
    notLookedAt: [],
  });

  /**
   * A pod or workload reading the ConfigMap stays and fails its next start.
   * Fails if a reader is dropped, or named twice for two ways it reads.
   */
  it("names each reader once, with every way it reads", () => {
    const env: Usage = {
      how: "env",
      container: "app",
      name: "APP_MESSAGE",
      key: "app.conf",
      optional: false,
      keyPresent: true,
    };
    const found = dependentsOf(
      conns([
        { from: web, to: config, relation: { verb: "uses", usages: [env] } },
        {
          from: web,
          to: config,
          relation: {
            verb: "uses",
            usages: [{ how: "envFrom", container: "app" }],
          },
        },
      ]),
      t
    );
    expect(found.map((dependent) => dependent.object.name)).toEqual(["web"]);
    expect(found[0].ways).toHaveLength(2);
  });

  /**
   * An autoscaler names its target, so it breaks; a budget matched labels
   * and an owner is the cascade's. Fails if either of the last two is named.
   */
  it("names an autoscaler aimed at it, and not a budget or an owner", () => {
    const deployment = ref("Deployment", "web");
    const found = dependentsOf(
      {
        ...conns([
          {
            from: ref("HorizontalPodAutoscaler", "web"),
            to: deployment,
            relation: { verb: "governs", selector: null },
          },
          {
            from: ref("PodDisruptionBudget", "web"),
            to: deployment,
            relation: { verb: "governs", selector: "app=web" },
          },
          {
            from: deployment,
            to: ref("ReplicaSet", "web-1"),
            relation: { verb: "owns", controller: true },
          },
        ]),
        subject: deployment,
      },
      t
    );
    expect(found.map((dependent) => dependent.object.kind)).toEqual([
      "HorizontalPodAutoscaler",
    ]);
  });
});
