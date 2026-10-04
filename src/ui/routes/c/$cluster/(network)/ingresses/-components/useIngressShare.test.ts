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

  it("names the class, the host count and TLS, and warns with no load balancer address", () => {
    const stats = ingressStats(ingress, undefined, tls, t);
    expect(stats).toMatchObject([
      { value: "nginx" },
      { value: "1" },
      { value: "expires in 4 days", role: "warn" },
      { role: "warn" },
    ]);
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
