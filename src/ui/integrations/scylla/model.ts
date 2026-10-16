import type { CustomResourceInfo } from "@/generated/types";
import { conditionOf, getValueByPath } from "../kit";

/**
 * A ScyllaCluster in the operator's own words: racks and members, the
 * three conditions, an upgrade in progress, and the Manager tasks it
 * declares. Read off the object; where the object does not say, unknown.
 */

export interface Rack {
  name: string;
  /** Declared in spec. */
  members: number;
  /** `null` where the operator has not written this rack's status. */
  ready: number | null;
  /** Members on `spec.version`; `null` where the operator has not written it. */
  updated: number | null;
  /** The version the rack runs, as the operator wrote it. */
  version: string | null;
  /** `status.racks[].stale`: the operator has not looked at this rack since the spec changed. */
  stale: boolean;
  capacity: string | null;
}

export interface Upgrade {
  state: string | null;
  fromVersion: string | null;
  toVersion: string | null;
  currentRack: string | null;
  currentNode: string | null;
}

export interface Task {
  name: string;
  interval: string | null;
  startDate: string | null;
  location: string[];
  retention: number | null;
  /** The Manager's id for it; absent until the Manager has taken it. */
  id: string | null;
}

export interface ScyllaFinding {
  kind:
    | "degraded"
    | "unavailable"
    | "progressing"
    | "upgrading"
    | "stale"
    | "membersMissing"
    | "tasksWithoutManager"
    | "noStatus"
    | "conditionsUnwritten"
    | "conditionsUnknown";
  severity: "err" | "warn";
  /** The controller's own words, or null. Never a sentence built here. */
  detail: string | null;
  /** For `upgrading`: the parts, so the words can be the reader's. */
  upgrade?: Upgrade;
}

export interface ScyllaCluster {
  name: string;
  namespace: string;
  uid: string;
  version: string | null;
  agentVersion: string | null;
  datacenter: string | null;
  racks: Rack[];
  members: number | null;
  readyMembers: number | null;
  availableMembers: number | null;
  conditions: {
    available: string | null;
    progressing: string | null;
    degraded: string | null;
  };
  conditionMessages: Record<string, string | null>;
  upgrade: Upgrade | null;
  managerId: string | null;
  repairs: Task[];
  backups: Task[];
  /** `null` when the object carries no generation to compare against. */
  specSeen: { observed: number | null; generation: number | null };
  /** The operator has written nothing yet: no status at all. */
  silent: boolean;
  forceRedeploymentReason: string | null;
  worst: "err" | "warn" | null;
  findings: ScyllaFinding[];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function tasksOf(specTasks: unknown, statusTasks: unknown): Task[] {
  const declared = Array.isArray(specTasks) ? specTasks : [];
  const known = Array.isArray(statusTasks) ? statusTasks : [];
  return declared.map((task) => {
    const spec = (task ?? {}) as Record<string, unknown>;
    const name = text(spec.name) ?? "";
    const status = known.find(
      (s) => (s as Record<string, unknown>)?.name === name
    ) as Record<string, unknown> | undefined;
    return {
      name,
      interval: text(spec.interval) ?? text(spec.cron),
      startDate: text(spec.startDate),
      location: Array.isArray(spec.location)
        ? spec.location.filter((l): l is string => typeof l === "string")
        : [],
      retention: num(spec.retention),
      id: text(status?.id),
    };
  });
}

export function readScyllaCluster(
  resource: CustomResourceInfo,
  generation: number | null = null
): ScyllaCluster {
  const spec = (resource.spec ?? {}) as Record<string, unknown>;
  const status = (resource.status ?? null) as Record<string, unknown> | null;
  const datacenter = (spec.datacenter ?? {}) as Record<string, unknown>;
  const declaredRacks = Array.isArray(datacenter.racks) ? datacenter.racks : [];
  const rackStatus = (status?.racks ?? {}) as Record<
    string,
    Record<string, unknown>
  >;

  const racks: Rack[] = declaredRacks.map((raw) => {
    const rack = (raw ?? {}) as Record<string, unknown>;
    const name = text(rack.name) ?? "";
    const st = rackStatus[name] ?? {};
    const storage = (rack.storage ?? {}) as Record<string, unknown>;
    return {
      name,
      members: num(rack.members) ?? 0,
      // `null`, not 0: a rack the operator has not written a status for has
      // an unknown number of ready members, and "0 ready of 3" in warn is a
      // claim about a read nobody got.
      ready: num(st.readyMembers),
      updated: num(st.updatedMembers),
      version: text(st.version),
      stale: st.stale === true,
      capacity: text(storage.capacity),
    };
  });

  const available = conditionOf(resource, "Available");
  const progressing = conditionOf(resource, "Progressing");
  const degraded = conditionOf(resource, "Degraded");
  const upgradeRaw = status?.upgrade as Record<string, unknown> | undefined;
  const upgrade: Upgrade | null = upgradeRaw
    ? {
        state: text(upgradeRaw.state),
        fromVersion: text(upgradeRaw.fromVersion),
        toVersion: text(upgradeRaw.toVersion),
        currentRack: text(upgradeRaw.currentRack),
        currentNode: text(upgradeRaw.currentNode),
      }
    : null;
  const managerId = text(status?.managerId);
  const repairs = tasksOf(spec.repairs, status?.repairs);
  const backups = tasksOf(spec.backups, status?.backups);
  const version = text(spec.version);

  const findings: ScyllaFinding[] = [];
  const silent = status === null || Object.keys(status).length === 0;
  if (silent) {
    findings.push({ kind: "noStatus", severity: "warn", detail: null });
  }
  // A status with racks in it but no conditions — an older operator, or one
  // caught mid-reconcile — passed every arm below, which each need a
  // positive signal, and came out with no findings at all: drawn green and
  // labelled "rolled out". So did conditions the operator wrote as
  // `Unknown`, which is its way of saying it does not know either.
  const wrote = [available, progressing, degraded].filter(Boolean);
  if (!silent && wrote.length === 0) {
    findings.push({
      kind: "conditionsUnwritten",
      severity: "warn",
      detail: null,
    });
  } else if (wrote.some((c) => c?.status === "Unknown")) {
    findings.push({
      kind: "conditionsUnknown",
      severity: "warn",
      detail:
        wrote
          .filter((c) => c?.status === "Unknown")
          .map((c) => c!.type)
          .join(", ") || null,
    });
  }
  if (degraded?.status === "True") {
    findings.push({
      kind: "degraded",
      severity: "err",
      detail: degraded.message ?? degraded.reason ?? null,
    });
  }
  if (available?.status === "False") {
    findings.push({
      kind: "unavailable",
      severity: "err",
      detail: available.message ?? available.reason ?? null,
    });
  }
  if (upgrade && upgrade.fromVersion && upgrade.toVersion) {
    // The parts, not a sentence. `verbatim` is contracted to carry the
    // controller's own words, and "rack x on y" is neither the controller's
    // nor translatable — it was English prose built in the model.
    findings.push({
      kind: "upgrading",
      severity: "warn",
      detail: null,
      upgrade,
    });
  } else if (progressing?.status === "True") {
    findings.push({
      kind: "progressing",
      severity: "warn",
      detail: progressing.message ?? progressing.reason ?? null,
    });
  }
  const stale = racks.filter((r) => r.stale).map((r) => r.name);
  if (stale.length > 0) {
    findings.push({
      kind: "stale",
      severity: "warn",
      detail: stale.join(", "),
    });
  }
  // Only a rack the operator reported on can be short of members; one it has
  // not written about is unknown, and `conditionsUnwritten` above says so.
  const missing = racks.filter((r) => r.ready !== null && r.ready < r.members);
  if (!silent && missing.length > 0 && degraded?.status !== "True") {
    findings.push({
      kind: "membersMissing",
      severity: "warn",
      detail: missing
        .map((r) => `${r.name} ${r.ready}/${r.members}`)
        .join(", "),
    });
  }
  if (
    (repairs.length > 0 || backups.length > 0) &&
    managerId === null &&
    !silent
  ) {
    findings.push({
      kind: "tasksWithoutManager",
      severity: "warn",
      detail: null,
    });
  }

  return {
    name: resource.name,
    namespace: resource.namespace ?? "",
    uid: resource.uid,
    version,
    agentVersion: text(spec.agentVersion),
    datacenter: text(datacenter.name),
    racks,
    members: num(status?.members),
    readyMembers: num(status?.readyMembers),
    availableMembers: num(status?.availableMembers),
    conditions: {
      available: available?.status ?? null,
      progressing: progressing?.status ?? null,
      degraded: degraded?.status ?? null,
    },
    conditionMessages: {
      available: available?.message ?? null,
      progressing: progressing?.message ?? null,
      degraded: degraded?.message ?? null,
    },
    upgrade,
    managerId,
    repairs,
    backups,
    specSeen: { observed: num(status?.observedGeneration), generation },
    silent,
    forceRedeploymentReason: text(spec.forceRedeploymentReason),
    worst: findings.some((f) => f.severity === "err")
      ? "err"
      : findings.length > 0
        ? "warn"
        : null,
    findings,
  };
}

export function byTrouble(clusters: ScyllaCluster[]): ScyllaCluster[] {
  const rank = (c: ScyllaCluster) =>
    c.worst === "err" ? 0 : c.worst === "warn" ? 1 : 2;
  return [...clusters].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      a.namespace.localeCompare(b.namespace) ||
      a.name.localeCompare(b.name)
  );
}

/** A NodeConfig, reduced to whether every node it places on is set up. */
export interface NodeSetup {
  name: string;
  /** `null` where the operator has written no node statuses at all. */
  nodes: number | null;
  tuned: number | null;
  /** Conditions that say something is wrong, with the operator's messages. */
  problems: Array<{ type: string; message: string | null }>;
  /** Conditions the operator wrote as `Unknown`: it does not know either. */
  unsure: string[];
}

/**
 * Which way a condition points.
 *
 * `False` is the healthy value for half of these — `Degraded: False` and
 * `Progressing: False` are what a settled NodeConfig writes — so treating
 * every `False` as a problem reported a working cluster's own conditions
 * back to the reader as faults. A type this table does not name is assumed
 * positive, which is the Kubernetes convention and the safe direction: it
 * shows something rather than hiding it.
 */
const BAD_WHEN_TRUE = new Set(["Degraded"]);
/** `Progressing: True` is work in flight, not a fault; neither value is one. */
const NEITHER_IS_A_FAULT = new Set(["Progressing"]);

export function readNodeConfig(resource: CustomResourceInfo): NodeSetup {
  const statuses = getValueByPath(resource, "status.nodeStatuses");
  const list = Array.isArray(statuses) ? statuses : [];
  const conditions = getValueByPath(resource, "status.conditions");
  const written = Array.isArray(conditions) ? conditions : [];
  const problems = written
    .map((c) => c as Record<string, unknown>)
    .filter((cond) => {
      const type = String(cond.type ?? "");
      if (NEITHER_IS_A_FAULT.has(type)) return false;
      return BAD_WHEN_TRUE.has(type)
        ? cond.status === "True"
        : cond.status === "False";
    })
    .map((cond) => ({
      type: String(cond.type ?? ""),
      message: text(cond.message),
    }));
  // `Unknown` is the operator saying it does not know. Dropped silently, it
  // left a NodeConfig looking as settled as one that had really answered.
  const unsure = written
    .map((c) => c as Record<string, unknown>)
    .filter((cond) => cond.status === "Unknown")
    .map((cond) => String(cond.type ?? ""));
  return {
    name: resource.name,
    // `null`, not 0: a NodeConfig the operator has not reconciled has an
    // unknown number of nodes, and "0 of 0 nodes set up" is an answer.
    nodes: Array.isArray(statuses) ? list.length : null,
    tuned: Array.isArray(statuses)
      ? list.filter((n) => (n as Record<string, unknown>)?.tunedNode === true)
          .length
      : null,
    problems,
    unsure,
  };
}
