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

import { describe, expect, it, vi } from "vitest";

import type { CustomResourceInfo } from "@/generated/types";
import type { EntryPoint, TraefikRoute } from "./model";

vi.mock("@/lib/commands", () => ({
  commands: {
    listIngresses: vi.fn(async () => []),
    listCustomResources: vi.fn(async () => []),
    resolveIngressClass: vi.fn(async () => ({ available: [] })),
    listDeployments: vi.fn(async () => []),
    listDaemonsets: vi.fn(async () => []),
    getManifest: vi.fn(async () => ({})),
  },
}));

import { commands } from "@/lib/commands";
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
    expect(found[0].source).toEqual({
      kind: "IngressRoute",
      name: "argocd-server",
      namespace: "argocd",
    });
    // The proxy's flags were not read here, so the scheme is unsettled — and
    // saying so is the point.
    expect(found[0].tls).toBeNull();
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
