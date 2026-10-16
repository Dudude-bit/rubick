import { describe, expect, it } from "vite-plus/test";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";

import { reportOf } from "./report";

const t: T = (section, key, values) => translate("en", section, key, values);

describe("what an IngressRoute tells a reader with no cluster access", () => {
  const sections = reportOf(
    {
      group: "traefik.io",
      kind: "IngressRoute",
      namespace: "shop",
      name: "web",
      spec: {
        entryPoints: ["websecure"],
        routes: [
          {
            match: "Host(`shop.example.com`) && PathPrefix(`/api`)",
            priority: 10,
            services: [{ name: "api", port: 8080 }],
            middlewares: [{ name: "strip-prefix" }],
          },
        ],
        tls: { secretName: "shop-tls" },
      },
      status: {},
    },
    t
  );

  it("reports the entry points and TLS secret", () => {
    const routing = sections?.find(
      (section) => section.id === "traefik-routing"
    );
    expect(routing?.body).toEqual({
      type: "facts",
      rows: [
        { label: "Entry points", values: [{ text: "websecure", mono: true }] },
        { label: "TLS", values: [{ text: "shop-tls", mono: true }] },
      ],
    });
  });

  it("puts the rule, priority, service and middleware in one row", () => {
    const routes = sections?.find((section) => section.id === "traefik-routes");
    expect(routes?.count).toBe(1);
    expect(routes?.body.type).toBe("table");
    if (routes?.body.type !== "table") throw new Error("expected a table");
    expect(routes.body.rows[0]?.cells.map((cell) => cell.text)).toEqual([
      "Host(`shop.example.com`) && PathPrefix(`/api`)",
      "10",
      "api:8080",
      "strip-prefix",
    ]);
    expect(routes.body.rows[0]?.cells[2]?.ref?.kind).toBe("Service");
  });
});

describe("what a Middleware tells a reader with no cluster access", () => {
  it("lists the one config block its spec carries", () => {
    const sections = reportOf(
      {
        group: "traefik.io",
        kind: "Middleware",
        namespace: "shop",
        name: "strip-prefix",
        spec: { stripPrefix: { prefixes: ["/api"] } },
        status: {},
      },
      t
    );
    expect(sections?.[0]?.body).toEqual({
      type: "facts",
      rows: [
        {
          label: "stripPrefix",
          values: [{ text: "prefixes=/api", mono: true }],
        },
      ],
    });
  });

  const middleware = (spec: unknown) => {
    const sections = reportOf(
      {
        group: "traefik.io",
        kind: "Middleware",
        namespace: "shop",
        name: "auth",
        spec,
        status: {},
      },
      t
    );
    const body = sections?.[0]?.body;
    if (body?.type !== "facts") throw new Error("expected facts");
    return body.rows.map((row) => row.values.map((v) => v.text).join(" "));
  };

  /**
   * Every key went out as `key=value`, under a footer promising no Secret:
   * an htpasswd hash is a password with extra steps, and a forwardAuth
   * address can carry its token in the query.
   */
  it("keeps credentials a middleware spells out of the file", () => {
    const [basic] = middleware({
      basicAuth: { users: ["admin:$apr1$H6uskkkW$IgXLP6ewTrSuBkTrqE8wj/"] },
    });
    expect(basic).toBe("users=…");
    const [forward] = middleware({
      forwardAuth: { address: "https://auth.example/verify?token=s3cr3t" },
    });
    expect(forward).not.toContain("s3cr3t");
    expect(forward).toContain("auth.example");
  });

  /** A nested setting written as `[object Object]` says nothing at all. */
  it("writes a nested setting out rather than as an object's name", () => {
    const [headers] = middleware({
      headers: { customRequestHeaders: { "X-Team": "shop" } },
    });
    expect(headers).toBe('customRequestHeaders={"X-Team":"shop"}');
  });
});

describe("what an object of another vendor's kind gets", () => {
  it("declines a Certificate: that is cert-manager's kind, not Traefik's", () => {
    const sections = reportOf(
      {
        group: "cert-manager.io",
        kind: "Certificate",
        namespace: "shop",
        name: "shop-tls",
        spec: {},
        status: {},
      },
      t
    );
    expect(sections).toBeNull();
  });
});
