import { CELL_PADS_PX } from "@/components/ui/column-shares";
import type { ColumnDef } from "@/components/ui/table-features";

import type { NetworkPolicyInfo } from "@/generated/types";
import { columnHeader } from "@/i18n/column-header";
import type { T } from "@/i18n/useT";
import { commands } from "@/lib/commands";
import {
  directionCellWords,
  directionWords,
  reachWords,
  selectsWords,
} from "@/lib/network-policy";
import { ResourceType } from "@/lib/resource-registry";
import { widestText } from "@/lib/text-width";
import {
  DirectionCell,
  ReachCell,
  SelectsCell,
} from "../../../-object/network-policy-cells";
import {
  createNameColumn,
  createNamespaceColumn,
  createAgeColumn,
  yielding,
} from "../../../-list/columns";
import { createResourceListPage } from "../../../-list/createResourceListPage";

/** The most of a selector the column holds open, 24 glyphs; the rest is on hover. */
const SELECTS_PX = 24 * 7.2;

const selectsFloor = (t: T, rows: readonly NetworkPolicyInfo[]) =>
  Math.max(
    Math.min(
      widestText(
        rows.flatMap((row) =>
          row.selects.kind === "written" ? [row.selects.query] : []
        ),
        "mono",
        7.2
      ),
      SELECTS_PX
    ),
    widestText(
      rows
        .filter((row) => row.selects.kind !== "written")
        .map((row) => selectsWords(row.selects, t)),
      "sans",
      7
    )
  ) + CELL_PADS_PX;

const wordsFloor =
  (words: (row: NetworkPolicyInfo, t: T) => string) =>
  (t: T, rows: readonly NetworkPolicyInfo[]) =>
    widestText(
      rows.map((row) => words(row, t)),
      "sans",
      7
    ) + CELL_PADS_PX;

// Exported for `column-widths.test.ts`: a column with no declared width gets
// an equal share of a `table-fixed` table.
export const networkPolicyColumns: ColumnDef<NetworkPolicyInfo>[] = [
  createNameColumn<NetworkPolicyInfo>(ResourceType.NetworkPolicy),
  createNamespaceColumn<NetworkPolicyInfo>(),
  {
    size: 220,
    id: "selects",
    // The query text, so the search box matches it. An accessor over the
    // tagged union would stringify to `[object Object]`.
    accessorFn: (row) =>
      row.selects.kind === "written" ? row.selects.query : "",
    header: columnHeader("columns", "selects"),
    meta: {
      share: (row: NetworkPolicyInfo, t) => selectsWords(row.selects, t),
      // Beside the peek, which draws the selector of the row it shows.
      yields: 2,
      floor: selectsFloor,
    },
    cell: ({ row }) => <SelectsCell policy={row.original} />,
  },
  {
    size: 110,
    id: "behind",
    header: columnHeader("columns", "pods"),
    meta: {
      share: (row: NetworkPolicyInfo, t) => {
        const said = reachWords(row.selected, t);
        return { text: said.text, role: said.role ?? undefined };
      },
      floor: wordsFloor((row, t) => reachWords(row.selected, t).text),
    },
    cell: ({ row }) => <ReachCell policy={row.original} />,
  },
  {
    size: 130,
    id: "ingress",
    // `policyTypes` writes these two words; they are the cluster's, not ours.
    header: "Ingress",
    meta: {
      share: (row: NetworkPolicyInfo, t) => {
        const said = directionWords(row.ingress, t);
        return { text: said.text, role: said.role ?? undefined };
      },
      floor: wordsFloor((row, t) => directionCellWords(row.ingress, t)),
    },
    cell: ({ row }) => <DirectionCell direction={row.original.ingress} />,
  },
  {
    size: 130,
    id: "egress",
    header: "Egress",
    meta: {
      share: (row: NetworkPolicyInfo, t) => {
        const said = directionWords(row.egress, t);
        return { text: said.text, role: said.role ?? undefined };
      },
      floor: wordsFloor((row, t) => directionCellWords(row.egress, t)),
    },
    cell: ({ row }) => <DirectionCell direction={row.original.egress} />,
  },
  yielding(createAgeColumn<NetworkPolicyInfo>(), 1),
];

export const NetworkPolicyList = createResourceListPage<NetworkPolicyInfo>({
  resourceType: ResourceType.NetworkPolicy,
  title: "NetworkPolicies",
  fetcher: ({ scope }) => commands.listNetworkPoliciesIn(scope),
  deleter: (item) =>
    commands.deleteNetworkPolicy(item.name, item.namespace ?? null),
  columns: () => networkPolicyColumns,
});
