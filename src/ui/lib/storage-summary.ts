/**
 * The volumes a workload mounts, and how big they were asked to be.
 *
 * This is deliberately only half of the question a reader asks about disk.
 * **Size is declared; fullness is measured, and nothing here measures it.**
 * The entire payload of `metrics.k8s.io` is cpu and memory — there is no
 * volume field in it at any version. How full a PersistentVolume is comes
 * from the kubelet's Summary API (`/stats/summary`), which this app does
 * not read and which is normally reached through a Prometheus.
 *
 * So the rule this module exists to hold: report the capacity, name it as
 * capacity, and never produce a ratio. A "used" bar drawn against these
 * numbers would have nothing behind its fill.
 */
import { parseMemory, formatMemory } from "@/lib/k8s-quantity";
import type { ResourceConnections } from "@/generated/types";

export interface StorageClaim {
  name: string;
  namespace: string | null;
  /** As declared on the claim, e.g. "1Gi". Null when the claim is pending
   *  and the cluster has not written a capacity onto it yet. */
  capacity: string | null;
  storageClass: string | null;
  phase: string | null;
  /** Where the containers mount it, in path order. */
  paths: string[];
}

export interface StorageSummary {
  claims: StorageClaim[];
  /** Sum of the declared capacities, or null when none could be parsed. */
  declared: string | null;
  /** Claims not yet Bound — the reason a pod is stuck often enough to name. */
  unbound: number;
}

/**
 * Pulls the claims out of a connections answer.
 *
 * Reads the same edges the Connections panel draws, rather than the pod's
 * `volumes`, so the two blocks cannot disagree about what is mounted — and
 * so a Deployment (whose own spec names a template, not a claim) gets the
 * same summary as the pod under it.
 */
export function storageSummary(
  connections: ResourceConnections | null | undefined
): StorageSummary | null {
  if (!connections) return null;

  const byName = new Map<string, StorageClaim>();

  for (const edge of connections.edges) {
    const target = edge.to;
    if (target.facts?.kind !== "claim") continue;

    const key = `${target.namespace ?? ""}/${target.name}`;
    const existing = byName.get(key);
    const claim: StorageClaim = existing ?? {
      name: target.name,
      namespace: target.namespace,
      capacity: target.facts.capacity || null,
      storageClass: target.facts.storageClass || null,
      phase: target.facts.phase || null,
      paths: [],
    };

    if (edge.relation.verb === "uses") {
      for (const usage of edge.relation.usages) {
        if (usage.how === "mount" && !claim.paths.includes(usage.path)) {
          claim.paths.push(usage.path);
        }
      }
    }
    byName.set(key, claim);
  }

  const claims = [...byName.values()].sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  if (claims.length === 0) return null;

  let bytes = 0;
  let parsed = false;
  for (const claim of claims) {
    if (!claim.capacity) continue;
    const value = parseMemory(claim.capacity);
    if (Number.isFinite(value) && value > 0) {
      bytes += value;
      parsed = true;
    }
  }

  return {
    claims,
    declared: parsed ? formatMemory(bytes, 0) : null,
    unbound: claims.filter((claim) => claim.phase && claim.phase !== "Bound")
      .length,
  };
}
