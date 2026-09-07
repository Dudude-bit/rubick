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
  ready: number;
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
    | "noStatus";
  severity: "err" | "warn";
  detail: string | null;
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
      ready: num(st.readyMembers) ?? 0,
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
    findings.push({
      kind: "upgrading",
      severity: "warn",
      detail: [
        `${upgrade.fromVersion} → ${upgrade.toVersion}`,
        upgrade.currentRack ? `rack ${upgrade.currentRack}` : null,
        upgrade.currentNode ? `on ${upgrade.currentNode}` : null,
        upgrade.state,
      ]
        .filter(Boolean)
        .join(" · "),
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
  const missing = racks.filter((r) => r.ready < r.members);
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
  nodes: number;
  tuned: number;
  /** Conditions the operator wrote as False, with their messages. */
  problems: Array<{ type: string; message: string | null }>;
}

export function readNodeConfig(resource: CustomResourceInfo): NodeSetup {
  const statuses = getValueByPath(resource, "status.nodeStatuses");
  const list = Array.isArray(statuses) ? statuses : [];
  const conditions = getValueByPath(resource, "status.conditions");
  const problems = (Array.isArray(conditions) ? conditions : [])
    .filter((c) => (c as Record<string, unknown>)?.status === "False")
    .map((c) => {
      const cond = c as Record<string, unknown>;
      return { type: String(cond.type ?? ""), message: text(cond.message) };
    });
  return {
    name: resource.name,
    nodes: list.length,
    tuned: list.filter(
      (n) => (n as Record<string, unknown>)?.tunedNode === true
    ).length,
    problems,
  };
}
