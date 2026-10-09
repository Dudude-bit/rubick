import type { CrdColumn } from "../kit";
import { conditionOf, getValueByPath, matchByGroup, orNone } from "../kit";
import type { CrdView } from "../registry";
import { GROUP } from "./data";

/** Scylla's three conditions folded into one word for a badge, the words kept. */
/** Scylla's three conditions folded into the one word the column draws. */
function condensedStatus(
  resource: Parameters<CrdColumn["accessor"]>[0]
): string | null {
  if (conditionOf(resource, "Degraded")?.status === "True") return "Degraded";
  if (conditionOf(resource, "Available")?.status === "False")
    return "Unavailable";
  if (conditionOf(resource, "Progressing")?.status === "True")
    return "Progressing";
  if (conditionOf(resource, "Available")?.status === "True") return "Available";
  return null;
}

const clusterColumns: CrdColumn[] = [
  {
    id: "version",
    header: "version",
    accessor: (resource) => getValueByPath(resource, "spec.version"),
    cell: orNone,
  },
  {
    id: "members",
    header: "members",
    // The same rule as the page: `?? 0` turned a cluster the operator has
    // not written a status for into "0/0", which reads as a cluster that
    // exists and has nothing running.
    accessor: (resource) => {
      const ready = getValueByPath(resource, "status.readyMembers");
      const total = getValueByPath(resource, "status.members");
      if (ready === undefined && total === undefined) return null;
      return `${ready ?? "?"}/${total ?? "?"}`;
    },
    cell: orNone,
  },
  {
    id: "racks",
    header: "racks",
    accessor: (resource) => {
      const racks = getValueByPath(resource, "spec.datacenter.racks");
      return Array.isArray(racks) ? racks.length : null;
    },
    cell: orNone,
  },
];

const defaultColumns: CrdColumn[] = [
  {
    id: "conditions",
    header: "conditions",
    accessor: (resource) => condensedStatus(resource),
    cell: orNone,
  },
];

export const crd: CrdView = {
  matches: matchByGroup(GROUP),
  columnsFor: (kind) =>
    kind === "ScyllaCluster" ? clusterColumns : defaultColumns,
};
