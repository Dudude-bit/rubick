import type { CrdColumn, CrdStatus } from "../kit";
import { conditionOf, getValueByPath, matchByGroup } from "../kit";
import type { CrdView } from "../registry";
import { GROUP } from "./data";

/** Scylla's three conditions folded into one word for a badge, the words kept. */
const status: CrdStatus = {
  getStatus: (resource) => {
    if (conditionOf(resource, "Degraded")?.status === "True") return "Degraded";
    if (conditionOf(resource, "Available")?.status === "False")
      return "Unavailable";
    if (conditionOf(resource, "Progressing")?.status === "True")
      return "Progressing";
    if (conditionOf(resource, "Available")?.status === "True")
      return "Available";
    return null;
  },
  getVariant: (value) => {
    switch (value) {
      case "Available":
        return "default";
      case "Progressing":
        return "secondary";
      case "Degraded":
      case "Unavailable":
        return "destructive";
      default:
        return "outline";
    }
  },
};

const text = (value: unknown) => String(value ?? "-");

const clusterColumns: CrdColumn[] = [
  {
    id: "version",
    header: "version",
    accessor: (resource) => getValueByPath(resource, "spec.version"),
    cell: text,
  },
  {
    id: "members",
    header: "members",
    accessor: (resource) =>
      `${getValueByPath(resource, "status.readyMembers") ?? 0}/${
        getValueByPath(resource, "status.members") ?? 0
      }`,
    cell: text,
  },
  {
    id: "racks",
    header: "racks",
    accessor: (resource) => {
      const racks = getValueByPath(resource, "spec.datacenter.racks");
      return Array.isArray(racks) ? racks.length : null;
    },
    cell: text,
  },
];

const defaultColumns: CrdColumn[] = [
  {
    id: "conditions",
    header: "conditions",
    accessor: (resource) => status.getStatus(resource),
    cell: text,
  },
];

export const crd: CrdView = {
  matches: matchByGroup(GROUP),
  columnsFor: (kind) =>
    kind === "ScyllaCluster" ? clusterColumns : defaultColumns,
  status,
};
