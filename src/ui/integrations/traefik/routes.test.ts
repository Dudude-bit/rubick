/**
 * The answer that stops a page claiming nothing routes a Service.
 *
 * Two things are being pinned here. That an IngressRoute is found at all —
 * the backend's connection graph reads `Ingress` and nothing else, which is
 * the whole reason this exists. And that the scheme is never invented: a
 * route whose objects do not settle TLS comes back `null`, because the
 * failure mode this replaces was a confident sentence that was wrong, and a
 * confident `https://` on a host served in the clear would be the same bug
 * wearing a link.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CustomResourceInfo } from "@/generated/types";
import type { EntryPoint, TraefikRoute } from "./model";

vi.mock("@/lib/commands", () => ({
  commands: {
    listIngresses: vi.fn(async () => []),
    listCustomResources: vi.fn(async () => []),
    listServices: vi.fn(async () => []),
    resolveIngressClass: vi.fn(async () => ({ available: [] })),
    listDeployments: vi.fn(async () => []),
    getDeployment: vi.fn(async () => ({ containers: [] })),
    listDaemonsets: vi.fn(async () => []),
    getManifest: vi.fn(async () => ({})),
  },
}));

import { commands } from "@/lib/commands";
import { settleFrontedRoutes } from "@/lib/fronted-tls";
import type { IngressInfo, ServiceInfo } from "@/generated/types";
import type { IngressTls } from "../registry";
import { servedGroupName } from "./data";
import { routeIsSecure, serviceRoutes } from "./routes";

const WEB: EntryPoint = {
  name: "web",
  address: ":8000",
  tls: false,
  redirectTo: null,
};
const WEBSECURE: EntryPoint = {
  name: "websecure",
  address: ":8443",
  tls: true,
  redirectTo: null,
};

const route = (overrides: Partial<TraefikRoute> = {}): TraefikRoute =>
  ({
    key: "r",
    source: { kind: "IngressRoute", name: "argocd", namespace: "argocd" },
    rule: { raw: null, clauses: [], unread: [], refused: null },
    clause: { host: "argocd.example.com", path: null },
    entryPoints: null,
    middlewares: [],
    service: {
      name: "argocd-server",
      namespace: "argocd",
      port: "80",
      kubernetes: true,
    },
    resourceBackend: null,
    tlsSecret: null,
    declaresTls: false,
    pathType: null,
    priority: null,
    ...overrides,
  }) as TraefikRoute;

describe("whether a route is served over TLS", () => {
  it("takes a named Secret as the end of the question", () => {
    expect(routeIsSecure(route({ tlsSecret: "argocd-tls" }), [])).toBe(true);
  });

  /**
   * `tls: {}` is Traefik's "serve this with the default certificate". Read
   * through `tlsSecret` alone it is indistinguishable from an object that
   * never mentioned TLS, and the page would offer `http://` for a host that
   * only answers on 443.
   */
  it("counts a tls block that names no Secret", () => {
    expect(routeIsSecure(route({ declaresTls: true }), [WEB])).toBe(true);
  });

  it("reads the entry points the router is bound to", () => {
    expect(
      routeIsSecure(route({ entryPoints: ["websecure"] }), [WEB, WEBSECURE])
    ).toBe(true);
    expect(
      routeIsSecure(route({ entryPoints: ["web"] }), [WEB, WEBSECURE])
    ).toBe(false);
  });

  /** Naming none binds a router to every entry point, not to none of them. */
  it("treats no entry points named as all of them", () => {
    expect(routeIsSecure(route({ entryPoints: null }), [WEB, WEBSECURE])).toBe(
      true
    );
    expect(routeIsSecure(route({ entryPoints: null }), [WEB])).toBe(false);
  });

  /**
   * Entry points live in the proxy's start-up flags. With none read there is
   * no honest answer, and `false` would be a guess that prints a scheme.
   */
  it("says it does not know rather than guessing plain HTTP", () => {
    expect(routeIsSecure(route(), [])).toBeNull();
    expect(routeIsSecure(route({ entryPoints: ["absent"] }), [WEB])).toBeNull();
  });
});

function ingressRoute(spec: Record<string, unknown>): CustomResourceInfo {
  return {
    name: "argocd-server",
    namespace: "argocd",
    uid: "ir-1",
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

describe("which hosts reach a Service", () => {
  /**
   * The reported bug, in one case: a cluster whose edge is an IngressRoute,
   * a page that read Ingresses, and a reader told nothing served the Service
   * they had been opening by name for months.
   */
  it("finds the host an IngressRoute serves it on", async () => {
    vi.mocked(commands.listCustomResources).mockResolvedValue([
      ingressRoute({
        entryPoints: ["web"],
        routes: [
          {
            match: "Host(`argocd.example.com`)",
            services: [{ name: "argocd-server", port: 80 }],
          },
        ],
      }),
    ]);

    const found = await serviceRoutes({
      namespace: "argocd",
      name: "argocd-server",
    });

    expect(found).toHaveLength(1);
    expect(found[0].host).toBe("argocd.example.com");
    // The CRD rides on the source so a consumer can draw a real reference —
    // peek, glyph and hue — instead of a bare text link.
    expect(found[0].source).toEqual({
      kind: "IngressRoute",
      name: "argocd-server",
      namespace: "argocd",
      crd: `ingressroutes.${servedGroupName()}`,
    });
    // The proxy's flags were not read here, so the scheme is unsettled — and
    // saying so is the point.
    expect(found[0].tls).toBeNull();
  });

  /** A route that pins `scheme: h2c` is a gRPC way in, and is marked so. */
  it("marks an h2c route so nothing links a browser into it", async () => {
    vi.mocked(commands.listCustomResources).mockResolvedValue([
      ingressRoute({
        routes: [
          {
            match: "Host(`argocd-grpc.example.com`)",
            services: [{ name: "argocd-server", port: 80, scheme: "h2c" }],
          },
        ],
      }),
    ]);

    const found = await serviceRoutes({
      namespace: "argocd",
      name: "argocd-server",
    });

    expect(found).toHaveLength(1);
    expect(found[0].h2c).toBe(true);
  });

  /**
   * The edge shape the reported cluster actually runs: TLS ends at a cloud
   * load balancer whose Ingress fronts the proxy through
   * `spec.defaultBackend` with a catch-all certificate, and the route itself
   * binds plain `web`. The client-facing scheme is still https, and printing
   * `http://` for it sent readers to a host that redirects them anyway.
   */
  it("settles https from an edge terminating in front of the proxy", async () => {
    vi.mocked(commands.listIngresses).mockResolvedValue([
      {
        name: "edge",
        namespace: "edge",
        className: "gce",
        rules: [],
        defaultBackend: {
          backendService: "traefik",
          backendPort: "80",
          resourceBackend: null,
        },
        loadBalancerIps: ["34.1.2.3"],
        tlsHosts: [],
        tlsConfigs: [
          { hosts: [], secretName: "wildcard-tls", isCatchAll: true },
        ],
        hasCatchAllTls: true,
        labels: {},
        annotations: {},
        createdAt: null,
      },
    ]);
    vi.mocked(commands.listServices).mockResolvedValue([
      {
        name: "traefik",
        namespace: "edge",
        uid: "proxy",
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
      },
    ]);
    vi.mocked(commands.listCustomResources).mockResolvedValue([
      ingressRoute({
        entryPoints: ["web"],
        routes: [
          {
            match: "Host(`argocd.example.com`)",
            services: [{ name: "argocd-server", port: 80 }],
          },
        ],
      }),
    ]);

    const found = await serviceRoutes({
      namespace: "argocd",
      name: "argocd-server",
    });

    expect(found[0].tls).toBe(true);
  });

  it("ignores a route to a different Service", async () => {
    vi.mocked(commands.listCustomResources).mockResolvedValue([
      ingressRoute({
        routes: [
          {
            match: "Host(`shop.example.com`)",
            services: [{ name: "storefront", port: 80 }],
          },
        ],
      }),
    ]);

    await expect(
      serviceRoutes({ namespace: "argocd", name: "argocd-server" })
    ).resolves.toEqual([]);
  });
});

describe("the scheme of a route on a plain entry point", () => {
  beforeEach(() => {
    vi.mocked(commands.listIngresses).mockResolvedValue([]);
    vi.mocked(commands.listServices).mockResolvedValue([]);
    vi.mocked(commands.listDeployments).mockResolvedValue([
      {
        name: "traefik",
        namespace: "edge",
        containers: [{ image: "traefik:v3" }],
        replicas: { ready: 1, desired: 1 },
      },
    ] as never);
    vi.mocked(commands.getDeployment).mockResolvedValue({
      containers: [
        { command: [], args: ["--entryPoints.web.address=:8000"], env: [] },
      ],
    } as never);
    vi.mocked(commands.listCustomResources).mockResolvedValue([
      ingressRoute({
        entryPoints: ["web"],
        routes: [
          {
            match: "Host(`argocd.example.com`)",
            services: [{ name: "argocd-server", port: 80 }],
          },
        ],
      }),
    ]);
  });

  /** The Service list is how an edge terminating in front is found; refused, it was read as none, and a host clients reach over HTTPS was handed out as `http://`. Fails if the refusal becomes an empty list again. */
  it("does not settle it when the Services could not be listed", async () => {
    vi.mocked(commands.listServices).mockRejectedValueOnce(
      new Error("services is forbidden")
    );

    const found = await serviceRoutes({
      namespace: "argocd",
      name: "argocd-server",
    });

    expect(found[0].tls).toBeNull();
  });

  /** The other half: Services read and nothing in front, a plain entry point is plain. */
  it("says plain when the Services were read and nothing stands in front", async () => {
    const found = await serviceRoutes({
      namespace: "argocd",
      name: "argocd-server",
    });

    expect(found[0].tls).toBe(false);
  });
});

describe("the scheme of a route behind a load balancer holding the certificate", () => {
  /** An ALB Ingress sending the host to Traefik, its certificate an ACM ARN. */
  const alb: IngressInfo = {
    name: "edge",
    namespace: "edge",
    className: "alb",
    rules: [
      {
        host: "argocd.example.com",
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
    defaultBackend: null,
    loadBalancerIps: [],
    tlsHosts: [],
    tlsConfigs: [],
    hasCatchAllTls: false,
    labels: {},
    annotations: {
      "alb.ingress.kubernetes.io/certificate-arn": "arn:aws:acm:cert/abc",
    },
    createdAt: null,
  };
  const proxy = {
    name: "traefik",
    namespace: "edge",
    selector: { "app.kubernetes.io/name": "traefik" },
  } as unknown as ServiceInfo;

  /** What the AWS controller answers for the Ingress it owns. */
  const acm =
    (terminated: IngressTls["terminated"]) =>
    async (
      wanted: Array<{ namespace: string; name: string; hosts: string[] }>
    ) =>
      wanted.map((entry) =>
        entry.name === "edge"
          ? entry.hosts.map((host) => ({
              host,
              terminated,
              by: { key: "awsAcmCertificate" as const },
            }))
          : []
      );

  const read = async (ingressTls: Array<ReturnType<typeof acm>>) =>
    settleFrontedRoutes(
      await serviceRoutes({ namespace: "argocd", name: "argocd-server" }),
      { ingressTls, serviceRoutes: [serviceRoutes] }
    );

  beforeEach(() => {
    vi.mocked(commands.listIngresses).mockResolvedValue([alb]);
    vi.mocked(commands.listServices).mockResolvedValue([proxy]);
    vi.mocked(commands.listDeployments).mockResolvedValue([
      {
        name: "traefik",
        namespace: "edge",
        containers: [{ image: "traefik:v3" }],
        replicas: { ready: 1, desired: 1 },
      },
    ] as never);
    vi.mocked(commands.getDeployment).mockResolvedValue({
      containers: [
        { command: [], args: ["--entryPoints.web.address=:8000"], env: [] },
      ],
    } as never);
    vi.mocked(commands.listCustomResources).mockResolvedValue([
      ingressRoute({
        entryPoints: ["web"],
        routes: [
          {
            match: "Host(`argocd.example.com`)",
            services: [{ name: "argocd-server", port: 80 }],
          },
        ],
      }),
    ]);
  });

  /**
   * The Traefik page asked the AWS controller and said "TLS ends at the
   * edge"; the Service page, the peek and the Argo CD page read this route
   * alone, saw a plain entry point and nothing in `spec.tls`, and printed
   * `http://argocd.example.com`. Fails if the route stops naming what is in
   * front of the proxy.
   */
  it("is https when the controller in front says it terminates it", async () => {
    const [found] = await read([acm(true)]);
    expect(found.tls).toBe(true);
  });

  /** A controller that could not read its certificate has not said plain. */
  it("is not settled when the controller in front could not tell", async () => {
    const [found] = await read([acm(null)]);
    expect(found.tls).toBeNull();
  });

  /** Nor has one whose answer never came. */
  it("is not settled when the controller in front could not be asked", async () => {
    const [found] = await read([
      () => Promise.reject(new Error("ingresses is forbidden")),
    ]);
    expect(found.tls).toBeNull();
  });

  /** Every question answered and nothing terminating it: the page says "no TLS" too. */
  it("stays plain when nothing in front terminates it", async () => {
    const [found] = await read([acm(false)]);
    expect(found.tls).toBe(false);
  });
});
