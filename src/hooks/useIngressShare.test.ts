import { describe, expect, it } from "vitest";

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
  it("names the class, the host and TLS counts, and warns with no load balancer address", () => {
    const stats = ingressStats(ingress, undefined, t);
    expect(stats).toMatchObject([
      { value: "nginx" },
      { value: "1" },
      { value: "1" },
      { role: "warn" },
    ]);
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
