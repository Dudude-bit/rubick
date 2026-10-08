import type { ColumnDef } from "@/components/ui/table-features";
import { columnHeader } from "@/i18n/column-header";
import { rolloutVerdict } from "@/lib/workload-status";
import type { Rollout } from "@/generated/types";
import { RolloutBadge } from "../../-object/RolloutSummary";
import { statusCellPx } from "../../-list/columns";

/** Where each row's rollout stands, in the word the page and the peek print. */
export function createRolloutColumn<
  Row extends { rollout: Rollout },
>(): ColumnDef<Row> {
  return {
    size: 120,
    id: "status",
    header: columnHeader("columns", "status"),
    meta: {
      floor: statusCellPx(12),
      share: (row: Row, t) => rolloutVerdict(row.rollout, t),
    },
    cell: ({ row }) => <RolloutBadge rollout={row.original.rollout} />,
  };
}
