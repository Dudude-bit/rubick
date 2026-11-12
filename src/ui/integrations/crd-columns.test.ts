import { describe, expect, it } from "vite-plus/test";

import type { CrdView } from "./registry";

/** Every CRD view, by glob, so one nobody remembered to list is still held to it. */
const MODULES = import.meta.glob<Record<string, unknown>>(
  ["./**/crd.ts", "./gateway-crd.ts"],
  { eager: true }
);

const VIEWS = Object.entries(MODULES).flatMap(([path, module]) =>
  Object.values(module)
    .filter(
      (value): value is CrdView =>
        typeof value === "object" && value !== null && "columnsFor" in value
    )
    .map((view) => ({ path, view }))
);

/**
 * Scylla's kinds all carry the same three conditions, and its default is one
 * column folding them: written for the kinds it does not name, not borrowed
 * from one of them.
 */
const WRITTEN_FOR_EVERY_KIND = new Set(["./scylla/crd.ts"]);

describe("the columns a vendor draws for a kind it does not describe", () => {
  /**
   * A vendor's columns replace the printer columns the CRD declares. With
   * another kind's columns as the default, a PeerAuthentication read "ALLOW,
   * No rules" and a TLSStore "TLS: No". Fails if any view answers a kind it
   * does not name with columns of its own.
   */
  it("are none, so the CRD's own printer columns are drawn", () => {
    expect(VIEWS.length).toBeGreaterThan(10);
    const inventing = VIEWS.filter(
      ({ path, view }) =>
        !WRITTEN_FOR_EVERY_KIND.has(path) &&
        view.columnsFor("KindNobodyDescribes").length > 0
    ).map(({ path }) => path);

    expect(inventing).toEqual([]);
  });

  /**
   * The finding itself, by name: an mTLS mode has no action, a TLSStore is
   * not a route. Fails if either is handed a neighbour's columns again.
   */
  it("are none for the Istio and Traefik kinds that were drawn as their neighbours", () => {
    const columns = (path: string, kind: string) =>
      VIEWS.find((entry) => entry.path === path)!.view.columnsFor(kind);

    for (const kind of [
      "PeerAuthentication",
      "RequestAuthentication",
      "Sidecar",
      "EnvoyFilter",
      "Telemetry",
    ]) {
      expect(columns("./istio/crd.ts", kind)).toEqual([]);
    }
    for (const kind of ["TLSStore", "ServersTransport", "TraefikService"]) {
      expect(columns("./traefik/crd.ts", kind)).toEqual([]);
    }
  });

  /**
   * The other half: a kind whose columns used to arrive through the default
   * arm is named now. Fails if one of them lost its columns to a misspelt
   * case, which would draw printer columns and break nothing.
   */
  it("are still the vendor's own for every kind it does describe", () => {
    const described: Record<string, string[]> = {
      "./istio/crd.ts": ["VirtualService", "AuthorizationPolicy", "Gateway"],
      "./traefik/crd.ts": ["IngressRoute", "Middleware", "TLSOption"],
      "./azure/crd.ts": ["AzureIdentity", "AzureIdentityBinding"],
      "./google-cloud/crd.ts": ["BackendConfig", "FrontendConfig"],
      "./aws/crd.ts": ["TargetGroupBinding", "IngressClassParams"],
      "./argocd/crd.ts": ["Application", "ApplicationSet", "AppProject"],
      "./flux/crd.ts": ["HelmRelease", "HelmRepository", "HelmChart"],
      "./cert-manager/crd.ts": ["Certificate", "Issuer", "ClusterIssuer"],
      "./cloudnativepg/crd.ts": ["Cluster", "Backup", "Pooler"],
      "./gateway-crd.ts": [
        "Gateway",
        "HTTPRoute",
        "GRPCRoute",
        "TLSRoute",
        "TCPRoute",
        "UDPRoute",
      ],
    };
    const bare = Object.entries(described).flatMap(([path, kinds]) => {
      const view = VIEWS.find((entry) => entry.path === path)!.view;
      return kinds
        .filter((kind) => view.columnsFor(kind).length === 0)
        .map((kind) => `${path} ${kind}`);
    });

    expect(bare).toEqual([]);
  });
});
