import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { describe, expect, it } from "vitest";

/** The English catalogue — what these expectations are written in. */
const t: T = (section, key, values) => translate("en", section, key, values);

import type {
  IngressClassSummary,
  IngressInfo,
  ServiceInfo,
  ServicePublished,
} from "@/generated/types";
import { PREFIX } from "./annotations";
import { hostGroups, splitOf, allRoutes, type NginxSources } from "./model";

const NGINX_CLASS: IngressClassSummary = {
  name: "nginx",
  controller: "k8s.io/ingress-nginx",
  isDefault: false,
};

const TRAEFIK_CLASS: IngressClassSummary = {
  name: "traefik",
  controller: "traefik.io/ingress-controller",
  isDefault: true,
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
    createdAt?: string;
  } = {}
): IngressInfo {
  return {
    name,
    namespace: "shop",
    className: options.className === undefined ? "nginx" : options.className,
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
    createdAt: options.createdAt ?? null,
  };
}

function service(name: string): ServiceInfo {
  return {
    name,
    namespace: "shop",
    type: "ClusterIP",
    clusterIp: "10.0.0.1",
    externalIps: [],
    ports: [
      {
        name: "http",
        port: 80,
        targetPort: "8080",
        protocol: "TCP",
        nodePort: null,
      },
    ],
    selector: { app: name },
    labels: {},
    annotations: {},
    createdAt: null,
  } as unknown as ServiceInfo;
}

function published(name: string, ready: number): ServicePublished {
  return {
    service: {
      kind: "Service",
      name,
      namespace: "shop",
      existence: "present",
      facts: null,
    },
    ready,
    draining: 0,
    notReady: 0,
    unrouted: 0,
  } as unknown as ServicePublished;
}

function sources(ingresses: IngressInfo[]): NginxSources {
  return {
    ingresses,
    classes: [NGINX_CLASS, TRAEFIK_CLASS],
    services: [service("web"), service("web-next")],
    published: [published("web", 2), published("web-next", 1)],
  };
}

const canary = (weight: string, extra: Record<string, string> = {}) => ({
  [`${PREFIX}canary`]: "true",
  [`${PREFIX}canary-weight`]: weight,
  ...extra,
});

describe("what a defaultBackend Ingress serves", () => {
  it("serves a defaultBackend-only Ingress as its catch-all route", () => {
    const routes = allRoutes(
      sources([
        {
          ...ingress("edge", "unused.example.com"),
          rules: [],
          defaultBackend: {
            backendService: "front-proxy",
            backendPort: "80",
            resourceBackend: null,
          },
        },
      ]),
      t
    );

    expect(routes).toHaveLength(1);
    expect(routes[0].host).toBeNull();
    expect(routes[0].service?.name).toBe("front-proxy");
  });
});

describe("which Ingresses are this controller's", () => {
  /**
   * Would break if the page started drawing the whole cluster's routing.
   * On the cluster this was built against, Traefik is the default class and
   * nginx is the one installed beside it — an nginx page listing Traefik's
   * hosts would be a page about somebody else's proxy.
   */
  it("draws only the Ingresses whose class names this controller", () => {
    const mine = ingress("shop", "shop.test");
    const theirs = ingress("blog", "blog.test", { className: "traefik" });
    const unclassed = ingress("legacy", "legacy.test", { className: null });

    const routes = allRoutes(sources([mine, theirs, unclassed]), t);
    expect(routes.map((route) => route.source.name)).toEqual(["shop"]);
  });
});

describe("a canary reads as one weighted host", () => {
  /**
   * The whole reason canary annotations get their own handling. Two
   * Ingresses are **one** host, and a page that listed them as two hosts
   * would draw a cluster that does not exist — each row looking like it
   * takes all the traffic.
   */
  it("groups the canary under the host it shadows", () => {
    const groups = hostGroups(
      sources([
        ingress("promo", "promo.test"),
        ingress("promo-canary", "promo.test", {
          service: "web-next",
          annotations: canary("20"),
        }),
      ]),
      t
    );

    expect(groups).toHaveLength(1);
    expect(groups[0].host).toBe("promo.test");
    expect(groups[0].routes).toHaveLength(2);
  });

  /** Would break if the shares stopped adding up to the host. */
  it("states the share each side takes", () => {
    const split = splitOf(
      allRoutes(
        sources([
          ingress("promo", "promo.test"),
          ingress("promo-canary", "promo.test", {
            service: "web-next",
            annotations: canary("20"),
          }),
        ]),
        t
      )
    );

    expect(split?.primary.source.name).toBe("promo");
    expect(split?.canaries).toHaveLength(1);
    expect(split?.primaryShare).toBe(80);
    expect(split?.weightTotal).toBe(100);
  });

  /**
   * Would break if a header-routed canary were given an invented
   * percentage. nginx checks the header first and the weight is never
   * reached, so there is no share of traffic any object here states.
   */
  it("refuses to state a share when a header decides it", () => {
    const split = splitOf(
      allRoutes(
        sources([
          ingress("promo", "promo.test"),
          ingress("promo-canary", "promo.test", {
            service: "web-next",
            annotations: canary("20", {
              [`${PREFIX}canary-by-header`]: "X-Canary",
            }),
          }),
        ]),
        t
      )
    );
    expect(split?.primaryShare).toBeNull();
  });

  /**
   * Would break if a canary pair started reading as a misconfiguration.
   * Two Ingresses on one host and one path is exactly what a canary is,
   * and reporting it would make every correct canary in the cluster a
   * finding.
   */
  it("is never reported as a duplicate", () => {
    const groups = hostGroups(
      sources([
        ingress("promo", "promo.test"),
        ingress("promo-canary", "promo.test", {
          service: "web-next",
          annotations: canary("20"),
        }),
      ]),
      t
    );
    expect(
      groups[0].findings.filter((finding) => finding.kind === "duplicate")
    ).toHaveLength(0);
  });

  /**
   * Would break if a canary with no host to shadow went quiet. nginx merges
   * a canary into an existing server block; with none it is correct YAML
   * that is never served, and nothing else in this app could say so.
   */
  it("says when a canary shadows nothing", () => {
    const groups = hostGroups(
      sources([
        ingress("lonely-canary", "lonely.test", {
          annotations: canary("20"),
        }),
      ]),
      t
    );
    expect(groups[0].findings.map((finding) => finding.kind)).toContain(
      "orphanCanary"
    );
    expect(groups[0].split).toBeNull();
  });
});

describe("a backend that is not a Service", () => {
  /**
   * Would break if an Ingress naming an API object were reported as a
   * missing Service — which is the page inventing an outage out of a
   * working configuration. `backend.resource` has no endpoints by design.
   */
  it("claims nothing about a path routing to an API object", () => {
    const withResource = ingress("assets", "assets.test");
    withResource.rules[0].paths[0] = {
      path: "/assets",
      pathType: "Prefix",
      backendService: "",
      backendPort: "",
      resourceBackend: "StorageBucket/assets",
    };

    const groups = hostGroups(sources([withResource]), t);
    expect(groups[0].routes[0].service).toBeNull();
    expect(groups[0].routes[0].resourceBackend).toBe("StorageBucket/assets");
    expect(
      groups[0].findings.filter((finding) => finding.kind === "stop")
    ).toHaveLength(0);
  });
});

describe("the findings", () => {
  /** Would break if two objects silently claiming one path stayed silent. */
  it("names the object nginx actually serves when two claim one path", () => {
    const groups = hostGroups(
      sources([
        ingress("old", "shop.test", { createdAt: "2020-01-01T00:00:00Z" }),
        ingress("new", "shop.test", { createdAt: "2024-01-01T00:00:00Z" }),
      ]),
      t
    );
    const duplicate = groups[0].findings.find(
      (finding) => finding.kind === "duplicate"
    );
    expect(
      duplicate?.kind === "duplicate" && duplicate.winner?.source.name
    ).toBe("old");
  });

  /**
   * Would break if `ssl-redirect` on a host with no certificate stopped
   * being called out. It reads like protection and does nothing — nginx
   * applies it only where the Ingress has a certificate to redirect to —
   * and that is the case that looks safe and is not.
   */
  it("says a host is in the clear even when it carries ssl-redirect", () => {
    const groups = hostGroups(
      sources([
        ingress("plain", "plain.test", {
          annotations: { [`${PREFIX}ssl-redirect`]: "true" },
        }),
      ]),
      t
    );
    const clear = groups[0].findings.find(
      (finding) => finding.kind === "clear"
    );
    expect(clear?.kind === "clear" && clear.redirectAnyway).toBe(true);
  });

  /** Would break if a host with a certificate were called clear. */
  it("says nothing about a host that is served over TLS", () => {
    const groups = hostGroups(
      sources([ingress("secure", "secure.test", { secretName: "shop-tls" })]),
      t
    );
    expect(
      groups[0].findings.filter((finding) => finding.kind === "clear")
    ).toHaveLength(0);
  });

  /** Would break if a backend nobody created stopped being an outage. */
  it("stops the chain at a Service that does not exist", () => {
    const groups = hostGroups(
      sources([ingress("ghost", "ghost.test", { service: "never-made" })]),
      t
    );
    const stop = groups[0].findings.find((finding) => finding.kind === "stop");
    expect(stop?.kind === "stop" && stop.stop.reason).toBe("backendMissing");
    expect(groups[0].worst).toBe("err");
  });

  /** Would break if the page stopped putting the outage first. */
  it("orders hosts by trouble rather than by name", () => {
    const groups = hostGroups(
      sources([
        ingress("aaa", "aaa.test", { secretName: "tls" }),
        ingress("zzz", "zzz.test", { service: "never-made" }),
      ]),
      t
    );
    expect(groups[0].host).toBe("zzz.test");
  });
});

/** nginx's own Service, which is what an edge Ingress points at. */
const proxyService = (): ServiceInfo => ({
  ...service("ingress-nginx-controller"),
  selector: { "app.kubernetes.io/name": "ingress-nginx" },
});

/** The Ingress the cloud load balancer is built from, terminating TLS. */
const edgeIngress = (): IngressInfo => ({
  ...ingress("edge", "shop.example.com", {
    service: "ingress-nginx-controller",
    secretName: "edge-tls",
  }),
  className: "gce",
});

const plainIngress = (): IngressInfo => ({
  ...ingress("edge", "shop.example.com", {
    service: "ingress-nginx-controller",
  }),
  className: "gce",
});

const fronted = (): NginxSources => ({
  ...sources([ingress("shop", "shop.example.com"), edgeIngress()]),
  services: [service("web"), proxyService()],
  published: [published("web", 2)],
});

describe("a host whose TLS ends in front of nginx", () => {
  /**
   * The commonest managed-cluster shape there is: a cloud load balancer
   * holds the certificate and forwards plaintext to nginx on port 80. Read
   * from `spec.tls` alone, every host on such a cluster was reported as
   * served in the clear — a warning about encryption that is wrong on all of
   * them at once, which is how it stops being read.
   */
  it("is not served in the clear when something in front holds the certificate", () => {
    const [group] = hostGroups(fronted(), t);
    expect(group.findings.filter((f) => f.kind === "clear")).toEqual([]);
  });

  /** Evidence, not inference. */
  it("still warns when nothing in front terminates it", () => {
    const [group] = hostGroups(
      {
        ...fronted(),
        ingresses: [ingress("shop", "shop.example.com"), plainIngress()],
      },
      t
    );
    expect(group.findings.some((f) => f.kind === "clear")).toBe(true);
  });
});
