import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";

import { reportOf } from "./report";

const t: T = (section, key, values) => translate("en", section, key, values);

describe("what a Certificate tells a reader with no cluster access", () => {
  it("reports readiness, the expiry, the issuer, the DNS names and the secret", () => {
    const sections = reportOf(
      {
        group: "cert-manager.io",
        kind: "Certificate",
        namespace: "shop",
        name: "shop-tls",
        spec: {
          secretName: "shop-tls",
          dnsNames: ["shop.example.com", "www.shop.example.com"],
          issuerRef: { name: "letsencrypt-prod", kind: "ClusterIssuer" },
        },
        status: {
          conditions: [{ type: "Ready", status: "True", reason: "Ready" }],
          notAfter: new Date(Date.now() + 60 * 86_400_000).toISOString(),
          notBefore: new Date(Date.now() - 30 * 86_400_000).toISOString(),
          renewalTime: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        },
      },
      t
    );
    expect(sections).toHaveLength(1);
    const rows =
      sections?.[0]?.body.type === "facts" ? sections[0].body.rows : [];
    const labels = rows.map((row) => row.label);
    expect(labels).toEqual([
      "Status",
      "Expires",
      "Issuer",
      "DNS names",
      "Secret",
    ]);
    const status = rows[0]!.values[0]!;
    expect(status.text).toBe("True");
    expect(status.role).toBe("ok");
    const issuer = rows[2]!.values[0]!;
    expect(issuer.ref).toEqual({
      kind: "ClusterIssuer",
      namespace: null,
      stem: expect.any(String),
      tail: expect.any(String),
      icon: expect.any(String),
      kindHue: expect.any(Number),
      identHue: expect.any(Number),
    });
  });
});

describe("what an Issuer tells a reader with no cluster access", () => {
  it("names the ACME server it resolved to", () => {
    const sections = reportOf(
      {
        group: "cert-manager.io",
        kind: "ClusterIssuer",
        namespace: null,
        name: "letsencrypt-prod",
        spec: {
          acme: { server: "https://acme-v02.api.letsencrypt.org/directory" },
        },
        status: { conditions: [{ type: "Ready", status: "True" }] },
      },
      t
    );
    expect(sections?.[0]?.title).toBe("ClusterIssuer");
    const rows =
      sections?.[0]?.body.type === "facts" ? sections[0].body.rows : [];
    expect(rows[1]?.values[0]?.text).toBe("ACME · Let's Encrypt");
  });
});

describe("what an object of another vendor's kind gets", () => {
  it("declines an IngressRoute: that is Traefik's kind, not cert-manager's", () => {
    const sections = reportOf(
      {
        group: "traefik.io",
        kind: "IngressRoute",
        namespace: "shop",
        name: "web",
        spec: {},
        status: {},
      },
      t
    );
    expect(sections).toBeNull();
  });
});
