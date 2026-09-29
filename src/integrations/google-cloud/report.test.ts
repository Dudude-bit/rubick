import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";

import { reportOf } from "./report";

const t: T = (section, key, values) => translate("en", section, key, values);

describe("what a ManagedCertificate tells a reader with no cluster access", () => {
  it("names the domain that is stuck, not just the top-level status", () => {
    const sections = reportOf(
      {
        group: "networking.gke.io",
        kind: "ManagedCertificate",
        namespace: "shop",
        name: "shop-cert",
        spec: { domains: ["shop.example.com", "www.shop.example.com"] },
        status: {
          certificateStatus: "Provisioning",
          domainStatus: [
            { domain: "shop.example.com", status: "Active" },
            { domain: "www.shop.example.com", status: "FailedNotVisible" },
          ],
        },
      },
      t
    );
    const facts = sections?.find(
      (section) => section.id === "gce-managedcertificate"
    );
    if (facts?.body.type !== "facts") throw new Error("expected facts");
    expect(facts.body.rows[0]).toEqual({
      label: "Status",
      values: [{ text: "Provisioning", role: "warn" }],
    });
    const table = sections?.find(
      (section) => section.id === "gce-managedcertificate-domains"
    );
    if (table?.body.type !== "table") throw new Error("expected a table");
    expect(table.body.rows[1]?.cells.map((cell) => cell.text)).toEqual([
      "www.shop.example.com",
      "FailedNotVisible",
    ]);
    expect(table.body.rows[1]?.cells[1]?.role).toBe("err");
  });
});

describe("what an object of another vendor's kind gets", () => {
  it("declines a TargetGroupBinding: that is the AWS Load Balancer Controller's kind", () => {
    const sections = reportOf(
      {
        group: "elbv2.k8s.aws",
        kind: "TargetGroupBinding",
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
