import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import type { IngressInfo } from "@/generated/types";
import {
  ingressRulesSection,
  ingressStats,
  ingressTlsSection,
} from "./useIngressShare";

const t: T = (section, key, values) => translate("en", section, key, values);

const ingress: IngressInfo = {
  name: "shop",
  namespace: "shop",
  className: "nginx",
  rules: [
    {
      host: "shop.example.com",
      paths: [
        {
          path: "/",
          pathType: "Prefix",
          backendService: "web",
          backendPort: "80",
          resourceBackend: null,
        },
      ],
    },
  ],
  defaultBackend: null,
  loadBalancerIps: [],
  tlsHosts: ["shop.example.com"],
  tlsConfigs: [
    { hosts: ["shop.example.com"], secretName: "shop-tls", isCatchAll: false },
  ],
  hasCatchAllTls: false,
  labels: {},
  annotations: {},
  createdAt: null,
};

describe("what the Ingress report leads with", () => {
  const tls = { text: "expires in 4 days", tone: "warn" as const, known: true };

  const served = {
    requested: "nginx",
    resolved: "nginx",
    controller: "k8s.io/ingress-nginx",
    viaDefault: false,
    available: [],
  };

  it("names the class, the host count and TLS, and warns while a served class's address is pending", () => {
    const stats = ingressStats(ingress, served, tls, t);
    expect(stats).toMatchObject([
      { value: "nginx · k8s.io/ingress-nginx" },
      { value: "1" },
      { value: "expires in 4 days", role: "warn" },
      { value: "pending", role: "warn" },
    ]);
  });

  /**
   * Sam's Ingress shop said "Load balancer: pending" beside "nothing picks
   * this Ingress up ... never will": IngressClass traefik does not exist.
   * Fails if an address nothing can assign is called pending again.
   */
  it("says nothing can assign an address when nothing serves the class", () => {
    const [, , , stat] = ingressStats(
      { ...ingress, className: "traefik" },
      {
        requested: "traefik",
        resolved: null,
        controller: null,
        viaDefault: false,
        available: [],
      },
      tls,
      t
    );
    expect(stat).toMatchObject({
      value: "none: nothing serves its class to assign one",
      role: "err",
    });
  });

  /** The shared file named the class bare, in red, with no word for why; the page said it does not exist. Fails if the two part. */
  it("says the class does not exist, in the page's words", () => {
    const [stat] = ingressStats(
      { ...ingress, className: "traefik" },
      {
        requested: "traefik",
        resolved: null,
        controller: null,
        viaDefault: false,
        available: [],
      },
      tls,
      t
    );
    expect(stat).toMatchObject({
      value: "traefik: no IngressClass by that name",
      role: "err",
    });
  });

  /** Fails if a class nobody could read is drawn as pending or as none. */
  it("says the address is unknown when the class could not be read", () => {
    const [, , , stat] = ingressStats(ingress, undefined, tls, t);
    expect(stat).toMatchObject({ value: "unknown", role: "neutral" });
  });

  /**
   * The page says the certificate has expired, in red; the file said
   * "TLS 2", a count of hosts. It carries the page's own reading now.
   */
  it("carries the page's TLS reading and its tone, not a count of hosts", () => {
    const [, , stat] = ingressStats(
      ingress,
      undefined,
      { text: "expired 3 days ago", tone: "err", known: true },
      t
    );
    expect(stat).toMatchObject({ value: "expired 3 days ago", role: "err" });
  });

  /** A host nobody could check TLS for is not a host without it. */
  it("draws TLS the page could not check without colour", () => {
    const [, , stat] = ingressStats(
      ingress,
      undefined,
      { text: "TLS not checked", tone: null, known: false },
      t
    );
    expect(stat).toMatchObject({ value: "TLS not checked", role: "neutral" });
  });
});

describe("the rules table", () => {
  it("routes each path to its backend Service as a reference, deleting this breaks the row content", () => {
    const section = ingressRulesSection(ingress, t);
    expect(section.body).toMatchObject({
      type: "table",
      rows: [
        {
          cells: [
            { text: "shop.example.com" },
            { text: "/" },
            { text: "Prefix" },
            { text: "web", ref: { kind: "Service" } },
            { text: "80" },
          ],
        },
      ],
    });
  });
});

describe("the TLS table", () => {
  it("points each host set at the Secret that carries its certificate", () => {
    const section = ingressTlsSection(ingress, t);
    expect(section.body).toMatchObject({
      type: "table",
      rows: [
        {
          cells: [
            { text: "shop.example.com" },
            { text: "shop-tls", ref: { kind: "Secret" } },
          ],
        },
      ],
    });
  });
});
