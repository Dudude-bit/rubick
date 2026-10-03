/**
 * The join a `Certificate` cannot make about itself.
 *
 * It names a Secret and some DNS names and stops. What mounts that Secret is
 * elsewhere, and on the cluster this was written against it is a Google load
 * balancer's Ingress two hops in front of Traefik — so "thirty days left" was
 * true and useless, because nothing said which address goes dark.
 */

import { describe, expect, it } from "vitest";

import type { IngressInfo } from "@/generated/types";
import { certificateUse, uncovered } from "./serves";

const ingress = (
  overrides: Partial<IngressInfo> & { host?: string } = {}
): IngressInfo => {
  const { host = "shop.example.com", ...rest } = overrides;
  return {
    name: "edge",
    namespace: "web",
    className: "gce",
    rules: [
      {
        host,
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
    loadBalancerIps: [],
    tlsHosts: [host],
    tlsConfigs: [{ hosts: [host], secretName: "shop-tls", isCatchAll: false }],
    hasCatchAllTls: false,
    defaultBackend: null,
    labels: {},
    annotations: {},
    createdAt: null,
    ...rest,
  };
};

const cert = (dnsNames: string[]) => ({
  secretName: "shop-tls",
  namespace: "web",
  dnsNames,
});

describe("what a certificate is serving", () => {
  it("finds the host through the Ingress that mounts its Secret", () => {
    const use = certificateUse(cert(["shop.example.com"]), [ingress()], {
      unusedIsCertain: true,
    });

    expect(use.hosts).toEqual([
      {
        host: "shop.example.com",
        ingress: { name: "edge", namespace: "web" },
        covered: true,
      },
    ]);
  });

  /** A Secret is namespaced; an Ingress may only mount one of its own. */
  it("ignores an Ingress in another namespace", () => {
    const use = certificateUse(
      cert(["shop.example.com"]),
      [ingress({ namespace: "other" })],
      { unusedIsCertain: true }
    );
    expect(use.hosts).toEqual([]);
  });

  /** A `tls` entry with no hosts covers every rule the Ingress carries. */
  it("reads a catch-all entry as covering the Ingress's own hosts", () => {
    const use = certificateUse(
      cert(["shop.example.com"]),
      [
        ingress({
          tlsConfigs: [{ hosts: [], secretName: "shop-tls", isCatchAll: true }],
        }),
      ],
      { unusedIsCertain: true }
    );
    expect(use.hosts.map((entry) => entry.host)).toEqual(["shop.example.com"]);
  });

  /** The pair somebody sets up so they never think about it again. */
  it("accepts a wildcard that covers the served host", () => {
    const use = certificateUse(
      cert(["*.example.com", "example.com"]),
      [ingress()],
      { unusedIsCertain: true }
    );
    expect(uncovered(use)).toEqual([]);
  });

  /**
   * The failure every other surface in the app draws as healthy: the Secret
   * is populated, the certificate is `Ready` and valid, the Ingress is
   * serving — and a browser refuses the connection because the name is wrong.
   */
  it("names a host the certificate does not carry", () => {
    const use = certificateUse(cert(["other.example.com"]), [ingress()], {
      unusedIsCertain: true,
    });

    expect(uncovered(use).map((entry) => entry.host)).toEqual([
      "shop.example.com",
    ]);
  });

  /** A wildcard reaches one label, so a deeper name is still uncovered. */
  it("does not stretch a wildcard past one label", () => {
    const use = certificateUse(
      cert(["*.example.com"]),
      [ingress({ host: "a.shop.example.com" })],
      { unusedIsCertain: true }
    );
    expect(uncovered(use)).toHaveLength(1);
  });

  /**
   * "Nothing uses this" is a claim about the whole cluster, and this file
   * reads Ingresses only. A certificate mounted by a Traefik `IngressRoute`
   * would be deleted on the strength of it.
   */
  it("carries whether an absence may be stated at all", () => {
    expect(
      certificateUse(cert(["shop.example.com"]), [], { unusedIsCertain: false })
        .unusedIsCertain
    ).toBe(false);
  });
});
