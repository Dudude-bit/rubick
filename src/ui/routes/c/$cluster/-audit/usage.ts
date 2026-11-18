import type {
  CostBasis,
  OverBy,
  Subject,
  UsageRead,
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
  const workloads: WorkloadUse[] = [];
  for (const w of basis.workloads) {
    const e = workloadEfficiency(reading, w.key, {
      cpu: w.cpu,
      memory: w.memory,
    });
    // Its pods were refused to the read of use: no verdict, and the
    // backend names the refusal where it finds no row.
    const failed = [e.cpu, e.memory].find((one) => one.state === "failed");
    if (failed?.state === "failed") {
      if (!unread.has(w.key.namespace))
        unread.set(w.key.namespace, failed.said);
      continue;
    }
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
function verdictOf(e: { cpu: Efficiency; memory: Efficiency }): UseVerdict {
  const cpu = overBy(e.cpu);
  const memory = overBy(e.memory);
  if (cpu || memory) return { says: "over", cpu, memory };
  const fresh = [e.cpu, e.memory].find(young);
  if (fresh?.state === "measured" || fresh?.state === "noSamples")
    return { says: "young", since: fresh.since };
  if (e.cpu.state === "noSamples" || e.memory.state === "noSamples")
    return { says: "noSamples" };
  // A peak nobody read judges nothing, though the average was read.
  const peakless = (one: Efficiency) =>
    one.state === "measured" && one.peakRatio === null;
  if (peakless(e.cpu) || peakless(e.memory)) return { says: "noSamples" };
  // Measured from some of its pods: neither its figure nor a bound on it.
  for (const one of [e.cpu, e.memory])
    if (one.state === "measured" && one.podsRead)
      return { says: "partial", ...one.podsRead };
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
