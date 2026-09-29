import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import type { IssuerRow } from "./model";
import { issuersSection } from "./share";

const t: T = (section, key, values) => translate("en", section, key, values);

const issuer = (over: Partial<IssuerRow>): IssuerRow => ({
  key: "ClusterIssuer/letsencrypt",
  name: "letsencrypt",
  namespace: null,
  kind: "ClusterIssuer",
  crd: "clusterissuers.cert-manager.io",
  type: "ACME",
  detail: null,
  ready: true,
  message: null,
  serves: 1,
  ...over,
});

const refused = {
  kind: "ClusterIssuer",
  crd: "clusterissuers.cert-manager.io",
  reason: "forbidden",
};

describe("what the Issuers tab tells Share", () => {
  /** Both issuer lists refused came out as no section: "no issuer is failing". */
  it("marks the section unread when no issuer kind could be listed", () => {
    const section = issuersSection([], false, [refused], t);
    expect(section?.unread).toContain("forbidden");
  });

  it("marks the section unread while the issuers are still loading", () => {
    expect(issuersSection([], true, [], t)?.unread).toBe(
      "Still being read when the report was made."
    );
  });

  /** The tab draws an issuer with no Ready condition in warn; the file left it out. */
  it("reports an issuer with no status yet as a warning, and a refused kind beside the rest", () => {
    const section = issuersSection(
      [issuer({ ready: null }), issuer({ name: "ok", key: "ok" })],
      false,
      [{ ...refused, kind: "Issuer", crd: "issuers.cert-manager.io" }],
      t
    );
    if (section?.body.type !== "findings") throw new Error("expected findings");
    expect(section.unread).toBeUndefined();
    expect(section.body.items.map((item) => [item.title, item.role])).toEqual([
      ["issuers.cert-manager.io could not be listed", "warn"],
      ["letsencrypt", "warn"],
    ]);
  });
});
