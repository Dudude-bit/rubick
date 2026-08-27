import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { describe, expect, it } from "vitest";

/** The English catalogue — what these expectations are written in. */
const t: T = (section, key, values) => translate("en", section, key, values);

import {
  chainSilence,
  connectionGroups,
  describeStop,
  describeUsages,
  trafficChains,
} from "./connections";
import type {
  ChainStop,
  PublishedEndpoint,
  ServicePublished,
  ConnectionEdge,
  ObjectFacts,
  ObjectRef,
  ResourceConnections,
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
  ports: [],
  endpoints: [],
  whole: true,
  unpublished: [],
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
    expect(routeHopDrawn.via).toBe(
      "weight 0 — deliberately receives no traffic"
    );
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
    expect(route.publishedAt).toEqual(["203.0.113.10"]);
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
    expect(first.publishedAt).toBeNull();

    const read = trafficChains(connections(deployment, edges), t, {
      routing: new Map([
        [
          "Ingress/k8s-gui-test/log-demo",
          { tls: [], binding: null, addresses: [] },
        ],
      ]),
    })[0];
    const hop = read.hops[0];
    if (hop.at !== "object") throw new Error("expected the Ingress hop");
    expect(hop.publishedAt).toEqual([]);
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
        { reason: "selectsNothing", service: svc, selector: "app=tls-demo" },
        { reason: "noneReady", service: svc, selector: "app=x", pods: 2 },
      ] satisfies ChainStop[]
    ).map((stop) => describeStop(stop, t).title);

    expect(new Set(titles).size).toBe(3);
    expect(titles[0]).toContain("No Service named demo");
    expect(titles[1]).toBe("No pod carries app=tls-demo");
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
  };

  it("phrases a usage from what the backend sent, not from the pod spec", () => {
    /** `Usage` carries the path and the key. Rebuilding "mounted at /etc/app"
     *  from a volume list is how the two spellings drift apart. */
    expect(describeUsages([mount, env], t)).toEqual([
      "mounted at /etc/app, and APP_MESSAGE reads app.conf",
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
            why: "the app does not read HorizontalPodAutoscalers, so it cannot say whether one scales this",
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
      "— 3 pods across 2 namespaces, of the 110 this node will take · 4 CPU · 8.0 GB"
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
    expect(placement?.rows[0].detail).toBe("4 CPU · 8.0 GB");
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

    expect(said.note).toContain("not something these objects state");
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
            why: "readiness here is each pod's own Ready condition",
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
});
