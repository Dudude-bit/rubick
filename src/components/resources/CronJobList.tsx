import type { ColumnDef } from "@tanstack/react-table";

import type { CronJobInfo } from "@/generated/types";
import { commands } from "@/lib/commands";
import { ResourceType } from "@/lib/resource-registry";
import { StatusBadge } from "@/components/ui/status-badge";
import { matchCronJobPods, type ResourceMetrics } from "@/lib/metrics";
import { RealtimeAge } from "@/components/ui/realtime/realtime-age";
import {
  createNameColumn,
  createNamespaceColumn,
  createAgeColumn,
  createCpuColumn,
  createMemoryColumn,
} from "./columns";
import { createWorkloadListPage } from "./createWorkloadListPage";

type CronJobInfoWithMetrics = CronJobInfo & ResourceMetrics;

const columns = (): ColumnDef<CronJobInfoWithMetrics>[] => [
  createNameColumn<CronJobInfoWithMetrics>(ResourceType.CronJob),
  createNamespaceColumn<CronJobInfoWithMetrics>(),
  createCpuColumn<CronJobInfoWithMetrics>(),
  createMemoryColumn<CronJobInfoWithMetrics>(),
  {
    accessorKey: "schedule",
    header: "Schedule",
    cell: ({ row }) => (
      <span className="font-mono text-fg-mid">{row.original.schedule}</span>
    ),
  },
  {
    id: "suspend",
    header: "Suspend",
    // Suspended is the exception worth colouring; "No" is the resting
    // state of every cronjob and stays quiet text.
    cell: ({ row }) =>
      row.original.suspend ? (
        <StatusBadge status="Suspended" />
      ) : (
        <span className="text-fg-fnt">No</span>
      ),
  },
  {
    id: "active",
    header: "Active",
    cell: ({ row }) => row.original.active,
  },
  {
    id: "last_schedule",
    header: "Last Schedule",
    cell: ({ row }) => (
      <span className="text-fg-fnt">
        {row.original.lastSchedule ? (
          <>
            <RealtimeAge timestamp={row.original.lastSchedule} /> ago
          </>
        ) : (
          "Never"
        )}
      </span>
    ),
  },
  createAgeColumn<CronJobInfoWithMetrics>(),
];

export const CronJobList = createWorkloadListPage<CronJobInfo>({
  resourceType: ResourceType.CronJob,
  title: "CronJobs",
  fetchList: ({ namespace }) =>
    commands.listCronjobs({
      namespace,
      labelSelector: null,
      fieldSelector: null,
      limit: null,
    }),
  matchPods: matchCronJobPods,
  watch: ({ namespace }) => commands.subscribeCronjobWatch(namespace),
  deleter: (item) => commands.deleteCronjob(item.name, item.namespace),
  columns,
});
