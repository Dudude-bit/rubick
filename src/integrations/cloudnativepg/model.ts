import type { CustomResourceInfo } from "@/generated/types";
import { conditionOf, getValueByPath } from "../kit";
import type { Read } from "./data";

/**
 * A CloudNativePG Cluster in CNPG's own words, read off the object and
 * never inferred. What CNPG does not write is unknown here: it writes no
 * `observedGeneration`, so whether the operator has seen the spec is a
 * question this page declines to answer rather than guesses at.
 */

export const HIBERNATION = "cnpg.io/hibernation";
export const FENCED = "cnpg.io/fencedInstances";
export const RELOADED_AT = "cnpg.io/reloadedAt";
export const RESTARTED_AT = "kubectl.kubernetes.io/restartedAt";

export interface Archiving {
  /** `ContinuousArchiving` condition status: "True", "False", or absent when nothing archives. */
  status: string | null;
  reason: string | null;
  message: string | null;
  since: string | null;
}

export interface Instance {
  name: string;
  role: "primary" | "replica" | "unknown";
  /** CNPG's `instancesStatus` bucket; "failed" is the operator's word. */
  health: "healthy" | "replicating" | "failed" | "unknown";
  /** `null` when the annotation is there and could not be read. */
  fenced: boolean | null;
}

export interface PgCluster {
  name: string;
  namespace: string;
  uid: string;
  /** `status.phase`, verbatim: "Cluster in healthy state", "Switchover in progress", … */
  phase: string | null;
  phaseReason: string | null;
  primary: string | null;
  /** Differs from `primary` during a switchover; CNPG's own two fields. */
  targetPrimary: string | null;
  switchingOver: boolean;
  /** CNPG's "Failing over": unplanned, and not the same event. */
  failingOver: boolean;
  instances: Instance[];
  declared: number;
  ready: number;
  fenced: string[];
  /**
   * Whether `fenced` is an answer. `false` says the annotation is there and
   * could not be read — and fencing is written back as a whole list, so
   * acting on a `fenced` we did not read would overwrite it.
   */
  fencedKnown: boolean;
  /** CNPG's `*`: every instance, named or not, so the list cannot be edited. */
  fencedAll: boolean;
  hibernated: boolean;
  image: string | null;
  postgresVersion: string | null;
  storage: { size: string | null; storageClass: string | null };
  pvcCount: number | null;
  archiving: Archiving;
  readyCondition: { status: string | null; message: string | null };
  /** CNPG writes no observedGeneration, so this is always unknown, and said so. */
  specSeen: "unknown";
  worst: "err" | "warn" | null;
  findings: PgFinding[];
}

export type PgFinding =
  | { kind: "switchover"; severity: "warn"; reason: string | null }
  | { kind: "notReady"; severity: "err"; message: string | null }
  | {
      kind: "archivingFailing";
      severity: "err";
      message: string | null;
      since: string | null;
    }
  | { kind: "failedInstances"; severity: "err"; names: string[] }
  | { kind: "fenced"; severity: "warn"; names: string[] }
  | { kind: "fencedUnknown"; severity: "warn" }
  | { kind: "failover"; severity: "err"; reason: string | null }
  | { kind: "phaseUnwritten"; severity: "warn" }
  | { kind: "hibernated"; severity: "warn" }
  | { kind: "phase"; severity: "warn"; phase: string; reason: string | null };

const HEALTHY_PHASE = "Cluster in healthy state";
/** CNPG's own phase strings, and the sentinel it parks in `targetPrimary`. */
const SWITCHOVER_PHASE = "Switchover in progress";
const FAILOVER_PHASE = "Failing over";
const PENDING_FAILOVER = "pending";
const HIBERNATED_PHASE = "Cluster is hibernated";

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Which instances the annotation names, `"*"` for all of them, or `null`
 * when the annotation is there and we cannot read it.
 *
 * The three answers matter more here than anywhere else on this page,
 * because fencing is written back as a whole list: an unreadable annotation
 * read as `[]` said "nothing is fenced", and then fencing one instance
 * wrote `["that-one"]` over whatever the operator was really holding —
 * unfencing the rest of a live database cluster without anyone asking.
 */
function fencedOf(annotations: Record<string, string>): string[] | "*" | null {
  const raw = annotations[FENCED];
  if (!raw) return [];
  if (raw.trim() === "*") return "*";
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.includes("*")) return "*";
    if (!Array.isArray(parsed)) return null;
    return strings(parsed);
  } catch {
    return null;
  }
}

/** `ghcr.io/cloudnative-pg/postgresql:17.5` → `17.5`. */
export function postgresVersionOf(image: string | null): string | null {
  if (!image) return null;
  // The tag is what follows the LAST colon *after* the last slash. A
  // registry may carry a port — `registry.internal:5000/cnpg/postgresql` —
  // and splitting the whole reference on ":" then reported 5000 as the
  // version of PostgreSQL.
  const ref = image.split("@")[0];
  const lastSlash = ref.lastIndexOf("/");
  const namePart = ref.slice(lastSlash + 1);
  const colon = namePart.lastIndexOf(":");
  const tag = colon === -1 ? "" : namePart.slice(colon + 1);
  const m = /^(\d+(?:\.\d+)?)/.exec(tag);
  return m ? m[1] : null;
}

export function readCluster(resource: CustomResourceInfo): PgCluster {
  const status = (resource.status ?? {}) as Record<string, unknown>;
  const spec = (resource.spec ?? {}) as Record<string, unknown>;
  const buckets = (status.instancesStatus ?? {}) as Record<string, unknown>;
  const healthy = strings(buckets.healthy);
  const replicating = strings(buckets.replicating);
  const failed = strings(buckets.failed);
  const names = strings(status.instanceNames);
  const primary = text(status.currentPrimary);
  const targetPrimary = text(status.targetPrimary);
  const fenced = fencedOf(resource.annotations);
  const all = [...new Set([...names, ...healthy, ...replicating, ...failed])];

  const instances: Instance[] = all.map((name) => ({
    name,
    role:
      name === primary ? "primary" : primary === null ? "unknown" : "replica",
    health: healthy.includes(name)
      ? "healthy"
      : replicating.includes(name)
        ? "replicating"
        : failed.includes(name)
          ? "failed"
          : "unknown",
    fenced: fenced === null ? null : fenced === "*" || fenced.includes(name),
  }));

  const archivingCondition = conditionOf(resource, "ContinuousArchiving");
  const readyCondition = conditionOf(resource, "Ready");
  const phase = text(status.phase);
  // CNPG 1.30 keeps the phase at "healthy" while hibernated and says so in
  // a condition named after the annotation; older releases used a phase.
  const hibernated =
    resource.annotations[HIBERNATION] === "on" ||
    phase === HIBERNATED_PHASE ||
    conditionOf(resource, HIBERNATION)?.status === "True";
  // CNPG's own words decide which of the two this is, not the disagreement
  // between the fields. Its first act in an unplanned failover is to write
  // `targetPrimary: "pending"` — a sentinel, not an instance — so reading a
  // failover off `primary !== targetPrimary` both mislabelled writes-are-down
  // as a graceful switchover and drew "pending" as the name of a Pod.
  const switchingOver = phase === SWITCHOVER_PHASE;
  const failingOver = phase === FAILOVER_PHASE;
  // Not yet chosen, and not a name to print.
  const targetChosen =
    targetPrimary !== PENDING_FAILOVER ? targetPrimary : null;
  const moving = switchingOver || failingOver;

  const findings: PgFinding[] = [];
  // Nothing in the status at all: the operator has not reconciled this
  // object, or could not. Every arm below needs a positive signal, so
  // without this the row came out with no findings and was painted the
  // same green as a healthy cluster.
  if (phase === null) {
    findings.push({ kind: "phaseUnwritten", severity: "warn" });
  }
  if (readyCondition?.status === "False") {
    findings.push({
      kind: "notReady",
      severity: "err",
      message: readyCondition.message ?? null,
    });
  }
  if (archivingCondition?.status === "False") {
    findings.push({
      kind: "archivingFailing",
      severity: "err",
      message: archivingCondition.message ?? null,
      since: archivingCondition.lastTransitionTime ?? null,
    });
  }
  if (failed.length > 0) {
    findings.push({ kind: "failedInstances", severity: "err", names: failed });
  }
  if (switchingOver) {
    findings.push({
      kind: "switchover",
      severity: "warn",
      reason: text(status.phaseReason),
    });
  }
  if (failingOver) {
    // An unplanned promotion: the old primary is gone and writes are down.
    // Not the same event as a switchover, and not the same severity.
    findings.push({
      kind: "failover",
      severity: "err",
      reason: text(status.phaseReason),
    });
  }
  const fencedKnown = fenced !== null;
  // CNPG's `*` means every instance, including ones its status has not
  // named yet. Expanding it to the names we happen to know and writing
  // that back would quietly unfence the rest, so the wildcard is carried
  // as a wildcard.
  const fencedAll = fenced === "*";
  const fencedNames = fencedAll ? all : (fenced ?? []);
  if (!fencedKnown) {
    findings.push({ kind: "fencedUnknown", severity: "warn" });
  } else if (fencedNames.length > 0) {
    findings.push({ kind: "fenced", severity: "warn", names: fencedNames });
  }
  if (hibernated) {
    findings.push({ kind: "hibernated", severity: "warn" });
  } else if (phase !== null && phase !== HEALTHY_PHASE && !moving) {
    findings.push({
      kind: "phase",
      severity: "warn",
      phase,
      reason: text(status.phaseReason),
    });
  }

  const storage = (spec.storage ?? {}) as Record<string, unknown>;
  const image = text(status.image) ?? text(spec.imageName);
  return {
    name: resource.name,
    namespace: resource.namespace ?? "",
    uid: resource.uid,
    phase,
    phaseReason: text(status.phaseReason),
    primary,
    targetPrimary: targetChosen,
    switchingOver,
    failingOver,
    instances,
    declared: typeof spec.instances === "number" ? spec.instances : 0,
    ready:
      typeof status.readyInstances === "number" ? status.readyInstances : 0,
    fenced: fencedNames,
    fencedKnown,
    fencedAll,
    hibernated,
    image,
    postgresVersion: postgresVersionOf(image),
    storage: {
      size: text(storage.size),
      storageClass: text(storage.storageClass),
    },
    pvcCount: typeof status.pvcCount === "number" ? status.pvcCount : null,
    archiving: {
      status: archivingCondition?.status ?? null,
      reason: archivingCondition?.reason ?? null,
      message: archivingCondition?.message ?? null,
      since: archivingCondition?.lastTransitionTime ?? null,
    },
    readyCondition: {
      status: readyCondition?.status ?? null,
      message: readyCondition?.message ?? null,
    },
    specSeen: "unknown",
    worst: findings.some((f) => f.severity === "err")
      ? "err"
      : findings.length > 0
        ? "warn"
        : null,
    findings,
  };
}

/** Trouble first, then by name, so the cluster that needs you is on top. */
export function byTrouble(clusters: PgCluster[]): PgCluster[] {
  const rank = (c: PgCluster) =>
    c.worst === "err" ? 0 : c.worst === "warn" ? 1 : 2;
  return [...clusters].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      a.namespace.localeCompare(b.namespace) ||
      a.name.localeCompare(b.name)
  );
}

export interface BackupSummary {
  /** Could not be read; every other field is then meaningless. */
  state: "unknown" | "none" | "some";
  reason: string | null;
  total: number;
  lastCompletedAt: string | null;
  lastPhase: string | null;
  lastError: string | null;
  running: number;
}

export interface Schedule {
  name: string;
  schedule: string | null;
  method: string | null;
  suspended: boolean;
  lastScheduleTime: string | null;
}

/**
 * From the Backup objects, never from the cluster's status: CNPG deprecated
 * `status.firstRecoverabilityPoint` and `lastSuccessfulBackup`, and with the
 * plugin-based backups they are simply empty. A read that failed is unknown,
 * and never "no backups".
 */
export function backupsOf(
  cluster: PgCluster,
  backups: Read<CustomResourceInfo>
): BackupSummary {
  if (!backups.ok) {
    return {
      state: "unknown",
      reason: backups.reason,
      total: 0,
      lastCompletedAt: null,
      lastPhase: null,
      lastError: null,
      running: 0,
    };
  }
  const own = backups.items.filter(
    (b) =>
      b.namespace === cluster.namespace &&
      getValueByPath(b, "spec.cluster.name") === cluster.name
  );
  if (own.length === 0) {
    return {
      state: "none",
      reason: null,
      total: 0,
      lastCompletedAt: null,
      lastPhase: null,
      lastError: null,
      running: 0,
    };
  }
  const completed = own
    .filter((b) => getValueByPath(b, "status.phase") === "completed")
    .map((b) => text(getValueByPath(b, "status.stoppedAt")))
    .filter((t): t is string => t !== null)
    .sort();
  const newest = [...own].sort((a, b) =>
    String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? ""))
  )[0];
  return {
    state: "some",
    reason: null,
    total: own.length,
    lastCompletedAt: completed[completed.length - 1] ?? null,
    lastPhase: text(getValueByPath(newest, "status.phase")),
    lastError: text(getValueByPath(newest, "status.error")),
    running: own.filter((b) => {
      const phase = getValueByPath(b, "status.phase");
      return phase === "running" || phase === "started" || phase === "pending";
    }).length,
  };
}

export function schedulesOf(
  cluster: PgCluster,
  scheduled: Read<CustomResourceInfo>
): Schedule[] | null {
  if (!scheduled.ok) return null;
  return scheduled.items
    .filter(
      (s) =>
        s.namespace === cluster.namespace &&
        getValueByPath(s, "spec.cluster.name") === cluster.name
    )
    .map((s) => ({
      name: s.name,
      schedule: text(getValueByPath(s, "spec.schedule")),
      method: text(getValueByPath(s, "spec.method")),
      suspended: getValueByPath(s, "spec.suspend") === true,
      lastScheduleTime: text(getValueByPath(s, "status.lastScheduleTime")),
    }));
}

export interface PoolerInfo {
  name: string;
  namespace: string;
  cluster: string;
  type: string | null;
  poolMode: string | null;
  instances: number | null;
}

export function readPooler(resource: CustomResourceInfo): PoolerInfo {
  return {
    name: resource.name,
    namespace: resource.namespace ?? "",
    cluster: text(getValueByPath(resource, "spec.cluster.name")) ?? "",
    type: text(getValueByPath(resource, "spec.type")),
    poolMode: text(getValueByPath(resource, "spec.pgbouncer.poolMode")),
    instances:
      typeof getValueByPath(resource, "spec.instances") === "number"
        ? (getValueByPath(resource, "spec.instances") as number)
        : null,
  };
}
