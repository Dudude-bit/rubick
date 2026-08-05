import type { ColumnDef } from "@tanstack/react-table";

import type { DaemonSetInfo } from "@/generated/types";
import { commands } from "@/lib/commands";
import { ResourceType } from "@/lib/resource-registry";
import { getResourceListUrl } from "@/lib/navigation-utils";
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

const columns = (): ColumnDef<DaemonSetInfoWithMetrics>[] => [
  createNameColumn<DaemonSetInfoWithMetrics>(
    getResourceListUrl(ResourceType.DaemonSet)
  ),
  createNamespaceColumn<DaemonSetInfoWithMetrics>(),
  createCpuColumn<DaemonSetInfoWithMetrics>(),
  createMemoryColumn<DaemonSetInfoWithMetrics>(),
  {
    id: "desired",
    header: "Desired",
    cell: ({ row }) => row.original.desired,
  },
  {
    id: "current",
    header: "Current",
    cell: ({ row }) => row.original.current,
  },
  {
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
