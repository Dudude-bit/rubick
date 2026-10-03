import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";

import { reportOf } from "./report";

const t: T = (section, key, values) => translate("en", section, key, values);

describe("what a VirtualService tells a reader with no cluster access", () => {
  const sections = reportOf(
    {
      group: "networking.istio.io",
      kind: "VirtualService",
      namespace: "shop",
      name: "web",
      spec: {
        hosts: ["shop.example.com"],
        gateways: ["shop-gateway"],
        http: [
          {
            match: [{ uri: { prefix: "/api" } }],
            route: [
              { destination: { host: "api", subset: "v2" }, weight: 100 },
            ],
          },
        ],
      },
      status: {},
    },
    t
  );

  it("names the hosts and the gateways it binds", () => {
    const facts = sections?.find(
      (section) => section.id === "istio-virtualservice"
    );
    expect(facts?.body).toEqual({
      type: "facts",
      rows: [
        { label: "Hosts", values: [{ text: "shop.example.com", mono: true }] },
        { label: "Gateways", values: [{ text: "shop-gateway", mono: true }] },
      ],
    });
  });

  it("puts the match and the weighted destination in one row", () => {
    const routes = sections?.find(
      (section) => section.id === "istio-virtualservice-routes"
    );
    expect(routes?.count).toBe(1);
    if (routes?.body.type !== "table") throw new Error("expected a table");
    const cells = routes.body.rows[0]!.cells;
    expect(cells[0]?.text).toBe("http");
    expect(cells[2]?.text).toBe("api[v2] 100%");
    expect(cells[2]?.ref?.kind).toBe("Service");
  });
});

describe("what a PeerAuthentication tells a reader with no cluster access", () => {
  it("names the mTLS mode", () => {
    const sections = reportOf(
      {
        group: "security.istio.io",
        kind: "PeerAuthentication",
        namespace: "shop",
        name: "default",
        spec: { mtls: { mode: "STRICT" } },
        status: {},
      },
      t
    );
    expect(sections?.[0]?.body).toEqual({
      type: "facts",
      rows: [{ label: "mTLS mode", values: [{ text: "STRICT", mono: true }] }],
    });
  });
});

describe("what an object of another vendor's kind gets", () => {
  it("declines an IngressRoute: that is Traefik's kind, not Istio's", () => {
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
