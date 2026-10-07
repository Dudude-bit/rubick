import type { ColumnDef } from "@/components/ui/table-features";
import { columnHeader } from "@/i18n/column-header";
import { statusRole } from "@/lib/status-role";
import { ownStatusWord } from "@/lib/status-words";
import { workloadStatus } from "@/lib/workload-status";
import type { Rollout } from "@/generated/types";
import { RolloutBadge } from "../../-object/RolloutSummary";

/** Where each row's rollout stands, in the word the page and the peek print. */
export function createRolloutColumn<
  Row extends { rollout: Rollout },
>(): ColumnDef<Row> {
  return {
    size: 120,
    id: "status",
    header: columnHeader("columns", "status"),
    meta: {
      share: (row: Row, t) => {
        const code = workloadStatus(row.rollout);
        return { text: ownStatusWord(code, t) ?? code, role: statusRole(code) };
      },
    },
    cell: ({ row }) => <RolloutBadge rollout={row.original.rollout} />,
  };
}
