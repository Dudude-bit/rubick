import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";

import { reportOf } from "./report";

const t: T = (section, key, values) => translate("en", section, key, values);

describe("what a Cluster tells a reader with no cluster access", () => {
  const sections = reportOf(
    {
      group: "postgresql.cnpg.io",
      kind: "Cluster",
      namespace: "shop",
      name: "orders-db",
      spec: {
        instances: 3,
        imageName: "ghcr.io/cloudnative-pg/postgresql:16.2",
      },
      status: {
        phase: "Cluster in healthy state",
        currentPrimary: "orders-db-1",
        readyInstances: 3,
        instanceNames: ["orders-db-1", "orders-db-2", "orders-db-3"],
        instancesStatus: {
          healthy: ["orders-db-1", "orders-db-2", "orders-db-3"],
        },
        conditions: [{ type: "ContinuousArchiving", status: "True" }],
      },
    },
    t
  );

  it("names the phase, the replica count and the primary", () => {
    const cluster = sections?.find((section) => section.id === "cnpg-cluster");
    expect(cluster?.body.type).toBe("facts");
    if (cluster?.body.type !== "facts") throw new Error("expected facts");
    expect(cluster.body.rows[0]).toEqual({
      label: "Status",
      values: [{ text: "Cluster in healthy state", role: "ok" }],
    });
    expect(cluster.body.rows[1]).toEqual({
      label: "Replicas",
      values: [{ text: "3/3", role: "ok" }],
    });
    expect(
      cluster.body.rows.find((row) => row.label === "Primary")?.values[0]?.text
    ).toBe("orders-db-1");
  });

  it("lists every instance and its health", () => {
    const instances = sections?.find(
      (section) => section.id === "cnpg-cluster-instances"
    );
    expect(instances?.count).toBe(3);
    if (instances?.body.type !== "table") throw new Error("expected a table");
    expect(instances.body.rows[0]?.cells.map((cell) => cell.text)).toEqual([
      "orders-db-1",
      "primary",
      "healthy",
    ]);
  });
});

describe("what an object of another vendor's kind gets", () => {
  it("declines a Certificate: that is cert-manager's kind, not CloudNativePG's", () => {
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
