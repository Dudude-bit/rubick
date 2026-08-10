import { describe, expect, it } from "vitest";

import type {
  CustomResourceInfo,
  ServiceInfo,
  ServicePublished,
} from "@/generated/types";
import {
  gatewayCovers,
  hostGroups,
  resolveHost,
  type IstioSources,
} from "./model";

function custom(
  kind: string,
  name: string,
  spec: Record<string, unknown>
): CustomResourceInfo {
  return {
    name,
    namespace: "mesh",
    uid: name,
    apiVersion: "networking.istio.io/v1",
    kind,
    spec,
    status: null,
    labels: {},
    annotations: {},
    createdAt: null,
    ownerReferences: [],
  };
}

function service(name: string): ServiceInfo {
  return {
    name,
    namespace: "mesh",
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
      namespace: "mesh",
      existence: "present",
      facts: null,
    },
    ready,
    draining: 0,
    notReady: 0,
    unrouted: 0,
  } as unknown as ServicePublished;
}

const gateway = custom("Gateway", "edge", {
  selector: { istio: "ingressgateway" },
  servers: [
    { port: { number: 80, protocol: "HTTP" }, hosts: ["shop.mesh.test"] },
  ],
});

const rule = custom("DestinationRule", "shop-dr", {
  host: "shop",
  subsets: [{ name: "v1" }, { name: "v2" }],
});

function sources(objects: {
  gateways?: CustomResourceInfo[];
  virtualServices: CustomResourceInfo[];
  destinationRules?: CustomResourceInfo[];
}): IstioSources {
  return {
    gateways: objects.gateways ?? [gateway],
    virtualServices: objects.virtualServices,
    destinationRules: objects.destinationRules ?? [rule],
    services: [service("shop")],
    published: [published("shop", 3)],
  };
}

const healthy = custom("VirtualService", "shop-vs", {
  hosts: ["shop.mesh.test"],
  gateways: ["edge"],
  http: [
    {
      match: [{ uri: { prefix: "/api" } }],
      route: [
        { destination: { host: "shop", subset: "v1" }, weight: 80 },
        { destination: { host: "shop", subset: "v2" }, weight: 20 },
      ],
    },
  ],
});

describe("the chain", () => {
  /** Would break if the healthy case stopped reading as healthy. */
  it("says nothing about a host whose chain resolves end to end", () => {
    const groups = hostGroups(sources({ virtualServices: [healthy] }));
    expect(groups).toHaveLength(1);
    expect(groups[0].host).toBe("shop.mesh.test");
    expect(groups[0].findings).toHaveLength(0);
    expect(groups[0].worst).toBeNull();
    expect(groups[0].gateways[0].serves).toBe(true);
    expect(groups[0].gateways[0].ports).toEqual(["HTTP:80"]);
  });

  /**
   * Would break if a VirtualService declaring four hosts drew one row. The
   * question is "what serves this hostname", and one object answering for
   * four of them is four answers.
   */
  it("draws one row per host, not one per object", () => {
    const many = custom("VirtualService", "many", {
      hosts: ["a.mesh.test", "b.mesh.test"],
      gateways: ["edge"],
      http: [{ route: [{ destination: { host: "shop" } }] }],
    });
    expect(hostGroups(sources({ virtualServices: [many] }))).toHaveLength(2);
  });
});

describe("resolving a destination host", () => {
  /** The three spellings Istio takes for the same Service. */
  it("reads a short name, a namespaced one and an FQDN as the same Service", () => {
    const services = [service("shop")];
    expect(resolveHost("shop", "mesh", services).service).toEqual({
      name: "shop",
      namespace: "mesh",
    });
    expect(resolveHost("shop.mesh", "other", services).service).toEqual({
      name: "shop",
      namespace: "mesh",
    });
    expect(
      resolveHost("shop.mesh.svc.cluster.local", "other", services).service
    ).toEqual({ name: "shop", namespace: "mesh" });
  });

  /**
   * Would break if a hostname outside the cluster started being reported as
   * a missing Service — which would be the page inventing an outage out of
   * a working ServiceEntry.
   */
  it("claims nothing about a host that is plainly not in this cluster", () => {
    const outside = resolveHost("api.stripe.com", "mesh", [service("shop")]);
    expect(outside.service).toBeNull();
    expect(outside.external).toBe(true);
  });
});

describe("a host no Gateway serves", () => {
  /**
   * The finding that has no status field anywhere. Istio accepts the
   * reference and the VirtualService simply never receives a request.
   */
  it("reports a gateway that does not exist", () => {
    const orphan = custom("VirtualService", "orphan-vs", {
      hosts: ["orphan.mesh.test"],
      gateways: ["no-such-gateway"],
      http: [{ route: [{ destination: { host: "shop" } }] }],
    });
    const groups = hostGroups(sources({ virtualServices: [orphan] }));
    const finding = groups[0].findings.find(
      (entry) => entry.kind === "noGateway"
    );
    expect(finding?.severity).toBe("err");
    expect(
      finding?.kind === "noGateway" && finding.gateways[0].gateway
    ).toBeNull();
  });

  /** Would break if a Gateway that exists and covers other hosts passed. */
  it("reports a gateway that exists and does not cover this host", () => {
    const elsewhere = custom("VirtualService", "elsewhere", {
      hosts: ["other.mesh.test"],
      gateways: ["edge"],
      http: [{ route: [{ destination: { host: "shop" } }] }],
    });
    const groups = hostGroups(sources({ virtualServices: [elsewhere] }));
    expect(groups[0].findings.map((entry) => entry.kind)).toContain(
      "noGateway"
    );
  });

  /**
   * Would break if in-mesh routing were reported as broken. A
   * VirtualService with no `gateways` is bound to the reserved `mesh`
   * gateway, which is the default and needs no object.
   */
  it("says nothing about a VirtualService for in-mesh traffic", () => {
    const inMesh = custom("VirtualService", "internal", {
      hosts: ["shop"],
      http: [{ route: [{ destination: { host: "shop" } }] }],
    });
    const groups = hostGroups(sources({ virtualServices: [inMesh] }));
    expect(groups[0].meshOnly).toBe(true);
    expect(groups[0].findings).toHaveLength(0);
  });

  /** The three host patterns a Gateway server may carry, and nothing else. */
  it("matches a Gateway's host patterns the way Istio does", () => {
    expect(gatewayCovers("*", "anything.test")).toBe(true);
    expect(gatewayCovers("shop.test", "shop.test")).toBe(true);
    expect(gatewayCovers("*.test", "shop.test")).toBe(true);
    expect(gatewayCovers("*.test", "shop.other")).toBe(false);
    // `ns/host` is about which VirtualServices may bind, not the hostname.
    expect(gatewayCovers("mesh/shop.test", "shop.test")).toBe(true);
  });
});

describe("a subset nothing defines", () => {
  /** Would break if a typo'd subset stopped being a 503 the page can name. */
  it("reports a route to a subset the DestinationRule does not declare", () => {
    const typo = custom("VirtualService", "typo-vs", {
      hosts: ["typo.mesh.test"],
      gateways: ["edge"],
      http: [{ route: [{ destination: { host: "shop", subset: "v3" } }] }],
    });
    const groups = hostGroups(sources({ virtualServices: [typo] }));
    const finding = groups[0].findings.find(
      (entry) => entry.kind === "noSubset"
    );
    expect(finding?.kind === "noSubset" && finding.defined).toEqual([
      "v1",
      "v2",
    ]);
    expect(finding?.kind === "noSubset" && finding.anyRule).toBe(true);
  });

  /** Would break if "no rule at all" and "wrong subset" stopped differing. */
  it("distinguishes no DestinationRule at all from the wrong subset", () => {
    const typo = custom("VirtualService", "typo-vs", {
      hosts: ["typo.mesh.test"],
      gateways: ["edge"],
      http: [{ route: [{ destination: { host: "shop", subset: "v3" } }] }],
    });
    const groups = hostGroups(
      sources({ virtualServices: [typo], destinationRules: [] })
    );
    const finding = groups[0].findings.find(
      (entry) => entry.kind === "noSubset"
    );
    expect(finding?.kind === "noSubset" && finding.anyRule).toBe(false);
  });

  /**
   * Would break if a DestinationRule on the short name stopped covering a
   * route written as an FQDN. Istio resolves both to one Service, and a page
   * comparing the strings would call a working mesh broken.
   */
  it("matches a DestinationRule to a route written as an FQDN", () => {
    const fqdn = custom("VirtualService", "fqdn-vs", {
      hosts: ["fqdn.mesh.test"],
      gateways: ["edge"],
      http: [
        {
          route: [
            {
              destination: {
                host: "shop.mesh.svc.cluster.local",
                subset: "v1",
              },
            },
          ],
        },
      ],
    });
    const groups = hostGroups(sources({ virtualServices: [fqdn] }));
    expect(
      groups[0].findings.filter((entry) => entry.kind === "noSubset")
    ).toHaveLength(0);
  });
});

describe("weights", () => {
  /** Would break if a split that does not add up went unnoticed. */
  it("reports weights that do not add up to a hundred", () => {
    const skewed = custom("VirtualService", "skewed-vs", {
      hosts: ["skewed.mesh.test"],
      gateways: ["edge"],
      http: [
        {
          route: [
            { destination: { host: "shop", subset: "v1" }, weight: 60 },
            { destination: { host: "shop", subset: "v2" }, weight: 30 },
          ],
        },
      ],
    });
    const groups = hostGroups(sources({ virtualServices: [skewed] }));
    const finding = groups[0].findings.find(
      (entry) => entry.kind === "weights"
    );
    expect(finding?.kind === "weights" && finding.sum).toBe(90);
    expect(finding?.severity).toBe("warn");
  });

  /** Would break if a route with no weights at all were called wrong. */
  it("says nothing when no destination states a weight", () => {
    const plain = custom("VirtualService", "plain-vs", {
      hosts: ["plain.mesh.test"],
      gateways: ["edge"],
      http: [{ route: [{ destination: { host: "shop" } }] }],
    });
    const groups = hostGroups(sources({ virtualServices: [plain] }));
    expect(
      groups[0].findings.filter((entry) => entry.kind === "weights")
    ).toHaveLength(0);
  });

  /** Would break if the healthy 80/20 split started reading as a finding. */
  it("says nothing about weights that add up", () => {
    const groups = hostGroups(sources({ virtualServices: [healthy] }));
    expect(
      groups[0].findings.filter((entry) => entry.kind === "weights")
    ).toHaveLength(0);
  });
});

describe("ordering", () => {
  /** Would break if the page stopped putting the outage first. */
  it("orders hosts by trouble rather than by name", () => {
    const broken = custom("VirtualService", "zzz", {
      hosts: ["zzz.mesh.test"],
      gateways: ["no-such-gateway"],
      http: [{ route: [{ destination: { host: "shop" } }] }],
    });
    const groups = hostGroups(sources({ virtualServices: [healthy, broken] }));
    expect(groups[0].host).toBe("zzz.mesh.test");
  });
});
