import type {
  CostBasis,
  OverBy,
  Subject,
  UsageRead,
  UsageOf,
  UseVerdict,
  WorkloadUse,
} from "@/generated/types";
import {
  EFFICIENCY_WINDOW,
  overRequested,
  workloadEfficiency,
  type Efficiency,
  type UsageReading,
} from "@/lib/efficiency";
import { errorToShow } from "@/lib/error-utils";

/**
 * What Audit sends with its question about requests far above use: each
 * workload of the requests list judged here, by the Cost page's own
 * `workloadEfficiency` and `overRequested`, out of the same reading the
 * Cost page draws its efficiency column from. Audit has no threshold and no
 * query of its own; the backend only puts the verdicts beside its other
 * findings, so one answer carries them all.
 */
export function usageRead(
  basis: CostBasis | undefined,
  basisError: unknown,
  reading: UsageReading
): UsageRead {
  if (reading.state === "noSupplier") return { state: "noSupplier" };
  if (reading.state === "failed")
    return { state: "failed", said: reading.said };
  if (!basis) {
    if (basisError) return { state: "failed", said: errorToShow(basisError) };
    return { state: "reading" };
  }
  if (basis.workloads.length > 0 && reading.state !== "read")
    return { state: "reading" };
  const unread = new Map(basis.unread.map((u) => [u.namespace, u.message]));
  // A namespace refused to the read of use is unread whether or not the
  // requests list has a row in it; the list's own words come first.
  if (reading.state === "read")
    for (const u of reading.fold.unread)
      if (!unread.has(u.namespace)) unread.set(u.namespace, u.message);
  const workloads: WorkloadUse[] = [];
  for (const w of basis.workloads) {
    const e = workloadEfficiency(reading, w.key, {
      cpu: w.cpu,
      memory: w.memory,
    });
    // Its pods were refused to the read of use: no verdict, and the
    // backend names the refusal where it finds no row.
    if (e.cpu.state === "failed" || e.memory.state === "failed") continue;
    workloads.push({
      namespace: w.key.namespace,
      kind: w.key.kind,
      name: w.key.name,
      verdict: verdictOf(e),
    });
  }
  return {
    state: "read",
    window: EFFICIENCY_WINDOW,
    workloads,
    unread: [...unread].map(([namespace, message]) => ({
      namespace,
      message,
    })),
    folded: basis.rest?.workloads ?? 0,
  };
}

function overBy(e: Efficiency): OverBy | null {
  if (!overRequested(e) || e.state !== "measured" || e.peak === null)
    return null;
  return {
    requested: Math.round(e.requested),
    peak: Math.round(e.peak),
    atMost: e.peakAtMost,
  };
}

/** Not a whole day of its pods: measured over less, or none yet where when they started is known. */
const young = (e: Efficiency) =>
  (e.state === "measured" && !e.whole) ||
  (e.state === "noSamples" && !e.whole && e.since !== null);

/**
 * Over where either resource is; not known where either went unsampled, or
 * where its pods have not run the day a peak is judged over.
 */
/** Which resource has `has`: one, both, or `undefined` for neither. */
function whichHas(
  e: { cpu: Efficiency; memory: Efficiency },
  has: (one: Efficiency) => boolean
): UsageOf | undefined {
  const cpu = has(e.cpu);
  const memory = has(e.memory);
  if (cpu && memory) return "both";
  return cpu ? "cpu" : memory ? "memory" : undefined;
}

function verdictOf(e: { cpu: Efficiency; memory: Efficiency }): UseVerdict {
  const cpu = overBy(e.cpu);
  const memory = overBy(e.memory);
  if (cpu || memory) return { says: "over", cpu, memory };
  const fresh = [e.cpu, e.memory].find(young);
  if (fresh?.state === "measured" || fresh?.state === "noSamples")
    return { says: "young", since: fresh.since };
  // A peak nobody read judges nothing, though the average was read: that
  // is its own reason, and before "no sample", which a read average belies.
  // Each names the resource it is about: one resource's gap is not the
  // other's, and its CPU measured whole is not "no sample of its pods".
  const unpeaked = whichHas(
    e,
    (one) => one.state === "measured" && one.peakRatio === null
  );
  if (unpeaked) return { says: "peakUnread", resource: unpeaked };
  const unsampled = whichHas(e, (one) => one.state === "noSamples");
  if (unsampled) return { says: "noSamples", resource: unsampled };
  // Its peak measured from some of its pods: neither its peak nor a bound
  // on it, said for each resource. An average from some of them judges
  // nothing either way.
  const peakPods = (one: Efficiency) =>
    one.state === "measured" ? one.peakPods : null;
  const cpuPods = peakPods(e.cpu);
  const memoryPods = peakPods(e.memory);
  if (cpuPods || memoryPods)
    return { says: "partial", cpu: cpuPods, memory: memoryPods };
  return { says: "within" };
}

/** The requests list cut to one object: the rows of it the list holds. */
export function basisOf(
  basis: CostBasis | undefined,
  subject: Subject | null
): CostBasis | undefined {
  if (!basis || !subject?.namespace) return undefined;
  return {
    ...basis,
    workloads: basis.workloads.filter(
      (w) =>
        w.key.namespace === subject.namespace &&
        w.key.kind === subject.kind &&
        w.key.name === subject.name
    ),
  };
}

/** A short stand-in for what was read, so an answer is asked again when it moves. */
export function usageKey(read: UsageRead | null): string {
  if (!read) return "none";
  if (read.state !== "read") return read.state;
  let hash = 2166136261;
  const text = JSON.stringify(read);
  for (let i = 0; i < text.length; i++)
    hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `read:${(hash >>> 0).toString(36)}`;
}
