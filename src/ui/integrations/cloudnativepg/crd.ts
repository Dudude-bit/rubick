import type { CrdColumn } from "../kit";
import { getValueByPath, matchByGroup, orNone, orNotWritten } from "../kit";
import type { CrdView } from "../registry";
import { GROUP } from "./data";

const clusterColumns: CrdColumn[] = [
  {
    id: "phase",
    header: "phase",
    accessor: (resource) => getValueByPath(resource, "status.phase"),
    cell: orNotWritten,
  },
  {
    id: "instances",
    header: "instances",
    accessor: (resource) =>
      `${getValueByPath(resource, "status.readyInstances") ?? 0}/${
        getValueByPath(resource, "spec.instances") ?? 0
      }`,
    cell: orNone,
  },
  {
    id: "primary",
    header: "primaryInstance",
    accessor: (resource) => getValueByPath(resource, "status.currentPrimary"),
    cell: orNotWritten,
  },
  {
    id: "image",
    header: "image",
    accessor: (resource) =>
      getValueByPath(resource, "status.image") ??
      getValueByPath(resource, "spec.imageName"),
    cell: orNone,
  },
];

const backupColumns: CrdColumn[] = [
  {
    id: "cluster",
    header: "cluster",
    accessor: (resource) => getValueByPath(resource, "spec.cluster.name"),
    cell: orNone,
  },
  {
    id: "phase",
    header: "phase",
    accessor: (resource) => getValueByPath(resource, "status.phase"),
    cell: orNotWritten,
  },
  {
    id: "method",
    header: "backupMethod",
    accessor: (resource) =>
      getValueByPath(resource, "status.method") ??
      getValueByPath(resource, "spec.method"),
    cell: orNone,
  },
];

const scheduledColumns: CrdColumn[] = [
  {
    id: "cluster",
    header: "cluster",
    accessor: (resource) => getValueByPath(resource, "spec.cluster.name"),
    cell: orNone,
  },
  {
    id: "schedule",
    header: "schedule",
    accessor: (resource) => getValueByPath(resource, "spec.schedule"),
    cell: orNone,
  },
  {
    id: "lastRun",
    header: "lastRun",
    accessor: (resource) => getValueByPath(resource, "status.lastScheduleTime"),
    cell: orNotWritten,
  },
];

const poolerColumns: CrdColumn[] = [
  {
    id: "cluster",
    header: "cluster",
    accessor: (resource) => getValueByPath(resource, "spec.cluster.name"),
    cell: orNone,
  },
  {
    id: "type",
    header: "type",
    accessor: (resource) => getValueByPath(resource, "spec.type"),
    cell: orNone,
  },
  {
    id: "mode",
    header: "mode",
    accessor: (resource) => getValueByPath(resource, "spec.pgbouncer.poolMode"),
    cell: orNone,
  },
];

const defaultColumns: CrdColumn[] = [
  {
    id: "phase",
    header: "phase",
    accessor: (resource) => getValueByPath(resource, "status.phase"),
    cell: orNotWritten,
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
};
