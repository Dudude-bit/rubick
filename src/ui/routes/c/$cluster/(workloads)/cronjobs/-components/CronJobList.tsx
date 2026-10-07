import type { ColumnDef } from "@/components/ui/table-features";
import { T } from "@/i18n/T";
import { columnHeader } from "@/i18n/column-header";
import { parts } from "@/i18n/parts";
import { useT } from "@/i18n/useT";

import type { CronJobInfo } from "@/generated/types";
import { commands } from "@/lib/commands";
import { ResourceType } from "@/lib/resource-registry";
import { cronStatusWord } from "@/lib/status-words";
import { matchCronJobPods, type ResourceMetrics } from "@/lib/metrics";
import { RealtimeAge } from "@/components/ui/realtime/realtime-age";
import {
  createNameColumn,
  createNamespaceColumn,
  createAgeColumn,
  createCpuColumn,
  createMemoryColumn,
  statusCellPx,
} from "../../../-list/columns";
import { createWorkloadListPage } from "../../-components/createWorkloadListPage";
import { CronStatusBadge } from "./CronStatusBadge";

type CronJobInfoWithMetrics = CronJobInfo & ResourceMetrics;

export const columns = (): ColumnDef<CronJobInfoWithMetrics>[] => [
  createNameColumn<CronJobInfoWithMetrics>(ResourceType.CronJob),
  createNamespaceColumn<CronJobInfoWithMetrics>(),
  createCpuColumn<CronJobInfoWithMetrics>(),
  createMemoryColumn<CronJobInfoWithMetrics>(),
  {
    // Five mono fields and their spaces: `0 */6 * * MON-FRI`.
    size: 150,
    accessorKey: "schedule",
    header: columnHeader("columns", "schedule"),
    cell: ({ row }) => (
      <span className="font-mono text-fg-mid">{row.original.schedule}</span>
    ),
  },
  {
    size: 100,
    id: "suspend",
    header: columnHeader("columns", "suspend"),
    meta: {
      floor: statusCellPx(14),
      share: (row: CronJobInfoWithMetrics, t) =>
        row.suspend
          ? { text: cronStatusWord(true, t), role: "warn" }
          : { text: t("empty", "noLower"), quiet: true },
    },
    // Suspended is the exception worth colouring; "no" is the resting
    // state of every cronjob and stays quiet text, cased like "none".
    cell: ({ row }) =>
      row.original.suspend ? (
        <CronStatusBadge suspend />
      ) : (
        <span className="text-fg-fnt">
          <T section="empty" k="noLower" />
        </span>
      ),
  },
  {
    size: 84,
    id: "active",
    header: columnHeader("columns", "active"),
    meta: { share: (row: CronJobInfoWithMetrics) => String(row.active) },
    cell: ({ row }) => row.original.active,
  },
  {
    // "3d ago", under a header twice the width of its own values.
    size: 160,
    id: "last_schedule",
    header: columnHeader("columns", "lastSchedule"),
    meta: {
      share: (row: CronJobInfoWithMetrics, t) =>
        row.lastSchedule
          ? { text: row.lastSchedule, at: row.lastSchedule }
          : t("action", "never"),
    },
    cell: ({ row }) => <LastSchedule at={row.original.lastSchedule} />,
  },
  createAgeColumn<CronJobInfoWithMetrics>(),
];

// The cell needs the translator, so it is a component; `columns` is exported
// for `column-widths.test.ts`, which costs this file its fast refresh.
// oxlint-disable-next-line react-refresh/only-export-components
function LastSchedule({ at }: { at: string | null }) {
  const t = useT();
  return (
    <span className="text-fg-fnt">
      {at
        ? parts(t("action", "agoSuffix"), {
            age: <RealtimeAge timestamp={at} />,
          })
        : t("action", "never")}
    </span>
  );
}

export const CronJobList = createWorkloadListPage<CronJobInfo>({
  resourceType: ResourceType.CronJob,
  title: "CronJobs",
  fetchList: ({ scope }) => commands.listCronjobsIn(scope),
  matchPods: matchCronJobPods,
  watch: ({ scope }) => commands.subscribeCronjobWatch(scope),
  deleter: (item) => commands.deleteCronjob(item.name, item.namespace),
  columns,
});
