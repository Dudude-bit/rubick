import { describe, expect, it } from "vitest";

import type {
  CustomResourceInfo,
  ServiceInfo,
  ServicePublished,
} from "@/generated/types";
import { backingFrom, hostSeverity } from "../ingress";
import {
  gatewayCovers,
  hostGroups,
  hostState,
  resolveHost,
  type IstioSources,
} from "./model";
import { routingMap } from "./map";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";

/** The English catalogue — what these expectations are written in. */
const t: T = (section, key, values) => translate("en", section, key, values);

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
    generation: null,
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
    backingKnown: true,
    backingError: null,
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
    const groups = hostGroups(sources({ virtualServices: [healthy] }), t);
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
    expect(hostGroups(sources({ virtualServices: [many] }), t)).toHaveLength(2);
  });
});

describe("a host whose backends are unread", () => {
  /**
   * Would break if the host went back to green "routing" while the Services
   * list was refused: no stop was found because nothing was looked at.
   */
  it("reads as unknown rather than routing", () => {
    const [group] = hostGroups(
      {
        ...sources({ virtualServices: [healthy] }),
        ...backingFrom(undefined, new Error("services is forbidden")),
      },
      t
    );
    expect(hostSeverity(group)).toBe("unknown");
    expect(hostState(group, "services is forbidden", t)).toEqual({
      text: t("empty", "endpointsUnread"),
      tone: "unknown",
    });
  });

  /** The same host with its Services read is routing. */
  it("reads as routing once they are read", () => {
    const [group] = hostGroups(sources({ virtualServices: [healthy] }), t);
    expect(hostSeverity(group)).toBeNull();
    expect(hostState(group, null, t).tone).toBe("ok");
  });
});

describe("resolving a destination host", () => {
  /** The three spellings Istio takes for the same Service. */
  it("reads a short name, a namespaced one and an FQDN as the same Service", () => {
    const services = [service("shop")];
    expect(resolveHost("shop", "mesh", services, true).service).toEqual({
      name: "shop",
      namespace: "mesh",
    });
    expect(resolveHost("shop.mesh", "other", services, true).service).toEqual({
      name: "shop",
      namespace: "mesh",
    });
    expect(
      resolveHost("shop.mesh.svc.cluster.local", "other", services, true)
        .service
    ).toEqual({ name: "shop", namespace: "mesh" });
  });

  /**
   * Would break if a hostname outside the cluster started being reported as
   * a missing Service — which would be the page inventing an outage out of
   * a working ServiceEntry.
   */
  it("claims nothing about a host that is plainly not in this cluster", () => {
    const outside = resolveHost(
      "api.stripe.com",
      "mesh",
      [service("shop")],
      true
    );
    expect(outside.service).toBeNull();
    expect(outside.external).toBe(true);
  });

  /**
   * `name.namespace` is told from a hostname by the Services list. Unread,
   * it was resolved as "outside the cluster" — a claim about a list nobody
   * got. Fails if an unread list decides it either way.
   */
  it("leaves a name.namespace host undecided while the Services are unread", () => {
    expect(resolveHost("shop.payments", "mesh", [], false)).toEqual({
      service: { name: "shop", namespace: "payments" },
      external: null,
    });
    expect(resolveHost("api.stripe.com", "mesh", [], false).external).toBe(
      true
    );
  });
});

describe("a subset on a host the Services list would decide", () => {
  /**
   * With the Services unread, `shop.mesh` was taken for a hostname, the
   * DestinationRule written for the Service did not match it, and the host
   * went red with "subset not defined" on a cluster that only refused this
   * token the Services. Fails if the unread host stops resolving to the
   * Service a rule can be written for.
   */
  it("does not report a missing subset the Service's rule defines", () => {
    const qualified = custom("VirtualService", "shop-vs", {
      hosts: ["shop.mesh.test"],
      gateways: ["edge"],
      http: [{ route: [{ destination: { host: "shop.mesh", subset: "v1" } }] }],
    });
    const fqdnRule = custom("DestinationRule", "shop-dr", {
      host: "shop.mesh.svc.cluster.local",
      subsets: [{ name: "v1" }],
    });
    const unread = {
      ...sources({
        virtualServices: [qualified],
        destinationRules: [fqdnRule],
      }),
      ...backingFrom(undefined, new Error("services is forbidden")),
    };
    const groups = hostGroups(unread, t);
    const [group] = groups;

    expect(group.findings.map((finding) => finding.kind)).toEqual([]);
    expect(group.backendsKnown).toBe(false);
    expect(hostSeverity(group)).toBe("unknown");

    // The map drew it "outside the mesh", quiet — and must not link a
    // Service nobody has seen.
    const node = routingMap(groups, unread, t)
      .columns.flatMap((column) => column.nodes)
      .find((candidate) => candidate.label === "shop");
    expect(node?.tone).toBe("unknown");
    expect(node?.object).toBeUndefined();
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
    const groups = hostGroups(sources({ virtualServices: [orphan] }), t);
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
    const groups = hostGroups(sources({ virtualServices: [elsewhere] }), t);
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
    const groups = hostGroups(sources({ virtualServices: [inMesh] }), t);
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
    const groups = hostGroups(sources({ virtualServices: [typo] }), t);
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
      sources({ virtualServices: [typo], destinationRules: [] }),
      t
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
    const groups = hostGroups(sources({ virtualServices: [fqdn] }), t);
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
    const groups = hostGroups(sources({ virtualServices: [skewed] }), t);
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
    const groups = hostGroups(sources({ virtualServices: [plain] }), t);
    expect(
      groups[0].findings.filter((entry) => entry.kind === "weights")
    ).toHaveLength(0);
  });

  /** Would break if the healthy 80/20 split started reading as a finding. */
  it("says nothing about weights that add up", () => {
    const groups = hostGroups(sources({ virtualServices: [healthy] }), t);
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
    const groups = hostGroups(
      sources({ virtualServices: [healthy, broken] }),
      t
    );
    expect(groups[0].host).toBe("zzz.mesh.test");
  });
});
