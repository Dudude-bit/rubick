import { describe, expect, it } from "vitest";

import type {
  IngressClassSummary,
  IngressInfo,
  ServiceInfo,
} from "@/generated/types";

import { routingMap } from "./map";
import { hostGroups, type TraefikSources } from "./model";

const TRAEFIK_CLASS: IngressClassSummary = {
  name: "traefik",
  controller: "traefik.io/ingress-controller",
  isDefault: true,
};

function ingress(
  name: string,
  host: string,
  over: { service?: string; secretName?: string; at?: string[] } = {}
): IngressInfo {
  return {
    name,
    namespace: "shop",
    className: "traefik",
    rules: [
      {
        host,
        paths: [
          {
            path: "/",
            pathType: "Prefix",
            backendService: over.service ?? "web",
            backendPort: "80",
            resourceBackend: null,
          },
        ],
      },
    ],
    loadBalancerIps: over.at ?? [],
    tlsHosts: over.secretName ? [host] : [],
    tlsConfigs: over.secretName
      ? [{ hosts: [host], secretName: over.secretName, isCatchAll: false }]
      : [],
    hasCatchAllTls: false,
    labels: {},
    annotations: {},
    createdAt: null,
  };
}

const service = (name: string): ServiceInfo => ({
  name,
  namespace: "shop",
  uid: name,
  type: "ClusterIP",
  sessionAffinity: "None",
  clusterIp: "10.0.0.1",
  externalIps: [],
  loadBalancerIps: [],
  ports: [],
  selector: { app: name },
  labels: {},
  annotations: {},
  createdAt: null,
});

function sources(over: Partial<TraefikSources> = {}): TraefikSources {
  return {
    ingresses: [],
    ingressRoutes: [],
    classes: [TRAEFIK_CLASS],
    services: [],
    published: [],
    middlewares: [],
    entryPoints: [
      { name: "web", address: ":80", tls: false, redirectTo: null },
      { name: "websecure", address: ":443", tls: true, redirectTo: null },
    ],
    ...over,
  };
}

function mapOf(over: Partial<TraefikSources>) {
  const src = sources(over);
  return routingMap(hostGroups(src), src);
}

describe("the routing map", () => {
  /**
   * The shape the chain cannot show and the reason this view exists: two
   * hostnames landing on one Service is invisible in a list however it is
   * ordered, and it is exactly what somebody is looking for when one of the
   * two stops working.
   */
  it("draws one Service node however many hosts reach it", () => {
    const map = mapOf({
      ingresses: [
        ingress("shop", "shop.example.com"),
        ingress("promo", "promo.example.com"),
      ],
      services: [service("web")],
    });

    const [entries, hosts, services] = map.columns;
    expect(hosts.nodes).toHaveLength(2);
    expect(services.nodes).toHaveLength(1);
    expect(entries.nodes.map((node) => node.label)).toEqual([
      "web",
      "websecure",
    ]);
    // Both hosts point at the one Service, and both entry points carry both.
    expect(
      map.edges.filter((edge) => edge.to === services.nodes[0].id)
    ).toHaveLength(2);
  });

  /**
   * Would break the one mark on this view that is worth a colour. A host
   * reachable in the clear is not an outage and must not be red, but it is
   * the thing somebody scanning a routing map is looking for.
   */
  it("marks a host with no certificate, and one with", () => {
    const map = mapOf({
      ingresses: [
        ingress("shop", "shop.example.com", { secretName: "shop-tls" }),
        ingress("promo", "promo.example.com"),
      ],
      services: [service("web")],
    });

    const byLabel = new Map(
      map.columns[1].nodes.map((node) => [node.label, node])
    );
    expect(byLabel.get("shop.example.com")?.tag?.text).toBe("TLS");
    expect(byLabel.get("promo.example.com")?.tag).toEqual({
      text: "no TLS",
      tone: "warn",
    });
  });

  /**
   * Would have the map invent an outage out of a supported configuration.
   * Traefik's own internals have no endpoints by design, so a node for them
   * would sit there reporting nothing behind it forever.
   */
  it("gives no Service node to a backend that is not one", () => {
    const map = mapOf({
      ingressRoutes: [
        {
          name: "dashboard",
          namespace: "shop",
          uid: "u1",
          apiVersion: "traefik.io/v1alpha1",
          kind: "IngressRoute",
          spec: {
            entryPoints: ["websecure"],
            routes: [
              {
                match: "Host(`traefik.example.com`)",
                kind: "Rule",
                services: [{ name: "api@internal", kind: "TraefikService" }],
              },
            ],
          },
          status: null,
          labels: {},
          annotations: {},
          createdAt: null,
          ownerReferences: [],
        },
      ],
    });

    expect(map.columns[1].nodes).toHaveLength(1);
    expect(map.columns[2].nodes).toHaveLength(0);
  });

  /**
   * The number the map exists to save a trip for: a hostname is only half an
   * address until something says what it resolves to, and the cluster already
   * says it on `status.loadBalancer`.
   */
  it("puts the published address on the host it belongs to", () => {
    const map = mapOf({
      ingresses: [
        ingress("shop", "shop.example.com", { at: ["203.0.113.10"] }),
        ingress("promo", "promo.example.com"),
      ],
      services: [service("web")],
    });

    const byLabel = new Map(
      map.columns[1].nodes.map((node) => [node.label, node])
    );
    expect(byLabel.get("shop.example.com")?.sub).toBe("1 path · 203.0.113.10");
    // Nothing published, nothing claimed.
    expect(byLabel.get("promo.example.com")?.sub).toBe("1 path");
  });

  it("sends a host to its own paths rather than nowhere", () => {
    const map = mapOf({
      ingresses: [ingress("shop", "shop.example.com")],
      services: [service("web")],
    });
    expect(map.columns[1].nodes[0].to).toBe("?tab=routes&q=shop.example.com");
  });
});
