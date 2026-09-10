import type { CrdColumn, CrdStatus } from "../kit";
import { getValueByPath, matchByGroup } from "../kit";
import type { CrdView } from "../registry";
import { GROUP } from "./data";

/** `status.phase` is CNPG's own sentence; the badge colours it and keeps the words. */
const status: CrdStatus = {
  getStatus: (resource) => {
    const phase = getValueByPath(resource, "status.phase");
    return typeof phase === "string" ? phase : null;
  },
  getVariant: (value) => {
    const phase = value.toLowerCase();
    if (phase === "cluster in healthy state" || phase === "completed") {
      return "default";
    }
    if (
      phase.includes("failed") ||
      phase.includes("unrecoverable") ||
      phase.includes("error")
    ) {
      return "destructive";
    }
    if (phase.includes("hibernated") || phase.includes("pending")) {
      return "outline";
    }
    return "secondary";
  },
};

const text = (value: unknown) => String(value ?? "-");

const clusterColumns: CrdColumn[] = [
  {
    id: "phase",
    header: "phase",
    accessor: (resource) => getValueByPath(resource, "status.phase"),
    cell: text,
  },
  {
    id: "instances",
    header: "instances",
    accessor: (resource) =>
      `${getValueByPath(resource, "status.readyInstances") ?? 0}/${
        getValueByPath(resource, "spec.instances") ?? 0
      }`,
    cell: text,
  },
  {
    id: "primary",
    header: "primaryInstance",
    accessor: (resource) => getValueByPath(resource, "status.currentPrimary"),
    cell: text,
  },
  {
    id: "image",
    header: "image",
    accessor: (resource) =>
      getValueByPath(resource, "status.image") ??
      getValueByPath(resource, "spec.imageName"),
    cell: text,
  },
];

const backupColumns: CrdColumn[] = [
  {
    id: "cluster",
    header: "cluster",
    accessor: (resource) => getValueByPath(resource, "spec.cluster.name"),
    cell: text,
  },
  {
    id: "phase",
    header: "phase",
    accessor: (resource) => getValueByPath(resource, "status.phase"),
    cell: text,
  },
  {
    id: "method",
    header: "backupMethod",
    accessor: (resource) =>
      getValueByPath(resource, "status.method") ??
      getValueByPath(resource, "spec.method"),
    cell: text,
  },
];

const scheduledColumns: CrdColumn[] = [
  {
    id: "cluster",
    header: "cluster",
    accessor: (resource) => getValueByPath(resource, "spec.cluster.name"),
    cell: text,
  },
  {
    id: "schedule",
    header: "schedule",
    accessor: (resource) => getValueByPath(resource, "spec.schedule"),
    cell: text,
  },
  {
    id: "lastRun",
    header: "lastRun",
    accessor: (resource) => getValueByPath(resource, "status.lastScheduleTime"),
    cell: text,
  },
];

const poolerColumns: CrdColumn[] = [
  {
    id: "cluster",
    header: "cluster",
    accessor: (resource) => getValueByPath(resource, "spec.cluster.name"),
    cell: text,
  },
  {
    id: "type",
    header: "type",
    accessor: (resource) => getValueByPath(resource, "spec.type"),
    cell: text,
  },
  {
    id: "mode",
    header: "mode",
    accessor: (resource) => getValueByPath(resource, "spec.pgbouncer.poolMode"),
    cell: text,
  },
];

const defaultColumns: CrdColumn[] = [
  {
    id: "phase",
    header: "phase",
    accessor: (resource) => getValueByPath(resource, "status.phase"),
    cell: text,
  },
];

export const crd: CrdView = {
  matches: matchByGroup(GROUP),
  columnsFor: (kind) => {
    switch (kind) {
      case "Cluster":
        return clusterColumns;
      case "Backup":
        return backupColumns;
      case "ScheduledBackup":
        return scheduledColumns;
      case "Pooler":
        return poolerColumns;
      default:
        return defaultColumns;
    }
  },
  status,
};
