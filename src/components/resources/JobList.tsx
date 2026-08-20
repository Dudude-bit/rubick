import type { ColumnDef } from "@tanstack/react-table";
import { T } from "@/i18n/T";

import type { JobInfo } from "@/generated/types";
import { commands } from "@/lib/commands";
import { ResourceType } from "@/lib/resource-registry";
import { matchJobPods, type ResourceMetrics } from "@/lib/metrics";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  createNameColumn,
  createNamespaceColumn,
  createAgeColumn,
  createCpuColumn,
  createMemoryColumn,
} from "./columns";
import { createWorkloadListPage } from "./createWorkloadListPage";

type JobInfoWithMetrics = JobInfo & ResourceMetrics;

export const columns = (): ColumnDef<JobInfoWithMetrics>[] => [
  createNameColumn<JobInfoWithMetrics>(ResourceType.Job),
  createNamespaceColumn<JobInfoWithMetrics>(),
  createCpuColumn<JobInfoWithMetrics>(),
  createMemoryColumn<JobInfoWithMetrics>(),
  {
    // "1/1", under a header that is the widest thing in the column.
    size: 110,
    id: "completions",
    header: () => <T section="columns" k="completions" />,
    cell: ({ row }) =>
      `${row.original.succeeded}/${row.original.completions || "∞"}`,
  },
  {
    size: 110,
    id: "status",
    header: () => <T section="columns" k="status" />,
    cell: ({ row }) => <StatusBadge status={row.original.status} />,
  },
  createAgeColumn<JobInfoWithMetrics>(),
];

export const JobList = createWorkloadListPage<JobInfo>({
  resourceType: ResourceType.Job,
  title: "Jobs",
  fetchList: ({ namespace }) =>
    commands.listJobs({
      namespace,
      labelSelector: null,
      fieldSelector: null,
      limit: null,
    }),
  matchPods: matchJobPods,
  watch: ({ namespace }) => commands.subscribeJobWatch(namespace),
  deleter: (item) => commands.deleteJob(item.name, item.namespace),
  columns,
});
