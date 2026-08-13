import type { ColumnDef } from "@tanstack/react-table";

import type { DaemonSetInfo } from "@/generated/types";
import { commands } from "@/lib/commands";
import { ResourceType } from "@/lib/resource-registry";
import { matchDaemonSetPods, type ResourceMetrics } from "@/lib/metrics";
import { cn } from "@/lib/utils";
import {
  createNameColumn,
  createNamespaceColumn,
  createAgeColumn,
  createCpuColumn,
  createMemoryColumn,
} from "./columns";
import { createWorkloadListPage } from "./createWorkloadListPage";

type DaemonSetInfoWithMetrics = DaemonSetInfo & ResourceMetrics;

export const columns = (): ColumnDef<DaemonSetInfoWithMetrics>[] => [
  createNameColumn<DaemonSetInfoWithMetrics>(ResourceType.DaemonSet),
  createNamespaceColumn<DaemonSetInfoWithMetrics>(),
  createCpuColumn<DaemonSetInfoWithMetrics>(),
  createMemoryColumn<DaemonSetInfoWithMetrics>(),
  // Three counts of nodes, so three columns as wide as their headers.
  {
    size: 90,
    id: "desired",
    header: "Desired",
    cell: ({ row }) => row.original.desired,
  },
  {
    size: 90,
    id: "current",
    header: "Current",
    cell: ({ row }) => row.original.current,
  },
  {
    size: 80,
    id: "ready",
    header: "Ready",
    cell: ({ row }) => {
      const { ready, desired } = row.original;
      // Full coverage is the expected state and stays quiet; only a shortfall
      // is worth a colour.
      return (
        <span
          className={cn(
            "font-mono",
            ready === desired ? "text-fg" : "text-warn"
          )}
        >
          {ready}
        </span>
      );
    },
  },
  createAgeColumn<DaemonSetInfoWithMetrics>(),
];

export const DaemonSetList = createWorkloadListPage<DaemonSetInfo>({
  resourceType: ResourceType.DaemonSet,
  title: "DaemonSets",
  fetchList: ({ namespace }) =>
    commands.listDaemonsets({
      namespace,
      labelSelector: null,
      fieldSelector: null,
      limit: null,
    }),
  matchPods: matchDaemonSetPods,
  watch: ({ namespace }) => commands.subscribeDaemonsetWatch(namespace),
  deleter: (item) => commands.deleteDaemonset(item.name, item.namespace),
  columns,
});
