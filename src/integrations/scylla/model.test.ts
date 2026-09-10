import { describe, expect, it } from "vitest";

import type { CustomResourceInfo } from "@/generated/types";
import { byTrouble, readNodeConfig, readScyllaCluster } from "./model";

function cluster(
  name: string,
  status: Record<string, unknown> | null,
  spec: Record<string, unknown> = {}
): CustomResourceInfo {
  return {
    name,
    namespace: "events",
    uid: `uid-${name}`,
    apiVersion: "scylla.scylladb.com/v1",
    kind: "ScyllaCluster",
    spec: {
      version: "2025.2.1",
      agentVersion: "3.5.0",
      datacenter: {
        name: "eu",
        racks: [
          { name: "eu-1a", members: 3, storage: { capacity: "900Gi" } },
          { name: "eu-1b", members: 3, storage: { capacity: "900Gi" } },
        ],
      },
      ...spec,
    },
    status,
    labels: {},
    annotations: {},
    createdAt: null,
    ownerReferences: [],
    generation: null,
  };
}

const ROLLED_OUT = {
  observedGeneration: 17,
  members: 6,
  readyMembers: 6,
  availableMembers: 6,
  managerId: "abc",
  racks: {
    "eu-1a": {
      version: "2025.2.1",
      members: 3,
      readyMembers: 3,
      updatedMembers: 3,
    },
    "eu-1b": {
      version: "2025.2.1",
      members: 3,
      readyMembers: 3,
      updatedMembers: 3,
    },
  },
  conditions: [
    { type: "Available", status: "True" },
    { type: "Progressing", status: "False" },
    { type: "Degraded", status: "False" },
  ],
};

describe("readScyllaCluster", () => {
  it("draws a rolled-out cluster as racks and members with nothing to say", () => {
    const read = readScyllaCluster(cluster("sessions", ROLLED_OUT), 17);
    expect(
      read.racks.map((r) => [r.name, r.ready, r.members, r.updated])
    ).toEqual([
      ["eu-1a", 3, 3, 3],
      ["eu-1b", 3, 3, 3],
    ]);
    expect(read.conditions).toEqual({
      available: "True",
      progressing: "False",
      degraded: "False",
    });
    expect(read.specSeen).toEqual({ observed: 17, generation: 17 });
    expect(read.findings).toEqual([]);
    expect(read.worst).toBeNull();
  });

  /** The upgrade is one finding with the operator's own progress, not three conditions the reader must add up. */
  it("reads an upgrade in progress from status.upgrade and the rack it is on", () => {
    const read = readScyllaCluster(
      cluster("events", {
        ...ROLLED_OUT,
        readyMembers: 5,
        racks: {
          "eu-1a": {
            version: "2025.2.1",
            members: 3,
            readyMembers: 3,
            updatedMembers: 3,
          },
          "eu-1b": {
            version: "2025.1.3",
            members: 3,
            readyMembers: 2,
            updatedMembers: 1,
          },
        },
        upgrade: {
          state: "RunningUpgrade",
          fromVersion: "2025.1.3",
          toVersion: "2025.2.1",
          currentRack: "eu-1b",
          currentNode: "events-eu-eu-1b-1",
        },
        conditions: [
          { type: "Available", status: "True" },
          { type: "Progressing", status: "True" },
          { type: "Degraded", status: "True", message: "eu-1b-2 not ready" },
        ],
      })
    );
    expect(read.worst).toBe("err");
    expect(read.findings.map((f) => f.kind)).toEqual(["degraded", "upgrading"]);
    // The parts, not a sentence: `detail` is contracted to carry the
    // controller's own words, and the model used to join these into English
    // prose and put it there.
    const upgrading = read.findings.find((f) => f.kind === "upgrading");
    expect(upgrading?.detail).toBeNull();
    expect(upgrading?.upgrade).toMatchObject({
      fromVersion: "2025.1.3",
      toVersion: "2025.2.1",
      currentRack: "eu-1b",
    });
  });

  /** A declared repair with no Manager will never run; the object says nothing, so the page must. */
  it("warns about repairs and backups declared with no Manager to run them", () => {
    const read = readScyllaCluster(
      cluster(
        "events",
        { ...ROLLED_OUT, managerId: undefined },
        { repairs: [{ name: "weekly", interval: "7d" }] }
      )
    );
    expect(read.repairs).toEqual([
      {
        name: "weekly",
        interval: "7d",
        startDate: null,
        location: [],
        retention: null,
        id: null,
      },
    ]);
    expect(read.findings.map((f) => f.kind)).toEqual(["tasksWithoutManager"]);
  });

  /**
   * No status is not a healthy cluster: it is an operator that has not
   * spoken. The cluster's own tally was already `null` here, but each rack
   * still said `ready: 0` — the zero this test is named after — and the page
   * drew "0 of 3 members" in warn for a rack nobody had reported on.
   */
  it("says the operator has written nothing rather than drawing zeros", () => {
    const read = readScyllaCluster(cluster("fresh", null));
    expect(read.silent).toBe(true);
    expect(read.findings.map((f) => f.kind)).toEqual(["noStatus"]);
    expect(read.members).toBeNull();
    expect(read.racks[0].ready).toBeNull();
    // …and an unreported rack is not "short of members" either.
    expect(read.findings.map((f) => f.kind)).not.toContain("membersMissing");
  });

  /**
   * A status with racks in it but no conditions — an older operator, or one
   * caught mid-reconcile — passed every finding arm, which each need a
   * positive signal, and came out with none at all: green, and labelled
   * "rolled out". So did a condition the operator wrote as `Unknown`, which
   * is its own way of saying it does not know.
   */
  it("does not read a cluster with no conditions as one that is rolled out", () => {
    const bare = readScyllaCluster(
      cluster("quiet", { racks: { "eu-1a": { readyMembers: 3 } } })
    );
    expect(bare.silent).toBe(false);
    expect(bare.findings.map((f) => f.kind)).toContain("conditionsUnwritten");
    expect(bare.worst).toBe("warn");

    const unsure = readScyllaCluster(
      cluster("unsure", {
        ...ROLLED_OUT,
        conditions: [
          { type: "Available", status: "Unknown" },
          { type: "Progressing", status: "False" },
          { type: "Degraded", status: "False" },
        ],
      })
    );
    expect(unsure.findings.map((f) => f.kind)).toContain("conditionsUnknown");
    expect(unsure.worst).toBe("warn");
  });

  it("puts the cluster in trouble first", () => {
    const calm = readScyllaCluster(cluster("a", ROLLED_OUT));
    const hot = readScyllaCluster(
      cluster("z", {
        ...ROLLED_OUT,
        conditions: [{ type: "Degraded", status: "True" }],
      })
    );
    expect(byTrouble([calm, hot]).map((c) => c.name)).toEqual(["z", "a"]);
  });
});

describe("readNodeConfig", () => {
  it("counts the nodes it set up and keeps the conditions it wrote as False", () => {
    const setup = readNodeConfig({
      name: "scylla-pool",
      namespace: null,
      uid: "nc",
      apiVersion: "scylla.scylladb.com/v1alpha1",
      kind: "NodeConfig",
      spec: {},
      status: {
        nodeStatuses: [
          { name: "n1", tunedNode: true },
          { name: "n2", tunedNode: false },
        ],
        conditions: [
          { type: "Reconciled", status: "True" },
          {
            type: "NodeSetupAvailable",
            status: "False",
            message: "n2 has no XFS disk",
          },
        ],
      },
      labels: {},
      annotations: {},
      createdAt: null,
      ownerReferences: [],
      generation: null,
    });
    expect(setup.nodes).toBe(2);
    expect(setup.tuned).toBe(1);
    expect(setup.problems).toEqual([
      { type: "NodeSetupAvailable", message: "n2 has no XFS disk" },
    ]);
  });
});
