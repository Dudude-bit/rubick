import { describe, expect, it } from "vitest";

import type { CustomResourceInfo } from "@/generated/types";
import { actionsFor } from "./actions";
import { FENCED } from "./model";
import {
  backupsOf,
  byTrouble,
  postgresVersionOf,
  readCluster,
  schedulesOf,
} from "./model";

function cluster(
  name: string,
  status: Record<string, unknown>,
  annotations: Record<string, string> = {},
  spec: Record<string, unknown> = {}
): CustomResourceInfo {
  return {
    name,
    namespace: "shop",
    uid: `uid-${name}`,
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Cluster",
    spec: {
      instances: 3,
      imageName: "ghcr.io/cloudnative-pg/postgresql:17.5",
      storage: { size: "50Gi", storageClass: "gp3" },
      ...spec,
    },
    status,
    labels: {},
    annotations,
    createdAt: "2026-09-01T00:00:00Z",
    ownerReferences: [],
  };
}

const HEALTHY = {
  phase: "Cluster in healthy state",
  currentPrimary: "shop-db-1",
  targetPrimary: "shop-db-1",
  readyInstances: 3,
  instanceNames: ["shop-db-1", "shop-db-2", "shop-db-3"],
  instancesStatus: { healthy: ["shop-db-1", "shop-db-2", "shop-db-3"] },
  pvcCount: 3,
  image: "ghcr.io/cloudnative-pg/postgresql:17.5",
  conditions: [
    { type: "Ready", status: "True", reason: "ClusterIsReady" },
    {
      type: "ContinuousArchiving",
      status: "True",
      reason: "ContinuousArchivingSuccess",
    },
  ],
};

describe("readCluster", () => {
  it("reads a healthy cluster as CNPG describes it", () => {
    const read = readCluster(cluster("shop-db", HEALTHY));
    expect(read.phase).toBe("Cluster in healthy state");
    expect(read.primary).toBe("shop-db-1");
    expect(read.switchingOver).toBe(false);
    expect(read.instances.map((i) => [i.name, i.role, i.health])).toEqual([
      ["shop-db-1", "primary", "healthy"],
      ["shop-db-2", "replica", "healthy"],
      ["shop-db-3", "replica", "healthy"],
    ]);
    expect(read.postgresVersion).toBe("17.5");
    expect(read.archiving.status).toBe("True");
    expect(read.worst).toBeNull();
    // CNPG writes no observedGeneration; the page must not pretend to know.
    expect(read.specSeen).toBe("unknown");
  });

  /** `currentPrimary` and `targetPrimary` are CNPG's own two fields; a switchover is exactly their disagreement. */
  it("sees a switchover and names the failing archiving as the cluster wrote it", () => {
    const read = readCluster(
      cluster("shop-db", {
        ...HEALTHY,
        phase: "Switchover in progress",
        phaseReason: "Switching over to shop-db-2",
        targetPrimary: "shop-db-2",
        readyInstances: 2,
        conditions: [
          { type: "Ready", status: "False", reason: "ClusterIsNotReady" },
          {
            type: "ContinuousArchiving",
            status: "False",
            reason: "ArchivingFailing",
            message: "403 from s3://shop-wal",
            lastTransitionTime: "2026-09-07T06:00:00Z",
          },
        ],
      })
    );
    expect(read.switchingOver).toBe(true);
    expect(read.targetPrimary).toBe("shop-db-2");
    expect(read.worst).toBe("err");
    expect(read.findings.map((f) => f.kind)).toEqual([
      "notReady",
      "archivingFailing",
      "switchover",
    ]);
    const archiving = read.findings.find((f) => f.kind === "archivingFailing");
    expect(archiving && "message" in archiving ? archiving.message : null).toBe(
      "403 from s3://shop-wal"
    );
  });

  it("reads fencing from the annotation and hibernation from either place it is written", () => {
    const fenced = readCluster(
      cluster("analytics-db", HEALTHY, {
        "cnpg.io/fencedInstances": '["shop-db-3"]',
      })
    );
    expect(fenced.fenced).toEqual(["shop-db-3"]);
    expect(fenced.instances[2].fenced).toBe(true);
    expect(fenced.worst).toBe("warn");

    const asleep = readCluster(
      cluster(
        "staging-db",
        { phase: "Cluster is hibernated" },
        {
          "cnpg.io/hibernation": "on",
        }
      )
    );
    expect(asleep.hibernated).toBe(true);
    expect(asleep.findings.map((f) => f.kind)).toEqual(["hibernated"]);

    // What 1.30 actually writes on a live cluster: the phase stays healthy
    // and a condition carries the annotation's name.
    const live = readCluster(
      cluster("staging-db", {
        ...HEALTHY,
        conditions: [
          { type: "cnpg.io/hibernation", status: "True", reason: "Hibernated" },
          ...HEALTHY.conditions,
        ],
      })
    );
    expect(live.hibernated).toBe(true);
    expect(live.findings.map((f) => f.kind)).toEqual(["hibernated"]);
  });

  it("puts the cluster that needs you first", () => {
    const calm = readCluster(cluster("a-calm", HEALTHY));
    const hot = readCluster(
      cluster("z-hot", {
        ...HEALTHY,
        instancesStatus: { healthy: ["shop-db-1"], failed: ["shop-db-2"] },
      })
    );
    expect(byTrouble([calm, hot]).map((c) => c.name)).toEqual([
      "z-hot",
      "a-calm",
    ]);
  });
});

describe("postgresVersionOf", () => {
  it("takes the version off the image tag and nothing else", () => {
    expect(
      postgresVersionOf("ghcr.io/cloudnative-pg/postgresql:16.9-bookworm")
    ).toBe("16.9");
    expect(postgresVersionOf("registry/pg@sha256:abc")).toBeNull();
    expect(postgresVersionOf(null)).toBeNull();
  });
});

function backup(
  name: string,
  cluster: string,
  status: Record<string, unknown>
): CustomResourceInfo {
  return {
    name,
    namespace: "shop",
    uid: `uid-${name}`,
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Backup",
    spec: { cluster: { name: cluster }, method: "barmanObjectStore" },
    status,
    labels: {},
    annotations: {},
    createdAt: status.startedAt as string,
    ownerReferences: [],
  };
}

describe("backupsOf", () => {
  const shop = readCluster(cluster("shop-db", HEALTHY));

  /**
   * The one this page exists for: a Backup list the cluster refused is not a
   * cluster with no backups, and printing "none configured" there tells the
   * on-call engineer the wrong thing at the worst moment.
   */
  it("is unknown, never none, when the Backup objects could not be read", () => {
    const summary = backupsOf(shop, {
      ok: false,
      reason: "backups.postgresql.cnpg.io is forbidden",
    });
    expect(summary.state).toBe("unknown");
    expect(summary.reason).toContain("forbidden");
    expect(summary.total).toBe(0);
    expect(schedulesOf(shop, { ok: false, reason: "forbidden" })).toBeNull();
  });

  it("is none only when the list was read and holds nothing for this cluster", () => {
    const summary = backupsOf(shop, {
      ok: true,
      items: [backup("other-1", "other-db", { phase: "completed" })],
    });
    expect(summary.state).toBe("none");
  });

  it("takes the last completed and the newest phase from the objects, not from the cluster status", () => {
    const summary = backupsOf(shop, {
      ok: true,
      items: [
        backup("shop-db-20260905", "shop-db", {
          phase: "completed",
          startedAt: "2026-09-05T03:00:00Z",
          stoppedAt: "2026-09-05T03:04:00Z",
        }),
        backup("shop-db-20260906", "shop-db", {
          phase: "failed",
          startedAt: "2026-09-06T03:00:00Z",
          error: "403 from s3://shop-wal",
        }),
      ],
    });
    expect(summary.state).toBe("some");
    expect(summary.total).toBe(2);
    expect(summary.lastCompletedAt).toBe("2026-09-05T03:04:00Z");
    expect(summary.lastPhase).toBe("failed");
    expect(summary.lastError).toBe("403 from s3://shop-wal");
  });
});

describe("fencing, which is written back as a whole list", () => {
  /**
   * The annotation is there and this version cannot read it. Answering `[]`
   * said "nothing is fenced" — and the Fence control then sent
   * `["the-one-you-clicked"]`, overwriting whatever the operator was really
   * holding and unfencing the rest of a live database cluster. The list is
   * unknown, and every control that would rewrite it says so.
   */
  it("does not read an unparseable annotation as nothing fenced", () => {
    const read = readCluster(
      cluster("shop-db", HEALTHY, { [FENCED]: "{not json" })
    );
    expect(read.fencedKnown).toBe(false);
    expect(read.findings.map((f) => f.kind)).toContain("fencedUnknown");
    expect(read.findings.map((f) => f.kind)).not.toContain("fenced");
    expect(read.instances.every((i) => i.fenced === null)).toBe(true);

    const acts = actionsFor(read, { patchClusters: true, createBackups: true });
    const fencing = acts.filter((a) => a.id === "fence" || a.id === "unfence");
    expect(fencing.length).toBeGreaterThan(0);
    for (const a of fencing) expect(a.reason).toBe("fencingUnknown");
  });

  /** A JSON object where a list belongs is just as unreadable as bad syntax. */
  it("does not read a non-list annotation as nothing fenced", () => {
    const read = readCluster(
      cluster("shop-db", HEALTHY, { [FENCED]: '{"a":1}' })
    );
    expect(read.fencedKnown).toBe(false);
  });

  /** No annotation at all is the other answer: nothing is fenced, and we know. */
  it("reads an absent annotation as nothing fenced, and knows it", () => {
    const read = readCluster(cluster("shop-db", HEALTHY));
    expect(read.fencedKnown).toBe(true);
    expect(read.fenced).toEqual([]);
    expect(read.instances.every((i) => i.fenced === false)).toBe(true);
    const acts = actionsFor(read, { patchClusters: true, createBackups: true });
    for (const a of acts.filter((x) => x.id === "fence")) {
      expect(a.reason).toBeNull();
    }
  });

  /** And a real list is read, with the controls it earns. */
  it("reads the named instances, and offers Unfence only for those", () => {
    const read = readCluster(
      cluster("shop-db", HEALTHY, { [FENCED]: '["shop-db-2"]' })
    );
    expect(read.fencedKnown).toBe(true);
    expect(read.fenced).toEqual(["shop-db-2"]);
    const acts = actionsFor(read, { patchClusters: true, createBackups: true });
    expect(
      acts.filter((a) => a.id === "unfence").map((a) => a.instance)
    ).toEqual(["shop-db-2"]);
  });

  /** CNPG's `"*"` means every instance, written bare rather than as a list. */
  it("reads a bare star as every instance", () => {
    const read = readCluster(cluster("shop-db", HEALTHY, { [FENCED]: "*" }));
    expect(read.fencedKnown).toBe(true);
    expect(read.instances.every((i) => i.fenced === true)).toBe(true);
  });
});

describe("versions off an image reference", () => {
  /**
   * A registry may carry a port. `image.split(":").pop()` then returned the
   * port, so `registry.internal:5000/cnpg/postgresql` reported PostgreSQL
   * "5000" — a number with the shape of an answer, which is the worst kind
   * of wrong one.
   */
  it("reads the tag and not a registry port", () => {
    expect(postgresVersionOf("ghcr.io/cloudnative-pg/postgresql:17.5")).toBe(
      "17.5"
    );
    expect(postgresVersionOf("registry.internal:5000/cnpg/postgresql")).toBe(
      null
    );
    expect(
      postgresVersionOf("registry.internal:5000/cnpg/postgresql:16.2")
    ).toBe("16.2");
    expect(postgresVersionOf("postgresql@sha256:abc123")).toBe(null);
    expect(postgresVersionOf("postgresql:latest")).toBe(null);
  });
});
