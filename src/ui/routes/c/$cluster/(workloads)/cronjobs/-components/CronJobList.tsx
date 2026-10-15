import type { ColumnDef } from "@/components/ui/table-features";
import { T } from "@/i18n/T";
import { columnHeader } from "@/i18n/column-header";
import { parts } from "@/i18n/parts";
import { useT } from "@/i18n/useT";

import type { CronJobInfo } from "@/generated/types";
import { commands } from "@/lib/commands";
import { ResourceType } from "@/lib/resource-registry";
import { cronStatusWord } from "@/lib/status-words";
import {
  cronOutcome,
  outcomeWords,
  scheduledRun,
  TONE_ROLE,
  type CronOutcome,
} from "@/lib/cron-outcome";
import { TONE_TEXT } from "@/lib/tone";
import { matchCronJobPods } from "@/lib/metrics";
import { RealtimeAge } from "@/components/ui/realtime/realtime-age";
import { widestText } from "@/lib/text-width";
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
  rowCauseText,
  type RowVerdict,
  type WorkloadRow,
} from "../../-components/row-cause";
import { VerdictWithCause } from "../../-components/RowCauseText";
import { CronStatusBadge } from "./CronStatusBadge";

type CronJobInfoWithMetrics = WorkloadRow<CronJobInfo>;

/** Where a run's outcome leaves its pods' cause: a run that succeeded, or none, has none to tell. */
const CRON_VERDICT: Record<CronOutcome, RowVerdict> = {
  never: "settled",
  succeeded: "settled",
  running: "open",
  notSucceeded: "trouble",
};

const LAST_RUN_FLOOR = widestText(["did not succeed"], "sans", 6.6) + 20;

export const columns = (): ColumnDef<CronJobInfoWithMetrics>[] => [
  createNameColumn<CronJobInfoWithMetrics>(ResourceType.CronJob),
  createNamespaceColumn<CronJobInfoWithMetrics>(),
  yielding(createCpuColumn<CronJobInfoWithMetrics>(), 2),
  yielding(createMemoryColumn<CronJobInfoWithMetrics>(), 1),
  {
    // Five mono fields and their spaces: `0 */6 * * MON-FRI`.
    size: 150,
    accessorKey: "schedule",
    header: columnHeader("columns", "schedule"),
    meta: { floor: () => widestText(["*/15 * * * *"], "mono", 7.2) + 20 },
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
    meta: {
      yields: 4,
      share: (row: CronJobInfoWithMetrics) => String(row.active),
    },
    cell: ({ row }) => row.original.active,
  },
  {
    // "3d ago", under a header twice the width of its own values.
    size: 160,
    id: "last_schedule",
    header: columnHeader("columns", "lastSchedule"),
    meta: {
      yields: 5,
      share: (row: CronJobInfoWithMetrics, t) =>
        row.lastSchedule
          ? { text: row.lastSchedule, at: row.lastSchedule }
          : t("action", "never"),
    },
    cell: ({ row }) => <LastSchedule at={row.original.lastSchedule} />,
  },
  {
    size: 130,
    id: "last_run",
    header: columnHeader("columns", "lastRun"),
    meta: {
      floor: () => LAST_RUN_FLOOR,
      ideal: (t, rows: readonly CronJobInfoWithMetrics[]) =>
        LAST_RUN_FLOOR +
        causeCellPx(
          rows.map((row) => ({
            podsCause: row.podsCause,
            verdict: CRON_VERDICT[cronOutcome(row)],
          })),
          t
        ),
      share: (row: CronJobInfoWithMetrics, t) => {
        const outcome = cronOutcome(row);
        const { word, tone } = outcomeWords(outcome, t);
        const cause = rowCauseText(row.podsCause, CRON_VERDICT[outcome], t);
        const text = cause ? `${word} · ${cause}` : word;
        return tone ? { text, role: TONE_ROLE[tone] } : { text, quiet: true };
      },
    },
    cell: ({ row }) => <LastRun cron={row.original} />,
  },
  yielding(createAgeColumn<CronJobInfoWithMetrics>(), 3),
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

// oxlint-disable-next-line react-refresh/only-export-components
function LastRun({ cron }: { cron: CronJobInfoWithMetrics }) {
  const t = useT();
  const outcome = cronOutcome(cron);
  const { word, tone } = outcomeWords(outcome, t);
  return (
    <VerdictWithCause cause={cron.podsCause} verdict={CRON_VERDICT[outcome]}>
      <span className={tone ? TONE_TEXT[tone] : "text-fg-fnt"}>{word}</span>
    </VerdictWithCause>
  );
}

export const CronJobList = createWorkloadListPage<CronJobInfo>({
  resourceType: ResourceType.CronJob,
  title: "CronJobs",
  fetchList: ({ scope }) => commands.listCronjobsIn(scope),
  matchPods: matchCronJobPods,
  causeOwner: (cron) => {
    const run = scheduledRun(cron);
    return run === null ? null : { kind: "Job", name: run };
  },
  watch: ({ scope }) => commands.subscribeCronjobWatch(scope),
  deleter: (item) => commands.deleteCronjob(item.name, item.namespace),
  columns,
});
