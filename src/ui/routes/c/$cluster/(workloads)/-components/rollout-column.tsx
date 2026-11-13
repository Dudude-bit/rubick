import type { ColumnDef } from "@/components/ui/table-features";
import { columnHeader } from "@/i18n/column-header";
import {
  rolloutSettled,
  rolloutVerdict,
  workloadRole,
} from "@/lib/workload-status";
import type { Rollout } from "@/generated/types";
import { WithProblem } from "../../-object/ProblemTone";
import type { Problem } from "../../-object/problem";
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

const FLOOR = statusCellPx(14);
const PROBLEM_PX = Math.ceil(13 * 6.6);

/** Where each row's rollout stands, in the word the page and the peek print, and the cause its pods share. */
export function createRolloutColumn<Row extends RolloutRow>(): ColumnDef<Row> {
  return {
    size: 120,
    id: "status",
    header: columnHeader("columns", "status"),
    meta: {
      floor: FLOOR,
      ideal: (t, rows: readonly Row[]) =>
        FLOOR +
        (rows.some((row) => row.problem) ? PROBLEM_PX : 0) +
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
    ),
  };
}
