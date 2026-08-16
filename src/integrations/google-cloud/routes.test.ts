/**
 * The joins that make this a page rather than three list pages.
 *
 * Everything here is an *annotation* edge, and the point of pinning it is
 * that none of these objects references the other: an Ingress names a
 * `ManagedCertificate` in metadata, the certificate names nothing back, and
 * neither one can be read alone to answer which hostname is not being served.
 */

import { describe, expect, it } from "vitest";

import type {
  CustomResourceInfo,
  IngressInfo,
  ServiceInfo,
} from "@/generated/types";
import {
  allowsHttp,
  gceClassOf,
  managedCertificateRefs,
  negForIngress,
} from "./model";
import {
  claimed,
  countHosts,
  hostsOf,
  ignoredByClassName,
  type GkeSources,
} from "./routes";

const ingress = (
  overrides: Partial<IngressInfo> & { host?: string } = {}
): IngressInfo => {
  const { host = "shop.example.com", ...rest } = overrides;
  return {
    name: "shop",
    namespace: "web",
    className: null,
    rules: [
      {
        host,
        paths: [
          {
            path: "/",
            pathType: "Prefix",
            backendService: "storefront",
            backendPort: "80",
            resourceBackend: null,
          },
        ],
      },
    ],
    loadBalancerIps: ["34.1.2.3"],
    tlsHosts: [],
    tlsConfigs: [],
    hasCatchAllTls: false,
    defaultBackend: null,
    labels: {},
    annotations: { "kubernetes.io/ingress.class": "gce" },
    createdAt: null,
    ...rest,
  };
};

const custom = (
  kind: string,
  name: string,
  spec: unknown,
  status: unknown = null
): CustomResourceInfo => ({
  name,
  namespace: "web",
  uid: name,
  apiVersion: "networking.gke.io/v1",
  kind,
  spec,
  status,
  labels: {},
  annotations: {},
  createdAt: null,
  ownerReferences: [],
});

const service = (annotations: Record<string, string> = {}): ServiceInfo =>
  ({
    name: "storefront",
    namespace: "web",
    uid: "svc",
    type: "ClusterIP",
    selector: { app: "storefront" },
    annotations,
    labels: {},
    ports: [],
    clusterIp: "10.0.0.1",
    externalIps: [],
    createdAt: null,
  }) as unknown as ServiceInfo;

const sources = (overrides: Partial<GkeSources> = {}): GkeSources => ({
  ingresses: [ingress()],
  backendConfigs: [],
  frontendConfigs: [],
  managedCertificates: [],
  services: [service()],
  published: [],
  backingKnown: false,
  ...overrides,
});

describe("which Ingresses GKE serves", () => {
  /**
   * GKE reads the annotation and *ignores* `spec.ingressClassName` — the
   * opposite of every other controller in this tree. An Ingress written the
   * way Kubernetes documents is correct YAML with no events and no error on
   * it, and is served by nothing at all.
   */
  it("claims by annotation and not by ingressClassName", () => {
    expect(gceClassOf({ "kubernetes.io/ingress.class": "gce" })).toBe("gce");
    expect(gceClassOf({ "kubernetes.io/ingress.class": "nginx" })).toBeNull();
    expect(gceClassOf({})).toBeNull();

    const written = ingress({ className: "gce", annotations: {} });
    expect(claimed([written])).toEqual([]);
    expect(ignoredByClassName([written])).toHaveLength(1);
  });

  /** An Ingress with the annotation is not "ignored" whatever the field says. */
  it("does not report an annotated Ingress as ignored", () => {
    expect(ignoredByClassName([ingress({ className: "gce" })])).toEqual([]);
  });

  /**
   * A claimed Ingress with no rules at all — `spec.defaultBackend` sends
   * everything to one Service, the ordinary way a Google load balancer
   * fronts an in-cluster proxy. Read through `rules` alone it produced zero
   * hosts, and the page then told a cluster with a live, TLS-terminating
   * GKE load balancer that GKE serves nothing here.
   */
  it("draws a defaultBackend-only Ingress as the catch-all host", () => {
    const edge = ingress({
      rules: [],
      defaultBackend: {
        backendService: "storefront",
        backendPort: "80",
        resourceBackend: null,
      },
    });

    const hosts = hostsOf(sources({ ingresses: [edge] }));

    expect(hosts).toHaveLength(1);
    expect(hosts[0].host).toBeNull();
    expect(hosts[0].routes).toHaveLength(1);
    expect(hosts[0].routes[0].backend).toEqual({
      name: "storefront",
      port: "80",
    });
    expect(hosts[0].fronts.map((front) => front.ingress.name)).toEqual([
      "shop",
    ]);
    expect(countHosts([edge])).toBe(1);
  });
});

describe("reading the metadata GKE acts on", () => {
  it("defaults the HTTP listener to on and reads it off", () => {
    expect(allowsHttp({})).toBe(true);
    expect(allowsHttp({ "kubernetes.io/ingress.allow-http": "false" })).toBe(
      false
    );
  });

  it("reads a comma-separated certificate list", () => {
    expect(
      managedCertificateRefs({
        "networking.gke.io/managed-certificates": "shop-cert, www-cert",
      })
    ).toEqual(["shop-cert", "www-cert"]);
    expect(managedCertificateRefs({})).toEqual([]);
  });

  it("reads the NEG opt-in and survives a malformed one", () => {
    expect(negForIngress({ "cloud.google.com/neg": '{"ingress":true}' })).toBe(
      true
    );
    expect(negForIngress({ "cloud.google.com/neg": '{"ingress":false}' })).toBe(
      false
    );
    expect(negForIngress({ "cloud.google.com/neg": "not json" })).toBe(false);
  });
});

describe("what a host is joined to", () => {
  it("resolves the objects the annotations name", () => {
    const [host] = hostsOf(
      sources({
        ingresses: [
          ingress({
            annotations: {
              "kubernetes.io/ingress.class": "gce",
              "networking.gke.io/v1beta1.FrontendConfig": "shop-fc",
              "networking.gke.io/managed-certificates": "shop-cert",
            },
          }),
        ],
        frontendConfigs: [
          custom("FrontendConfig", "shop-fc", {
            redirectToHttps: { enabled: true },
          }),
        ],
        managedCertificates: [
          custom(
            "ManagedCertificate",
            "shop-cert",
            { domains: ["shop.example.com"] },
            { certificateStatus: "Active", domainStatus: [] }
          ),
        ],
        backendConfigs: [
          custom("BackendConfig", "shop-bc", { timeoutSec: 60 }),
        ],
        services: [
          service({
            "cloud.google.com/backend-config": '{"default":"shop-bc"}',
          }),
        ],
      })
    );

    expect(host.host).toBe("shop.example.com");
    expect(host.fronts[0].frontendConfig?.found).toBeDefined();
    expect(host.fronts[0].certificates[0].status).toBe("Active");
    expect(host.routes[0].configs[0].found).toBeDefined();
    expect(host.findings).toEqual([]);
  });

  /**
   * The silent GKE failure: the name is accepted, nothing validates it, and
   * the Ingress keeps every default the reader thought they had overridden.
   */
  it("reports a FrontendConfig that resolves to nothing", () => {
    const [host] = hostsOf(
      sources({
        ingresses: [
          ingress({
            annotations: {
              "kubernetes.io/ingress.class": "gce",
              "networking.gke.io/v1beta1.FrontendConfig": "absent-fc",
            },
          }),
        ],
      })
    );

    expect(host.worst).toBe("err");
    expect(host.findings).toContainEqual(
      expect.objectContaining({
        kind: "missing-object",
        what: "FrontendConfig",
      })
    );
  });

  /**
   * The finding neither object can produce alone. Google provisions a domain
   * by reaching *this* load balancer at that name; a domain no rule serves
   * sits on FailedNotVisible for ever, and the certificate's own status says
   * only that, which reads as a DNS problem.
   */
  it("names a certificate domain no rule serves", () => {
    const [host] = hostsOf(
      sources({
        ingresses: [
          ingress({
            annotations: {
              "kubernetes.io/ingress.class": "gce",
              "networking.gke.io/managed-certificates": "shop-cert",
            },
          }),
        ],
        managedCertificates: [
          custom(
            "ManagedCertificate",
            "shop-cert",
            { domains: ["shop.example.com", "www.example.com"] },
            { certificateStatus: "Provisioning", domainStatus: [] }
          ),
        ],
      })
    );

    expect(host.findings).toContainEqual(
      expect.objectContaining({
        kind: "domain-unserved",
        domain: "www.example.com",
      })
    );
    // The domain the Ingress does serve is not reported.
    expect(
      host.findings.filter(
        (finding) =>
          finding.kind === "domain-unserved" &&
          finding.domain === "shop.example.com"
      )
    ).toEqual([]);
  });

  /** No TLS of any kind and no HTTP listener is an Ingress that answers nothing. */
  it("says when an Ingress builds neither listener", () => {
    const [host] = hostsOf(
      sources({
        ingresses: [
          ingress({
            annotations: {
              "kubernetes.io/ingress.class": "gce",
              "kubernetes.io/ingress.allow-http": "false",
            },
          }),
        ],
      })
    );

    expect(host.findings).toContainEqual(
      expect.objectContaining({ kind: "no-tls" })
    );
  });

  /**
   * The case the reader reported: `*.example.com` and `example.com` on one
   * certificate, so nobody has to think about it again. Compared literally,
   * the wildcard was reported as a domain the Ingress does not serve — on
   * every subdomain it exists to serve.
   */
  it("does not call a wildcard unserved when it covers the host", () => {
    const [host] = hostsOf(
      sources({
        ingresses: [
          ingress({
            annotations: {
              "kubernetes.io/ingress.class": "gce",
              "networking.gke.io/managed-certificates": "wild",
            },
          }),
        ],
        managedCertificates: [
          custom(
            "ManagedCertificate",
            "wild",
            { domains: ["*.example.com"] },
            { certificateStatus: "Active", domainStatus: [] }
          ),
        ],
      })
    );

    expect(
      host.findings.filter((finding) => finding.kind === "domain-unserved")
    ).toEqual([]);
  });

  /**
   * And the fact that makes the wildcard a finding of its own *on GKE*:
   * Google-managed certificates do not do wildcards at all. The API server
   * takes the object, Google never issues it, and the status says
   * "Provisioning" for ever.
   */
  it("says a Google-managed certificate will never issue a wildcard", () => {
    const [host] = hostsOf(
      sources({
        ingresses: [
          ingress({
            annotations: {
              "kubernetes.io/ingress.class": "gce",
              "networking.gke.io/managed-certificates": "wild",
            },
          }),
        ],
        managedCertificates: [
          custom(
            "ManagedCertificate",
            "wild",
            { domains: ["*.example.com"] },
            { certificateStatus: "Provisioning", domainStatus: [] }
          ),
        ],
      })
    );

    expect(host.findings).toContainEqual(
      expect.objectContaining({ kind: "wildcard", domain: "*.example.com" })
    );
  });

  /** A wildcard covers one label, so the apex still needs naming. */
  it("still reports an apex the wildcard does not cover", () => {
    const [host] = hostsOf(
      sources({
        ingresses: [
          ingress({
            host: "shop.example.com",
            annotations: {
              "kubernetes.io/ingress.class": "gce",
              "networking.gke.io/managed-certificates": "pair",
            },
          }),
        ],
        managedCertificates: [
          custom(
            "ManagedCertificate",
            "pair",
            { domains: ["*.example.com", "example.com"] },
            { certificateStatus: "Provisioning", domainStatus: [] }
          ),
        ],
      })
    );

    expect(host.findings).toContainEqual(
      expect.objectContaining({
        kind: "domain-unserved",
        domain: "example.com",
      })
    );
  });
});
