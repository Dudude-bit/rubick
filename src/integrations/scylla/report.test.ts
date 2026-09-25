import { describe, expect, it } from "vitest";

import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";

import { reportOf } from "./report";

const t: T = (section, key, values) => translate("en", section, key, values);

describe("what a ScyllaCluster tells a reader with no cluster access", () => {
  const sections = reportOf(
    {
      group: "scylla.scylladb.com",
      kind: "ScyllaCluster",
      namespace: "data",
      name: "main",
      spec: {
        version: "5.4.0",
        datacenter: { name: "dc1", racks: [{ name: "rack1", members: 3 }] },
      },
      status: {
        members: 3,
        readyMembers: 2,
        racks: { rack1: { readyMembers: 2, version: "5.4.0" } },
        conditions: [
          { type: "Available", status: "True" },
          { type: "Degraded", status: "False" },
          { type: "Progressing", status: "True" },
        ],
      },
    },
    t
  );

  it("reads Degraded=False as healthy, not as a fault", () => {
    const cluster = sections?.find(
      (section) => section.id === "scylla-cluster"
    );
    if (cluster?.body.type !== "facts") throw new Error("expected facts");
    expect(
      cluster.body.rows.find((row) => row.label === "Degraded")?.values[0]
    ).toEqual({
      text: "False",
      role: "ok",
    });
    expect(
      cluster.body.rows.find((row) => row.label === "Available")?.values[0]
    ).toEqual({
      text: "True",
      role: "ok",
    });
  });

  it("lists the one rack short of members", () => {
    const racks = sections?.find(
      (section) => section.id === "scylla-cluster-racks"
    );
    expect(racks?.count).toBe(1);
    if (racks?.body.type !== "table") throw new Error("expected a table");
    expect(racks.body.rows[0]?.cells.map((cell) => cell.text)).toEqual([
      "rack1",
      "2/3",
      "5.4.0",
    ]);
    expect(racks.body.rows[0]?.cells[1]?.role).toBe("warn");
  });
});

describe("Scylla counts the operator has not written yet", () => {
  /** `?/3` was painted warn and `?/?` on a NodeConfig green: "nobody said"
   *  drawn as short, and as fine. The page draws both in its unknown tone. */
  it("colours unwritten member, rack and node counts as unknown", () => {
    const cluster = reportOf(
      {
        group: "scylla.scylladb.com",
        kind: "ScyllaCluster",
        namespace: "data",
        name: "fresh",
        spec: {
          datacenter: { name: "dc1", racks: [{ name: "rack1", members: 3 }] },
        },
        status: {},
      },
      t
    );
    const facts = cluster?.find((section) => section.id === "scylla-cluster");
    if (facts?.body.type !== "facts") throw new Error("expected facts");
    expect(
      facts.body.rows.find((row) => row.label === "Members")?.values[0]?.role
    ).toBe("neutral");
    const racks = cluster?.find(
      (section) => section.id === "scylla-cluster-racks"
    );
    if (racks?.body.type !== "table") throw new Error("expected a table");
    expect(racks.body.rows[0]?.cells[1]?.role).toBe("neutral");

    const config = reportOf(
      {
        group: "scylla.scylladb.com",
        kind: "NodeConfig",
        namespace: null,
        name: "tuning",
        spec: {},
        status: {},
      },
      t
    );
    if (config?.[0]?.body.type !== "facts") throw new Error("expected facts");
    expect(config[0].body.rows[0]?.values[0]).toMatchObject({
      text: "?/?",
      role: "neutral",
    });
  });
});

describe("what an object of another vendor's kind gets", () => {
  it("declines a Cluster: that is CloudNativePG's kind, not Scylla's", () => {
    const sections = reportOf(
      {
        group: "postgresql.cnpg.io",
        kind: "Cluster",
        namespace: "shop",
        name: "orders-db",
        spec: {},
        status: {},
      },
      t
    );
    expect(sections).toBeNull();
  });
});
