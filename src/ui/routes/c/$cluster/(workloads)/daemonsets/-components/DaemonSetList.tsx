import type { ColumnDef } from "@/components/ui/table-features";
import { columnHeader } from "@/i18n/column-header";

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
} from "../../../-list/columns";
import { createWorkloadListPage } from "../../-components/createWorkloadListPage";
import { createRolloutColumn } from "../../-components/rollout-column";

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
    header: columnHeader("columns", "desired"),
    meta: { share: (row: DaemonSetInfoWithMetrics) => String(row.desired) },
    cell: ({ row }) => row.original.desired,
  },
  {
    size: 90,
    id: "current",
    header: columnHeader("columns", "current"),
    meta: { share: (row: DaemonSetInfoWithMetrics) => String(row.current) },
    cell: ({ row }) => row.original.current,
  },
  {
    size: 100,
    id: "ready",
    header: columnHeader("columns", "ready"),
    meta: {
      share: (row: DaemonSetInfoWithMetrics) => ({
        text: String(row.ready),
        mono: true,
        role: row.ready === row.desired ? undefined : "warn",
      }),
    },
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
  createRolloutColumn<DaemonSetInfoWithMetrics>(),
  createAgeColumn<DaemonSetInfoWithMetrics>(),
];

export const DaemonSetList = createWorkloadListPage<DaemonSetInfo>({
  resourceType: ResourceType.DaemonSet,
  title: "DaemonSets",
  fetchList: ({ scope }) => commands.listDaemonsetsIn(scope),
  matchPods: matchDaemonSetPods,
  watch: ({ scope }) => commands.subscribeDaemonsetWatch(scope),
  rolloutFromPods: true,
  deleter: (item) => commands.deleteDaemonset(item.name, item.namespace),
  columns,
});
