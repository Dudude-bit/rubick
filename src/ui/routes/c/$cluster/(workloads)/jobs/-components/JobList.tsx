import type { ColumnDef } from "@/components/ui/table-features";
import { columnHeader } from "@/i18n/column-header";

import type { JobInfo } from "@/generated/types";
import { commands } from "@/lib/commands";
import { ResourceType } from "@/lib/resource-registry";
import { matchJobPods } from "@/lib/metrics";
import {
  createNameColumn,
  createNamespaceColumn,
  createAgeColumn,
  createCpuColumn,
  createMemoryColumn,
  statusCellPx,
  yielding,
} from "../../../-list/columns";
import { createWorkloadListPage } from "../../-components/createWorkloadListPage";
import {
  causeCellPx,
  jobVerdict,
  rowCauseText,
  type WorkloadRow,
} from "../../-components/row-cause";
import { ownStatusWord } from "@/lib/status-words";
import { widestText } from "@/lib/text-width";
import type { T as Translate } from "@/i18n/useT";
import { JobStatusCell } from "./JobStatusCell";

type JobInfoWithMetrics = WorkloadRow<JobInfo>;

/** The most of a controller's reason a cell keeps whole: `BackoffLimitExceeded` and its like; a longer one ends in an ellipsis. */
const REASON_GLYPHS = 24;

/**
 * The widest status a row says with what it draws beside it: the badge, its
 * 6px gap and the reason or the failed pods. Sized for the badge alone, the
 * column drew "Fai… BackoffLimitEx…" while the Age column beside it sat empty.
 */
function statusFloor(t: Translate, rows: readonly JobInfoWithMetrics[]) {
  if (rows.length === 0) return statusCellPx(17);
  return Math.max(
    ...rows.map((job) => {
      const badge = widestText(
        [ownStatusWord(job.status, t) ?? String(job.status)],
        "badge",
        6.6
      );
      const beside =
        job.status === "Retrying"
          ? widestText(
              [t("count", "failedPods", { n: job.failed })],
              "caption",
              6.2
            ) + 6
          : job.failure?.reason
            ? Math.min(
                widestText([job.failure.reason], "badge", 6.6),
                REASON_GLYPHS * 6.6
              ) + 6
            : 0;
      return Math.ceil(badge + 14 + beside + 20);
    })
  );
}

export const columns = (): ColumnDef<JobInfoWithMetrics>[] => [
  createNameColumn<JobInfoWithMetrics>(ResourceType.Job),
  createNamespaceColumn<JobInfoWithMetrics>(),
  yielding(createCpuColumn<JobInfoWithMetrics>(), 2),
  yielding(createMemoryColumn<JobInfoWithMetrics>(), 1),
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
      floor: statusFloor,
      ideal: (t, rows: readonly JobInfoWithMetrics[]) =>
        statusFloor(t, rows) +
        causeCellPx(
          rows.map((row) => ({
            podsCause: row.podsCause,
            verdict: jobVerdict(row.status),
          })),
          t
        ),
      share: (row: JobInfoWithMetrics, t) => {
        const word = ownStatusWord(row.status, t) ?? row.status;
        const said = row.failure?.reason
          ? `${word} ${row.failure.reason}`
          : word;
        const cause = rowCauseText(row.podsCause, jobVerdict(row.status), t);
        return cause ? `${said} · ${cause}` : said;
      },
    },
    cell: ({ row }) => <JobStatusCell job={row.original} />,
  },
  yielding(createAgeColumn<JobInfoWithMetrics>(), 3),
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
