import { describe, expect, it } from "vite-plus/test";

import type {
  CustomResourceInfo,
  ServicePublished,
  IngressClassSummary,
  IngressInfo,
  ServiceInfo,
  TlsCertificate,
} from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { backingFrom, hostSeverity, hostTlsWords } from "../ingress";
import {
  allRoutes,
  duplicatedServiceNames,
  hostGroups,
  hostState,
  middlewareUses,
  readEmptyServices,
  readEntryPoints,
  type TraefikSources,
} from "./model";

const t: T = (section, key, values) => translate("en", section, key, values);

const TRAEFIK_CLASS: IngressClassSummary = {
  name: "traefik",
  controller: "traefik.io/ingress-controller",
  isDefault: true,
  parameters: null,
};

const NGINX_CLASS: IngressClassSummary = {
  name: "nginx",
  controller: "k8s.io/ingress-nginx",
  isDefault: false,
  parameters: null,
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
    uid: "",
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
    generation: null,
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
    externalName: null,
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
    unroutedReady: 0,
    ports: [],
    endpoints: [],
    whole: true,
    unpublished: [],
    stop: null,
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
    backingKnown: true,
    backingError: null,
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

describe("what a defaultBackend Ingress serves", () => {
  /**
   * The fourth surface the same blind spot reached: the routing table
   * itself. A rules-less Ingress sends everything to one Service, and a
   * table built from rules alone drew it as serving nothing.
   */
  it("serves a defaultBackend-only Ingress as its catch-all route", () => {
    const routes = allRoutes(
      sources({
        ingresses: [
          {
            ...ingress("edge", "unused.example.com"),
            rules: [],
            defaultBackend: {
              backendService: "front-proxy",
              backendPort: "80",
              resourceBackend: null,
            },
          },
        ],
      })
    );

    expect(routes).toHaveLength(1);
    expect(routes[0].clause).toEqual({ host: null, path: null });
    expect(routes[0].service?.name).toBe("front-proxy");
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
        published: [
          published("promo-web", 0, 2, {
            stop: {
              reason: "noneReady",
              service: published("promo-web", 0).service,
              selector: "app=promo",
              pods: 2,
              why: "failingReadiness",
              cause: null,
            },
          }),
        ],
      })
    );

    const stop = group.findings.find((finding) => finding.kind === "stop");
    expect(stop).toBeDefined();
    expect(stop?.kind === "stop" && stop.stop.reason).toBe("noneReady");
    expect(stop?.severity).toBe("err");
  });

  /**
   * Traefik drops a route to a Service scaled to zero, so it is worth a
   * look; it is not an outage, and the host line said one in red.
   */
  it("files a route at a Service scaled to zero as a warning, not an error", () => {
    const [group] = hostGroups(
      sources({
        ingresses: [
          ingress("promo", "promo.example.com", { service: "promo-web" }),
        ],
        services: [service("promo-web", { app: "promo" })],
        published: [
          published("promo-web", 0, 0, {
            stop: {
              reason: "scaledToZero",
              service: published("promo-web", 0).service,
              selector: "app=promo",
              workloads: [],
            },
          }),
        ],
      })
    );

    const stop = group.findings.find((finding) => finding.kind === "stop");
    expect(stop?.severity).toBe("warn");
    expect(hostState(group, null, t)).toEqual({
      text: "nothing behind it",
      tone: "warn",
    });
  });

  /** A Service whose pods nobody could read is not known to be down. */
  it("says a host whose backend's pods were not read is unknown, not broken", () => {
    const [group] = hostGroups(
      sources({
        ingresses: [
          ingress("promo", "promo.example.com", { service: "promo-web" }),
        ],
        services: [service("promo-web", { app: "promo" })],
        published: [
          published("promo-web", 0, 0, {
            stop: {
              reason: "publishesNothingYet",
              service: published("promo-web", 0).service,
              selector: "app=promo",
              podsUnread: true,
            },
          }),
        ],
      })
    );

    expect(hostState(group, null, t).tone).toBe("unknown");
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

describe("what Traefik answers for a route with nothing behind it", () => {
  const behind = (stop: ServicePublished["stop"]) =>
    sources({
      ingresses: [
        ingress("promo", "promo.example.com", { service: "promo-web" }),
      ],
      services: [service("promo-web", { app: "promo" })],
      published: [published("promo-web", 0, 0, { stop })],
    });
  const at = published("promo-web", 0).service;
  const empty = {
    reason: "selectsNothing",
    service: at,
    selector: "app=promo",
    near: null,
    makersRead: true,
  } as const;
  const answer = (
    over: Partial<TraefikSources>,
    stop: ServicePublished["stop"] = empty
  ) => {
    const [group] = hostGroups({ ...behind(stop), ...over });
    const found = group.findings.find((finding) => finding.kind === "stop");
    return found?.kind === "stop" ? found.answer : null;
  };

  /**
   * The page said "every request gets a 502" for every stopped route.
   * Traefik skips the router instead, unless allowEmptyServices keeps it to
   * answer 503, and only for the provider it is set on. Fails if the flag
   * stops being read per provider or an unread one is taken as off.
   */
  it("answers by allowEmptyServices on the provider that reads the object", () => {
    expect(
      answer({ emptyServices: { Ingress: false, IngressRoute: true } })
    ).toBe("dropped");
    expect(
      answer({ emptyServices: { Ingress: true, IngressRoute: false } })
    ).toBe("unavailable");
    expect(answer({})).toBe("unknown");
    const viaCrd = {
      ingresses: [],
      ingressRoutes: [
        ingressRoute("promo", {
          routes: [
            {
              match: "Host(`promo.example.com`)",
              services: [{ name: "promo-web", port: 80 }],
            },
          ],
        }),
      ],
    };
    expect(
      answer({
        ...viaCrd,
        emptyServices: { Ingress: true, IngressRoute: false },
      })
    ).toBe("dropped");
    expect(
      answer({
        ...viaCrd,
        emptyServices: { Ingress: false, IngressRoute: true },
      })
    ).toBe("unavailable");
  });

  /** A Service that does not exist is skipped whatever the flag says; fails if the flag is asked about it. */
  it("drops a route whose Service does not exist even where empty Services are kept", () => {
    const missing = {
      reason: "backendMissing",
      service: { ...at, existence: "missing" },
      ingress: {
        kind: "Ingress",
        name: "promo",
        namespace: "shop",
        existence: "present",
        facts: null,
      },
    } as unknown as ServicePublished["stop"];
    expect(
      answer({ emptyServices: { Ingress: true, IngressRoute: true } }, missing)
    ).toBe("dropped");
  });

  /** Fails if a flag's case, its bare form, or a config file that may hold it is misread. */
  it("reads allowEmptyServices from the flags, and nothing from a config file", () => {
    expect(
      readEmptyServices([
        "--entryPoints.web.address=:8000/tcp",
        "--providers.kubernetesingress.allowEmptyServices=true",
        "--providers.kubernetescrd.allowemptyservices",
        "--providers.kubernetescrd.allowEmptyServices=false",
      ])
    ).toEqual({ Ingress: true, IngressRoute: false });
    expect(
      readEmptyServices(["--configFile=/etc/traefik/traefik.yml"])
    ).toBeNull();
    expect(readEmptyServices([])).toBeNull();
  });
});

describe("which service names need their namespace beside them", () => {
  /**
   * Two Services named `frontend` in two namespaces render as the same
   * word on every row, and a reader migrating between them cannot tell
   * which row is the old one — the exact moment they are looking.
   */
  it("names only the collisions", () => {
    const route = (namespace: string, service: string) =>
      ingressRoute(`${namespace}-${service}`, {
        routes: [
          {
            match: `Host(\`${namespace}.example.com\`)`,
            services: [{ name: service, namespace, port: 80 }],
          },
        ],
      });

    const groups = hostGroups(
      sources({
        ingressRoutes: [
          route("shop", "frontend"),
          route("frontend", "frontend"),
          route("api", "api"),
        ],
      })
    );

    expect(duplicatedServiceNames(groups)).toEqual(new Set(["frontend"]));
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
        backingError: null,
      })
    );

    expect(group.findings).toEqual([]);
  });

  /**
   * Would break if a host with nothing found and its Services unread went
   * back to green "serving": the row, the map node and the tab mark all read
   * `worst: null` as fine, beside a note saying nothing behind it was read.
   */
  it("calls a host whose backends were refused unknown, not serving", () => {
    const [group] = hostGroups(
      sources({
        ingresses: [ingress("shop", "shop.example.com")],
        ...backingFrom(undefined, new Error("services is forbidden")),
      })
    );

    expect(group.backendsKnown).toBe(false);
    expect(hostSeverity(group)).toBe("unknown");
    expect(hostState(group, "services is forbidden", t)).toEqual({
      text: t("empty", "endpointsUnread"),
      tone: "unknown",
    });
  });

  /** Read and healthy is the one case "serving" is the answer. */
  it("calls a host serving once what is behind it was read", () => {
    const [group] = hostGroups(
      sources({
        ingresses: [ingress("shop", "shop.example.com")],
        services: [service("web", { app: "web" })],
        published: [published("web", 2)],
        entryPoints: [
          { name: "websecure", address: ":8443", tls: true, redirectTo: null },
        ],
      })
    );

    expect(hostSeverity(group)).toBeNull();
    expect(hostState(group, null, t).tone).toBe("ok");
  });

  /** The controller's entry points unread is the same unknown as the edge
   *  unread: whether the host is served in the clear cannot be told. */
  it("calls a host TLS not checked while the entry points are unread", () => {
    const [group] = hostGroups(
      sources({
        ingresses: [ingress("shop", "shop.example.com")],
        services: [service("web", { app: "web" })],
        published: [published("web", 2)],
        entryPoints: [],
      })
    );

    expect(group.tls).toEqual({ at: "unknown" });
    expect(hostState(group, null, t)).toEqual({
      text: "TLS not checked",
      tone: "unknown",
    });
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
      externalName: null,
      externalIps: [],
      loadBalancerIps: [],
      ports: [],
      selector: { "app.kubernetes.io/name": "traefik" },
      labels: {},
      annotations: {},
      createdAt: null,
    }) as ServiceInfo;

  const edge = (overrides: Partial<IngressInfo> = {}): IngressInfo => ({
    uid: "",
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
    backingKnown: true,
    backingError: null,
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

  /**
   * Without the proxy's Services no Ingress in front can be recognised, and
   * "could not look at the edge" was reported as "nothing terminates it".
   */
  it("is not called clear while the Services are unread", () => {
    const [group] = hostGroups(
      base(backingFrom(undefined, new Error("services is forbidden")))
    );
    expect(group.findings.some((f) => f.kind === "clear")).toBe(false);
  });

  /** A capability that has not answered is not one that said no. */
  it("is not called clear while the capability has not answered", () => {
    const [group] = hostGroups(base({ upstreamTls: () => "unknown" }));
    expect(group.findings.some((f) => f.kind === "clear")).toBe(false);
  });

  /** Nor serving: dropping the warning left the row green and counted fine,
   *  when the host may well be in the clear. */
  it("reads a host that may be in the clear as TLS not checked", () => {
    const [group] = hostGroups(base({ upstreamTls: () => "unknown" }));
    expect(group.tls).toEqual({ at: "unknown" });
    // With nothing else wrong under it, which is the case that was green.
    const quiet = { ...group, findings: [], worst: null };
    expect(hostSeverity(quiet)).toBe("unknown");
    expect(hostState(quiet, null, t)).toEqual({
      text: "TLS not checked",
      tone: "unknown",
    });
  });
});

describe("which routers Traefik serves over TLS", () => {
  const WEB = { name: "web", address: ":8000", tls: false, redirectTo: null };
  const WEBSECURE = {
    name: "websecure",
    address: ":8443",
    tls: true,
    redirectTo: null,
  };
  const promo = (annotations: Record<string, string> = {}) =>
    ingress("promo", "promo.example.com", {
      secretName: "promo-tls",
      annotations,
    });

  /**
   * Traefik reads an Ingress's `spec.tls` for certificates and nothing else.
   * Read as TLS, the page said "TLS from promo-tls" over a router that
   * answers plain HTTP on `web` and nothing on 443, with no finding at all.
   */
  it("calls a host whose Ingress only names a Secret in spec.tls served in the clear", () => {
    const [group] = hostGroups(
      sources({ ingresses: [promo()], entryPoints: [WEB] })
    );

    const clear = group.findings.find((finding) => finding.kind === "clear");
    expect(clear?.kind === "clear" && clear.loaded).toBe("promo-tls");
    expect(group.tls).toEqual({ at: "none" });
    expect(group.tlsSecrets).toEqual([]);
  });

  /** Would break if the annotation that does make a router TLS were not read. */
  it.each([
    [{ "traefik.ingress.kubernetes.io/router.tls": "true" }],
    [
      {
        "traefik.ingress.kubernetes.io/router.tls.certresolver": "letsencrypt",
      },
    ],
  ])("serves the host over TLS with %o", (annotations) => {
    const [group] = hostGroups(
      sources({ ingresses: [promo(annotations)], entryPoints: [WEB] })
    );

    expect(group.findings.filter((f) => f.kind === "clear")).toEqual([]);
    expect(group.tls).toEqual({
      at: "own",
      secret: "promo-tls",
      missing: false,
    });
  });

  it("does not read router.tls set to false as TLS", () => {
    const [group] = hostGroups(
      sources({
        ingresses: [
          promo({ "traefik.ingress.kubernetes.io/router.tls": "false" }),
        ],
        entryPoints: [WEB],
      })
    );

    expect(group.tls).toEqual({ at: "none" });
  });

  /**
   * A router bound to a TLS entry point is TLS there, and Traefik picks the
   * Secret by SNI. The page said "no TLS" for it while it served https.
   */
  it("serves a router on a TLS entry point under the Secret named for its host", () => {
    const [group] = hostGroups(
      sources({ ingresses: [promo()], entryPoints: [WEB, WEBSECURE] })
    );

    expect(group.tls).toEqual({
      at: "own",
      secret: "promo-tls",
      missing: false,
    });
    expect(group.findings.filter((f) => f.kind === "clear")).toEqual([]);
  });

  /** "No encrypted way to reach it" about a host websecure serves was false. */
  it("does not call a host in the clear when it is also bound to a TLS entry point", () => {
    const [group] = hostGroups(
      sources({
        ingresses: [ingress("shop", "shop.example.com")],
        entryPoints: [WEB, WEBSECURE],
      })
    );

    expect(group.findings.filter((f) => f.kind === "clear")).toEqual([]);
    expect(group.tls).toEqual({ at: "own", secret: null, missing: false });
  });
});

describe("a path whose backend is an API object", () => {
  const assets = () => {
    const object = ingress("assets", "assets.example.com");
    object.rules[0].paths[0] = {
      path: "/assets",
      pathType: "Prefix",
      backendService: "",
      backendPort: "",
      resourceBackend: "StorageBucket/assets",
    };
    return object;
  };

  /**
   * Traefik logs "Resource backends are not supported" and skips the path,
   * so the request gets a 404. The page said only "an API object" in grey.
   */
  it("is reported as dropped by Traefik", () => {
    const [group] = hostGroups(sources({ ingresses: [assets()] }));

    const dropped = group.findings.filter(
      (finding) => finding.kind === "resourceBackend"
    );
    expect(dropped).toHaveLength(1);
    expect(group.worst).toBe("err");
    expect(group.chainFor.resourceBackend).toBe("StorageBucket/assets");
    expect(hostState(group, null, t)).toEqual({
      text: "a path is dropped",
      tone: "err",
    });
  });

  /**
   * Traefik serves nothing for a path it drops, so "served in the clear: no
   * encrypted way to reach it" under "a path is dropped" described a host
   * that answers 404 as one that answers in plain HTTP.
   */
  it("does not call a host served in the clear when Traefik drops its only path", () => {
    const [group] = hostGroups(
      sources({
        ingresses: [assets()],
        entryPoints: [
          { name: "web", address: ":8000", tls: false, redirectTo: null },
        ],
      })
    );

    expect(group.findings.map((finding) => finding.kind)).toEqual([
      "resourceBackend",
    ]);
  });

  /** A defaultBackend naming an API object was not a route at all, so not a finding either. */
  it("is reported for a defaultBackend too", () => {
    const fallback = ingress("fallback", "x.example.com");
    fallback.rules = [];
    fallback.defaultBackend = {
      backendService: "",
      backendPort: "",
      resourceBackend: "StorageBucket/static",
    };

    const [group] = hostGroups(sources({ ingresses: [fallback] }));

    expect(group.host).toBeNull();
    expect(group.findings.map((finding) => finding.kind)).toContain(
      "resourceBackend"
    );
  });
});

describe("a TLS Secret the API server says is not there", () => {
  const checkout = () =>
    ingress("checkout", "checkout.example.com", {
      secretName: "checkout-tls",
      annotations: { "traefik.ingress.kubernetes.io/router.tls": "true" },
    });
  const certificates = (problem: TlsCertificate["problem"]) =>
    new Map<string, TlsCertificate>([
      [
        "shop/checkout-tls",
        { secretName: "checkout-tls", certificate: null, problem },
      ],
    ]);

  /**
   * Traefik answers such a router with TRAEFIK DEFAULT CERT, which a browser
   * refuses. The page said "TLS from checkout-tls" and, in amber, that it
   * "could not be read as a certificate", as if the Secret were there.
   */
  it("is an error that says the controller's default certificate is served", () => {
    const [group] = hostGroups(
      sources({
        ingresses: [checkout()],
        services: [service("web", { app: "web" })],
        published: [published("web", 1)],
        certificates: certificates({ says: "noSecret" }),
      })
    );

    expect(group.tls).toEqual({
      at: "own",
      secret: "checkout-tls",
      missing: true,
    });
    expect(group.worst).toBe("err");
    expect(hostTlsWords(group.tls, t)).toBe(
      "TLS, default certificate: checkout-tls does not exist"
    );
    expect(hostState(group, null, t)).toEqual({
      text: "certificate missing",
      tone: "err",
    });
  });

  /** A Secret the app could not read is not one that is missing. */
  it("keeps a Secret that could not be read apart from a missing one", () => {
    const [group] = hostGroups(
      sources({
        ingresses: [checkout()],
        services: [service("web", { app: "web" })],
        published: [published("web", 1)],
        certificates: certificates({ says: "secretUnreadable", said: "403" }),
      })
    );

    expect(group.tls).toEqual({
      at: "own",
      secret: "checkout-tls",
      missing: false,
    });
    expect(group.worst).toBe("warn");
  });
});
