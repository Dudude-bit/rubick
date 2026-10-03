import { describe, expect, it } from "vitest";
import { storageSummary } from "@/lib/storage-summary";
import type {
  ConnectionEdge,
  ObjectRef,
  ResourceConnections,
} from "@/generated/types";

const subject: ObjectRef = {
  kind: "Pod",
  name: "mounts-demo",
  namespace: "k8s-gui-test",
  existence: "present",
  facts: null,
};

const claim = (
  name: string,
  capacity: string,
  phase = "Bound",
  storageClass = "local-path"
): ObjectRef => ({
  kind: "PersistentVolumeClaim",
  name,
  namespace: "k8s-gui-test",
  existence: "present",
  facts: { kind: "claim", phase, capacity, storageClass },
});

const mountedAt = (to: ObjectRef, path: string): ConnectionEdge => ({
  from: subject,
  to,
  relation: {
    verb: "uses",
    usages: [
      {
        how: "mount",
        container: "app",
        path,
        readOnly: false,
        subPath: null,
        volume: "data",
        projected: false,
      },
    ],
  },
});

const conns = (edges: ConnectionEdge[]): ResourceConnections => ({
  subject,
  edges,
  stops: [],
  published: [],
  notLookedAt: [],
});

describe("storageSummary", () => {
  it("reports the size a claim was declared with, and where it is mounted", () => {
    const summary = storageSummary(
      conns([mountedAt(claim("pvc-demo", "1Gi"), "/var/lib/data")])
    );
    expect(summary?.claims).toHaveLength(1);
    expect(summary?.claims[0]).toMatchObject({
      name: "pvc-demo",
      capacity: "1Gi",
      storageClass: "local-path",
      phase: "Bound",
      paths: ["/var/lib/data"],
    });
  });

  it("adds the declared capacities up", () => {
    const summary = storageSummary(
      conns([
        mountedAt(claim("pvc-demo", "1Gi"), "/var/lib/data"),
        mountedAt(claim("pvc-logs", "5Gi"), "/var/log/app"),
      ])
    );
    expect(summary?.declared).toBe("6Gi");
  });

  it("carries no notion of how full a volume is", () => {
    // The kubelet Summary API knows; metrics.k8s.io does not, and this app
    // reads only the latter. Anything resembling a used/total pair here
    // would be a number with nothing behind it.
    const summary = storageSummary(
      conns([mountedAt(claim("pvc-demo", "1Gi"), "/var/lib/data")])
    );
    expect(summary).not.toHaveProperty("used");
    expect(summary).not.toHaveProperty("usedBytes");
    expect(summary?.claims[0]).not.toHaveProperty("used");
    expect(Object.keys(summary!.claims[0])).not.toContain("ratio");
  });

  it("counts a claim that is not Bound, which is why a pod is often stuck", () => {
    const summary = storageSummary(
      conns([mountedAt(claim("pvc-slow", "1Gi", "Pending"), "/var/lib/data")])
    );
    expect(summary?.unbound).toBe(1);
  });

  it("collapses a claim mounted by two containers into one volume", () => {
    const shared = claim("pvc-demo", "1Gi");
    const summary = storageSummary(
      conns([
        mountedAt(shared, "/var/lib/data"),
        mountedAt(shared, "/mnt/data"),
      ])
    );
    expect(summary?.claims).toHaveLength(1);
    expect(summary?.claims[0].paths).toEqual(["/var/lib/data", "/mnt/data"]);
  });

  it("says nothing at all when a workload mounts no claim", () => {
    expect(storageSummary(conns([]))).toBeNull();
    expect(storageSummary(null)).toBeNull();
  });
});
