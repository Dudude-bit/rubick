import { describe, expect, it } from "vitest";

import type {
  CustomResourceInfo,
  ServicePublished,
  IngressClassSummary,
  IngressInfo,
  ServiceInfo,
} from "@/generated/types";
import {
  allRoutes,
  hostGroups,
  middlewareUses,
  readEntryPoints,
  type TraefikSources,
} from "./model";

const TRAEFIK_CLASS: IngressClassSummary = {
  name: "traefik",
  controller: "traefik.io/ingress-controller",
  isDefault: true,
};

const NGINX_CLASS: IngressClassSummary = {
  name: "nginx",
  controller: "k8s.io/ingress-nginx",
  isDefault: false,
};

function ingress(
  name: string,
  host: string,
  options: {
    className?: string | null;
    path?: string;
    service?: string;
    secretName?: string;
    annotations?: Record<string, string>;
  } = {}
): IngressInfo {
  return {
    name,
    namespace: "shop",
    className: options.className === undefined ? "traefik" : options.className,
    rules: [
      {
        host,
        paths: [
          {
            path: options.path ?? "/",
            pathType: "Prefix",
            backendService: options.service ?? "web",
            backendPort: "80",
            resourceBackend: null,
          },
        ],
      },
    ],
    loadBalancerIps: [],
    tlsHosts: options.secretName ? [host] : [],
    tlsConfigs: options.secretName
      ? [{ hosts: [host], secretName: options.secretName, isCatchAll: false }]
      : [],
    hasCatchAllTls: false,
    defaultBackend: null,
    labels: {},
    annotations: options.annotations ?? {},
    createdAt: null,
  };
}

function ingressRoute(
  name: string,
  spec: Record<string, unknown>
): CustomResourceInfo {
  return {
    name,
    namespace: "shop",
    uid: name,
    apiVersion: "traefik.io/v1alpha1",
    kind: "IngressRoute",
    spec,
    status: null,
    labels: {},
    annotations: {},
    createdAt: null,
    ownerReferences: [],
  };
}

function middleware(name: string, spec: Record<string, unknown>) {
  return { ...ingressRoute(name, spec), kind: "Middleware" };
}

function service(name: string, selector: Record<string, string>): ServiceInfo {
  return {
    name,
    namespace: "shop",
    uid: name,
    type: "ClusterIP",
    sessionAffinity: "None",
    clusterIp: "10.0.0.1",
    externalIps: [],
    loadBalancerIps: [],
    ports: [],
    selector,
    labels: {},
    annotations: {},
    createdAt: null,
  };
}

function published(
  name: string,
  ready: number,
  notReady = 0,
  extra: Partial<ServicePublished> = {}
): ServicePublished {
  return {
    service: {
      kind: "Service",
      name,
      namespace: "shop",
      existence: "present",
      facts: null,
    },
    source: "slices",
    slices: 1,
    ready,
    draining: 0,
    notReady,
    unrouted: 0,
    ports: [],
    endpoints: [],
    whole: true,
    unpublished: [],
    ...extra,
  };
}

function sources(over: Partial<TraefikSources> = {}): TraefikSources {
  return {
    ingresses: [],
    ingressRoutes: [],
    classes: [TRAEFIK_CLASS, NGINX_CLASS],
    services: [],
    published: [],
    middlewares: [],
    entryPoints: [],
    ...over,
  };
}

describe("which objects are this Traefik's", () => {
  /**
   * The correction the whole page rests on. Would break if the routing table
   * went back to reading CRDs only: k3d ships Traefik as *the* ingress
   * controller, so a page that ignored plain Ingresses would be empty on the
   * machine it is developed on and wrong on most real clusters.
   */
  it("serves plain Ingresses as well as IngressRoutes", () => {
    const routes = allRoutes(
      sources({
        ingresses: [ingress("shop", "shop.example.com")],
        ingressRoutes: [
          ingressRoute("promo", {
            entryPoints: ["websecure"],
            routes: [
              {
                match: "Host(`promo.example.com`)",
                services: [{ name: "promo-web", port: 80 }],
              },
            ],
          }),
        ],
      })
    );

    expect(routes.map((route) => route.clause.host)).toEqual([
      "shop.example.com",
      "promo.example.com",
    ]);
    expect(routes.map((route) => route.source.kind)).toEqual([
      "Ingress",
      "IngressRoute",
    ]);
  });

  /**
   * Would break if the page started drawing every Ingress in the cluster.
   * `216c51b` put the controller on the IngressClass precisely so this can
   * be answered rather than guessed, and an ingress-nginx route on Traefik's
   * page would send somebody to debug the wrong proxy.
   */
  it("leaves an Ingress whose class another controller claims", () => {
    const routes = allRoutes(
      sources({
        ingresses: [
          ingress("mine", "a.example.com"),
          ingress("theirs", "b.example.com", { className: "nginx" }),
        ],
      })
    );

    expect(routes.map((route) => route.clause.host)).toEqual(["a.example.com"]);
  });

  /**
   * Would break if an Ingress naming no class stopped being claimed by the
   * cluster's default one — which is how most Ingresses on a k3d cluster are
   * actually served.
   */
  it("claims an Ingress with no class when Traefik owns the default", () => {
    const routes = allRoutes(
      sources({
        ingresses: [ingress("bare", "c.example.com", { className: null })],
      })
    );

    expect(routes).toHaveLength(1);
  });
});

describe("the findings", () => {
  /**
   * Would break if the page invented a second vocabulary for a stopped path.
   * `describeStop` is what the traffic chain already says, and "no pod
   * carries app=promo" has to read identically whether it was reached from a
   * Deployment or from a hostname.
   */
  it("reports a route whose Service has no ready endpoints", () => {
    const [group] = hostGroups(
      sources({
        ingresses: [
          ingress("promo", "promo.example.com", { service: "promo-web" }),
        ],
        services: [service("promo-web", { app: "promo" })],
        published: [published("promo-web", 0, 2)],
      })
    );

    const stop = group.findings.find((finding) => finding.kind === "stop");
    expect(stop).toBeDefined();
    expect(stop?.kind === "stop" && stop.stop.reason).toBe("noneReady");
    expect(stop?.severity).toBe("err");
  });

  /**
   * Would break if Traefik's own internals were reported as a missing
   * Service. `api@internal` serves the dashboard k3d ships with, a
   * `TraefikService` fans out to several backends, and neither is a
   * Kubernetes object with endpoints — so "no Service named api@internal in
   * this namespace" would be the page inventing an outage on a stock
   * cluster.
   */
  it("claims nothing about a backend that is not a Kubernetes Service", () => {
    const [group] = hostGroups(
      sources({
        ingressRoutes: [
          ingressRoute("dashboard", {
            entryPoints: ["traefik"],
            routes: [
              {
                match: "PathPrefix(`/dashboard`)",
                services: [{ name: "api@internal", kind: "TraefikService" }],
              },
            ],
          }),
        ],
      })
    );

    expect(group.findings.filter((finding) => finding.kind === "stop")).toEqual(
      []
    );
  });

  /**
   * The same blind spot on the other kind of object. An Ingress may name an
   * API object instead of a Service — `backend.resource` — and the field the
   * page reads for a Service name is empty on one, so a route that works
   * read as "no Service named `` in this namespace": a 503 drawn out of a
   * working configuration, with a blank where the name goes.
   */
  it("claims nothing about an Ingress backend that is an API object", () => {
    const assets = ingress("assets", "assets.example.com");
    assets.rules[0].paths[0] = {
      path: "/assets",
      pathType: "Prefix",
      backendService: "",
      backendPort: "",
      resourceBackend: "StorageBucket/assets",
    };

    const [group] = hostGroups(sources({ ingresses: [assets] }));

    expect(group.routes[0].service).toBeNull();
    expect(group.routes[0].resourceBackend).toBe("StorageBucket/assets");
    expect(group.findings.filter((finding) => finding.kind === "stop")).toEqual(
      []
    );
  });

  /**
   * Would break if the same broken backend were reported once per route that
   * names it. Three paths onto one missing Service is one repair, and three
   * copies of the sentence spend the reader's attention on nothing.
   */
  it("reports one stop per broken backend, not per route", () => {
    const [group] = hostGroups(
      sources({
        ingresses: [
          ingress("a", "shop.example.com", { path: "/a", service: "ghost" }),
          ingress("b", "shop.example.com", { path: "/b", service: "ghost" }),
        ],
      })
    );

    expect(
      group.findings.filter((finding) => finding.kind === "stop")
    ).toHaveLength(1);
  });

  /**
   * Would break if a working route started being reported. Endpoints with
   * ready addresses is the ordinary case and by far the commonest, and a
   * page that cried wolf on it would be closed and never opened again.
   */
  it("says nothing about a host whose pods are ready", () => {
    const [group] = hostGroups(
      sources({
        ingresses: [ingress("shop", "shop.example.com", { service: "web" })],
        services: [service("web", { app: "web" })],
        published: [published("web", 3)],
      })
    );

    expect(group.findings).toEqual([]);
    expect(group.worst).toBeNull();
  });

  /**
   * Would break if a host on a plain-HTTP entry point stopped being called
   * out. It looks exactly like a normal route in every list in this app, and
   * the entry point's TLS setting lives only in the proxy's start-up flags.
   */
  it("reports a host bound to a plain entry point with no redirection", () => {
    const [group] = hostGroups(
      sources({
        ingresses: [
          ingress("internal", "internal.example.com", {
            annotations: {
              "traefik.ingress.kubernetes.io/router.entrypoints": "web",
            },
          }),
        ],
        entryPoints: [
          { name: "web", address: ":8000", tls: false, redirectTo: null },
          { name: "websecure", address: ":8443", tls: true, redirectTo: null },
        ],
      })
    );

    const clear = group.findings.find((finding) => finding.kind === "clear");
    expect(clear?.kind === "clear" && clear.entryPoints).toEqual(["web"]);
  });

  /**
   * Would break if an entry point that redirects were still reported as
   * serving in the clear. `--entrypoints.web.http.redirections...` is how
   * most clusters solve this, and calling it a finding would be wrong.
   */
  it("says nothing when the plain entry point redirects", () => {
    const [group] = hostGroups(
      sources({
        ingresses: [
          ingress("internal", "internal.example.com", {
            annotations: {
              "traefik.ingress.kubernetes.io/router.entrypoints": "web",
            },
          }),
        ],
        services: [service("web", { app: "web" })],
        published: [published("web", 1)],
        entryPoints: [
          {
            name: "web",
            address: ":8000",
            tls: false,
            redirectTo: "websecure",
          },
        ],
      })
    );

    expect(group.findings).toEqual([]);
  });

  /**
   * Would break if the page started claiming things about entry points it
   * never read. An empty list means the proxy's workload could not be found,
   * not that it listens on nothing — and "served in the clear" stated on no
   * evidence is a false alarm about the one thing people panic about.
   */
  it("claims nothing about TLS when the entry points could not be read", () => {
    const [group] = hostGroups(
      sources({
        ingresses: [ingress("internal", "internal.example.com")],
        services: [service("web", { app: "web" })],
        published: [published("web", 1)],
        entryPoints: [],
      })
    );

    expect(group.findings).toEqual([]);
  });

  /**
   * Would break if overlapping-but-different paths were reported. `/` and
   * `/api` on one host overlap by design — that is how a route is made more
   * specific — and reporting it would bury the real finding under every
   * well-configured site in the cluster.
   */
  it("does not call a more specific path an overlap", () => {
    const [group] = hostGroups(
      sources({
        ingresses: [
          ingress("root", "shop.example.com", { path: "/" }),
          ingress("api", "shop.example.com", { path: "/api" }),
        ],
      })
    );

    expect(
      group.findings.filter((finding) => finding.kind === "duplicate")
    ).toEqual([]);
  });

  /**
   * Would break if the page started picking a winner it cannot know. Two
   * objects on the same host and the same path is a real footgun, and
   * Traefik breaks the tie by the length of the rule *it* generated — which
   * this app never sees for an Ingress. Naming a winner here would be a
   * confident guess about which of two routes is dead.
   */
  it("reports two objects on one path and refuses to say which wins", () => {
    const [group] = hostGroups(
      sources({
        ingresses: [
          ingress("old", "shop.example.com", { path: "/" }),
          ingress("new", "shop.example.com", { path: "/" }),
        ],
      })
    );

    const duplicate = group.findings.find(
      (finding) => finding.kind === "duplicate"
    );
    expect(duplicate).toBeDefined();
    expect(duplicate?.kind === "duplicate" && duplicate.winner).toBeNull();
  });

  /**
   * Would break if an explicit priority stopped settling it. Where both
   * objects state one the answer is in the objects, and refusing to say so
   * would be uselessly coy.
   */
  it("names the winner when both routes declare a priority", () => {
    const [group] = hostGroups(
      sources({
        ingressRoutes: [
          ingressRoute("low", {
            routes: [
              {
                match: "Host(`shop.example.com`)",
                priority: 1,
                services: [{ name: "a", port: 80 }],
              },
            ],
          }),
          ingressRoute("high", {
            routes: [
              {
                match: "Host(`shop.example.com`)",
                priority: 9,
                services: [{ name: "b", port: 80 }],
              },
            ],
          }),
        ],
      })
    );

    const duplicate = group.findings.find(
      (finding) => finding.kind === "duplicate"
    );
    expect(
      duplicate?.kind === "duplicate" && duplicate.winner?.source.name
    ).toBe("high");
  });

  /**
   * Would break if an unset priority went back to being unknowable for an
   * IngressRoute. Traefik's default priority is the length of the router's
   * rule — which for an IngressRoute is the match string held here verbatim.
   * A migration leaves exactly this pair behind, and "which one serves
   * production" is the question the reader opened the page with.
   */
  it("settles a declared priority against Traefik's length default", () => {
    const [group] = hostGroups(
      sources({
        ingressRoutes: [
          ingressRoute("legacy", {
            routes: [
              {
                match: "Host(`shop.example.com`)",
                services: [{ name: "a", port: 80 }],
              },
            ],
          }),
          ingressRoute("current", {
            routes: [
              {
                match: "Host(`shop.example.com`)",
                priority: 250,
                services: [{ name: "b", port: 80 }],
              },
            ],
          }),
        ],
      })
    );

    const duplicate = group.findings.find(
      (finding) => finding.kind === "duplicate"
    );
    expect(
      duplicate?.kind === "duplicate" && duplicate.winner?.source.name
    ).toBe("current");
  });

  /** Two defaults settle by rule length alone — Traefik's own tie-break. */
  it("settles two defaulted priorities by rule length", () => {
    const groups = hostGroups(
      sources({
        ingressRoutes: [
          ingressRoute("short", {
            routes: [
              {
                match: "Host(`shop.example.com`)",
                services: [{ name: "a", port: 80 }],
              },
            ],
          }),
          ingressRoute("long", {
            routes: [
              {
                match: "Host(`shop.example.com`, `other.example.com`)",
                services: [{ name: "b", port: 80 }],
              },
            ],
          }),
        ],
      })
    );

    const shop = groups.find((group) => group.host === "shop.example.com");
    const duplicate = shop?.findings.find(
      (finding) => finding.kind === "duplicate"
    );
    expect(
      duplicate?.kind === "duplicate" && duplicate.winner?.source.name
    ).toBe("long");
  });

  /**
   * Two routes of one object sharing the top weight is not a tie — the
   * object wins whichever of its routers fires. Reported as "carry the same
   * priority" it told a reader their migration was unsettled when the new
   * object had in fact won on both of its routes.
   */
  it("does not call one object's two routes a tie", () => {
    const [group] = hostGroups(
      sources({
        ingressRoutes: [
          ingressRoute("legacy", {
            routes: [
              {
                match: "Host(`shop.example.com`)",
                services: [{ name: "a", port: 80 }],
              },
            ],
          }),
          ingressRoute("optin", {
            routes: [
              {
                match: "Host(`shop.example.com`) && Headers(`X-A`, `1`)",
                priority: 200,
                services: [{ name: "b", port: 80 }],
              },
              {
                match: "Host(`shop.example.com`) && Headers(`X-B`, `1`)",
                priority: 200,
                services: [{ name: "b", port: 80 }],
              },
            ],
          }),
        ],
      })
    );

    const duplicate = group.findings.find(
      (finding) => finding.kind === "duplicate"
    );
    expect(duplicate?.kind === "duplicate" && duplicate.tied).toBe(false);
    expect(
      duplicate?.kind === "duplicate" && duplicate.winner?.source.name
    ).toBe("optin");
  });

  /**
   * An Ingress's generated rule is still Traefik's own and unseen, so a
   * pair with one Ingress in it stays honestly unsettled.
   */
  it("still refuses a winner when an Ingress is one of the two", () => {
    const [group] = hostGroups(
      sources({
        ingresses: [ingress("old", "shop.example.com", { path: "/" })],
        ingressRoutes: [
          ingressRoute("new", {
            routes: [
              {
                match: "Host(`shop.example.com`) && PathPrefix(`/`)",
                services: [{ name: "b", port: 80 }],
              },
            ],
          }),
        ],
      })
    );

    const duplicate = group.findings.find(
      (finding) => finding.kind === "duplicate"
    );
    expect(duplicate).toBeDefined();
    expect(duplicate?.kind === "duplicate" && duplicate.winner).toBeNull();
  });

  /**
   * Would break if parse-refused rules went back to being treated as claims.
   * A parenthesised rule is filed under no host because it could not be
   * read; two of those placeholders are not "two objects claiming every
   * path" — that collision exists only in the parser, and warning about it
   * buries the real duplicates under a phantom.
   */
  it("does not build a duplicate out of rules it refused to read", () => {
    const negated = (name: string, host: string) =>
      ingressRoute(name, {
        routes: [
          {
            match: `!Host(\`${host}\`)`,
            services: [{ name: "web", port: 80 }],
          },
        ],
      });

    const groups = hostGroups(
      sources({
        ingressRoutes: [
          negated("market", "market.example.com"),
          negated("mp", "mp.example.com"),
        ],
      })
    );

    const catchAll = groups.find((group) => group.host === null);
    expect(catchAll).toBeDefined();
    expect(
      catchAll?.findings.filter((finding) => finding.kind === "duplicate")
    ).toEqual([]);
  });

  /**
   * The same placeholder must not read as reachable unencrypted either: the
   * rule's real host is unknown, so which entry points serve "it" is too.
   */
  it("does not call a refused rule served in the clear", () => {
    const groups = hostGroups(
      sources({
        ingressRoutes: [
          ingressRoute("market", {
            routes: [
              {
                match: "!Host(`market.example.com`)",
                services: [{ name: "web", port: 80 }],
              },
            ],
          }),
        ],
        entryPoints: [
          { name: "web", address: ":8000", tls: false, redirectTo: null },
        ],
      })
    );

    const catchAll = groups.find((group) => group.host === null);
    expect(
      catchAll?.findings.filter((finding) => finding.kind === "clear")
    ).toEqual([]);
  });
});

describe("what it refuses to claim before it knows", () => {
  /**
   * Would break if the page reported every backend in the cluster as missing
   * in the second between its two requests. The Services and Endpoints
   * arrive after the routes do, and an empty list means "not read yet" as
   * readily as it means "none" — a flash of thirty-four false outages is a
   * worse lie than a moment of saying nothing.
   */
  it("reports no stop while the Services and Endpoints are still being read", () => {
    const [group] = hostGroups(
      sources({
        ingresses: [ingress("ghost", "ghost.example.com", { service: "gone" })],
        backingKnown: false,
      })
    );

    expect(group.findings).toEqual([]);
  });
});

describe("ordering and middlewares", () => {
  /**
   * Would break if the page went back to alphabetical order. With eighty
   * hosts the reader has one that is not working and seventy-nine that are;
   * the alphabet puts the answer wherever the alphabet happens to put it.
   */
  it("puts a troubled host above a healthy one whatever its name", () => {
    const groups = hostGroups(
      sources({
        ingresses: [
          ingress("aaa", "aaa.example.com", { service: "web" }),
          ingress("zzz", "zzz.example.com", { service: "broken" }),
        ],
        services: [service("web", { app: "web" })],
        published: [published("web", 2)],
      })
    );

    expect(groups[0].host).toBe("zzz.example.com");
  });

  /**
   * Would break if an unused middleware stopped being findable. Nothing else
   * in this app can tell you that a Middleware object is referenced by
   * nothing, and configuration that does nothing is exactly what nobody goes
   * looking for.
   */
  it("puts a middleware nothing references first", () => {
    const routes = allRoutes(
      sources({
        ingressRoutes: [
          ingressRoute("shop", {
            routes: [
              {
                match: "Host(`shop.example.com`)",
                middlewares: [{ name: "used", namespace: "shop" }],
                services: [{ name: "web", port: 80 }],
              },
            ],
          }),
        ],
      })
    );

    const uses = middlewareUses(
      [
        middleware("used", { stripPrefix: { prefixes: ["/api"] } }),
        middleware("orphan", { rateLimit: { average: 100 } }),
      ],
      routes
    );

    expect(uses[0].middleware.name).toBe("orphan");
    expect(uses[0].usedBy).toEqual([]);
    expect(uses[1].usedBy).toHaveLength(1);
  });

  /**
   * Would break if the middleware reference on an Ingress were split at the
   * first hyphen. `k8s-gui-test-strip-prefix` splits six ways and only one
   * of them is right, so it is matched against what the cluster has rather
   * than cut at a guess.
   */
  it("resolves an annotation reference against the middlewares that exist", () => {
    const strip = {
      ...middleware("strip-prefix", {}),
      namespace: "k8s-gui-test",
    };
    const routes = allRoutes(
      sources({
        ingresses: [
          ingress("shop", "shop.example.com", {
            annotations: {
              "traefik.ingress.kubernetes.io/router.middlewares":
                "k8s-gui-test-strip-prefix@kubernetescrd",
            },
          }),
        ],
        middlewares: [strip],
      })
    );

    expect(routes[0].middlewares).toEqual([
      { name: "strip-prefix", namespace: "k8s-gui-test" },
    ]);
  });
});

describe("entry points, read off the proxy's own flags", () => {
  /**
   * Would break if entry points stopped being read from static configuration.
   * They exist nowhere in the API server, which is why no other screen in
   * this app can answer "why is my route on :80".
   */
  it("reads addresses, TLS and redirections out of the arguments", () => {
    const entryPoints = readEntryPoints([
      "--entrypoints.web.address=:8000/tcp",
      "--entrypoints.websecure.address=:8443/tcp",
      "--entrypoints.websecure.http.tls=true",
      "--entryPoints.web.http.redirections.entryPoint.to=websecure",
    ]);

    expect(entryPoints).toEqual([
      {
        name: "web",
        address: ":8000",
        tls: false,
        redirectTo: "websecure",
      },
      {
        name: "websecure",
        address: ":8443",
        tls: true,
        redirectTo: null,
      },
    ]);
  });
});

describe("a host whose TLS ends in front of the proxy", () => {
  const proxyService = (): ServiceInfo =>
    ({
      name: "traefik",
      namespace: "shop",
      uid: "traefik",
      type: "LoadBalancer",
      sessionAffinity: "None",
      clusterIp: "10.0.0.9",
      externalIps: [],
      loadBalancerIps: [],
      ports: [],
      selector: { "app.kubernetes.io/name": "traefik" },
      labels: {},
      annotations: {},
      createdAt: null,
    }) as ServiceInfo;

  const edge = (overrides: Partial<IngressInfo> = {}): IngressInfo => ({
    name: "edge",
    namespace: "shop",
    className: "gce",
    rules: [
      {
        host: "shop.example.com",
        paths: [
          {
            path: "/",
            pathType: "Prefix",
            backendService: "traefik",
            backendPort: "80",
            resourceBackend: null,
          },
        ],
      },
    ],
    loadBalancerIps: ["34.1.2.3"],
    tlsHosts: ["shop.example.com"],
    tlsConfigs: [],
    hasCatchAllTls: false,
    defaultBackend: null,
    labels: {},
    annotations: {},
    createdAt: null,
    ...overrides,
  });

  const base = (extra: Partial<TraefikSources> = {}): TraefikSources => ({
    ingresses: [],
    ingressRoutes: [
      ingressRoute("shop", {
        entryPoints: ["web"],
        routes: [
          {
            match: "Host(`shop.example.com`)",
            services: [{ name: "storefront", port: 80 }],
          },
        ],
      }),
    ],
    middlewares: [],
    classes: [TRAEFIK_CLASS],
    services: [proxyService()],
    published: [],
    backingKnown: false,
    entryPoints: [
      { name: "web", address: ":8000", tls: false, redirectTo: null },
    ],
    ...extra,
  });

  /**
   * The reported case, and the ordinary shape of a managed cluster: the cloud
   * load balancer holds the certificate and forwards plaintext to `web:80`.
   * The page called that "served in the clear" on every single host, which is
   * how a warning about encryption stops being read.
   */
  it("is not served in the clear when an Ingress in front holds the certificate", () => {
    const [group] = hostGroups(base({ ingresses: [edge()] }));
    expect(group.findings.filter((f) => f.kind === "clear")).toEqual([]);
  });

  /**
   * The defaultBackend spelling of the same cluster: the cloud LB names no
   * rules at all — `spec.defaultBackend` sends everything to the proxy and a
   * catch-all `spec.tls` holds one certificate for every host behind it.
   * Read through `rules` alone such an Ingress fronts nothing, and the page
   * went back to warning on every host of an edge-terminated cluster.
   */
  it("is not served in the clear behind a defaultBackend edge with catch-all TLS", () => {
    const [group] = hostGroups(
      base({
        ingresses: [
          edge({
            rules: [],
            tlsHosts: [],
            tlsConfigs: [
              { hosts: [], secretName: "wildcard-tls", isCatchAll: true },
            ],
            hasCatchAllTls: true,
            defaultBackend: {
              backendService: "traefik",
              backendPort: "80",
              resourceBackend: null,
            },
          }),
        ],
      })
    );
    expect(group.findings.filter((f) => f.kind === "clear")).toEqual([]);
  });

  /** Evidence, not inference: without a terminator the warning stands. */
  it("still warns when nothing in front terminates it", () => {
    const [group] = hostGroups(base());
    expect(group.findings.some((f) => f.kind === "clear")).toBe(true);
  });

  /** An Ingress in front that terminates a *different* host proves nothing. */
  it("does not accept a terminator for another host", () => {
    const [group] = hostGroups(
      base({ ingresses: [edge({ tlsHosts: ["other.example.com"] })] })
    );
    expect(group.findings.some((f) => f.kind === "clear")).toBe(true);
  });

  /** The certificate may be in an annotation, which only a vendor can read. */
  it("takes the capability's word for a certificate it cannot see", () => {
    const [group] = hostGroups(
      base({ upstreamTls: (host) => host === "shop.example.com" })
    );
    expect(group.findings.filter((f) => f.kind === "clear")).toEqual([]);
  });
});
