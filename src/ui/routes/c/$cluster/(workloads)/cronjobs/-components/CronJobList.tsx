import type { ColumnDef } from "@/components/ui/table-features";
import { T } from "@/i18n/T";
import { columnHeader } from "@/i18n/column-header";
import { parts } from "@/i18n/parts";
import { useT } from "@/i18n/useT";

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
} from "../../../-list/columns";
import { createWorkloadListPage } from "../../-components/createWorkloadListPage";

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
      share: (row: CronJobInfoWithMetrics, t) =>
        row.suspend
          ? { text: "Suspended", role: "warn" }
          : t("empty", "noWord"),
    },
    // Suspended is the exception worth colouring; "No" is the resting
    // state of every cronjob and stays quiet text.
    cell: ({ row }) =>
      row.original.suspend ? (
        <StatusBadge status="Suspended" />
      ) : (
        <span className="text-fg-fnt">
          <T section="empty" k="noWord" />
        </span>
      ),
  },
  {
    size: 70,
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
