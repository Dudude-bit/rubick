import type { ColumnDef } from "@/components/ui/table-features";
import { columnHeader } from "@/i18n/column-header";

import type { JobInfo } from "@/generated/types";
import { commands } from "@/lib/commands";
import { ResourceType } from "@/lib/resource-registry";
import { matchJobPods, type ResourceMetrics } from "@/lib/metrics";
import {
  createNameColumn,
  createNamespaceColumn,
  createAgeColumn,
  createCpuColumn,
  createMemoryColumn,
  statusCellPx,
} from "../../../-list/columns";
import { createWorkloadListPage } from "../../-components/createWorkloadListPage";
import { ownStatusWord } from "@/lib/status-words";
import { JobStatusCell } from "./JobStatusCell";

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
    header: columnHeader("columns", "completions"),
    meta: {
      share: (row: JobInfoWithMetrics) =>
        `${row.succeeded}/${row.completions || "∞"}`,
    },
    cell: ({ row }) =>
      `${row.original.succeeded}/${row.original.completions || "∞"}`,
  },
  {
    size: 220,
    id: "status",
    header: columnHeader("columns", "status"),
    meta: {
      floor: statusCellPx(17),
      share: (row: JobInfoWithMetrics, t) => {
        const word = ownStatusWord(row.status, t) ?? row.status;
        return row.failure?.reason ? `${word} ${row.failure.reason}` : word;
      },
    },
    cell: ({ row }) => <JobStatusCell job={row.original} />,
  },
  createAgeColumn<JobInfoWithMetrics>(),
];

export const JobList = createWorkloadListPage<JobInfo>({
  resourceType: ResourceType.Job,
  title: "Jobs",
  fetchList: ({ scope }) => commands.listJobsIn(scope),
  matchPods: matchJobPods,
  watch: ({ scope }) => commands.subscribeJobWatch(scope),
  deleter: (item) => commands.deleteJob(item.name, item.namespace),
  columns,
});
