import type { ColumnDef } from "@/components/ui/table-features";
import { columnHeader } from "@/i18n/column-header";
import {
  rolloutSettled,
  rolloutVerdict,
  workloadRole,
} from "@/lib/workload-status";
import type { Rollout } from "@/generated/types";
import { WithProblem } from "../../-object/ProblemTone";
import {
  PROBLEM_MARK_COMPACT_PX,
  PROBLEM_MARK_PX,
  type Problem,
} from "../../-object/problem";
import { RolloutBadge } from "../../-object/RolloutSummary";
import { statusCellPx } from "../../-list/columns";
import {
  causeCellPx,
  rowCauseText,
  verdictByRole,
  type RowCause,
  type RowVerdict,
} from "./row-cause";
import { VerdictWithCause } from "./RowCauseText";

type RolloutRow = {
  rollout: Rollout;
  podsCause: RowCause;
  problem?: Problem | null;
};

/** Where a rollout leaves its pods' cause; one whose pods were not read is neutral and says so on its own badge. */
const verdictOf = (rollout: Rollout): RowVerdict =>
  verdictByRole(workloadRole(rollout), rolloutSettled(rollout));

const SEVERITY: Record<RowVerdict, number> = {
  settled: 0,
  open: 1,
  trouble: 2,
};
const PROBLEM_RANK = { warn: 1, err: 2 } as const;

const FLOOR = statusCellPx(14);
const WORD_FLOOR = statusCellPx(5);

/** Where each row's rollout stands, in the word the page and the peek print, and the cause its pods share. */
export function createRolloutColumn<Row extends RolloutRow>(): ColumnDef<Row> {
  return {
    size: 120,
    id: "status",
    header: columnHeader("columns", "status"),
    meta: {
      floor: (_t: unknown, rows: readonly Row[]) =>
        rows.some((row) => row.problem)
          ? Math.max(FLOOR, WORD_FLOOR + PROBLEM_MARK_COMPACT_PX)
          : FLOOR,
      sort: (row: Row) =>
        SEVERITY[verdictOf(row.rollout)] * 10 +
        (row.problem ? PROBLEM_RANK[row.problem.tone] : 0),
      ideal: (t, rows: readonly Row[]) =>
        FLOOR +
        (rows.some((row) => row.problem) ? PROBLEM_MARK_PX : 0) +
        causeCellPx(
          rows.map((row) => ({
            podsCause: row.podsCause,
            verdict: verdictOf(row.rollout),
          })),
          t
        ),
      share: (row: Row, t) => {
        const verdict = rolloutVerdict(row.rollout, t);
        const cause = rowCauseText(row.podsCause, verdictOf(row.rollout), t);
        const said = [cause, row.problem?.title].filter(Boolean).join(" · ");
        return said
          ? { ...verdict, text: `${verdict.text} · ${said}` }
          : verdict;
      },
    },
    cell: ({ row }) => (
      <div className="@container min-w-0">
        <VerdictWithCause
          cause={row.original.podsCause}
          verdict={verdictOf(row.original.rollout)}
        >
          <WithProblem
            problem={row.original.problem ?? null}
            role={workloadRole(row.original.rollout)}
          >
            <RolloutBadge rollout={row.original.rollout} />
          </WithProblem>
        </VerdictWithCause>
      </div>
    ),
  };
}
