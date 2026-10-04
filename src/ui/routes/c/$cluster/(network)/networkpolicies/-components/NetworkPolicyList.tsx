import type { ColumnDef } from "@/components/ui/table-features";

import type { NetworkPolicyInfo } from "@/generated/types";
import { columnHeader } from "@/i18n/column-header";
import { commands } from "@/lib/commands";
import { directionWords, reachWords, selectsWords } from "@/lib/network-policy";
import { ResourceType } from "@/lib/resource-registry";
import {
  DirectionCell,
  ReachCell,
  SelectsCell,
} from "@/components/resources/network-policy-cells";
import {
  createNameColumn,
  createNamespaceColumn,
  createAgeColumn,
} from "@/components/resources/columns";
import { createResourceListPage } from "@/components/resources/createResourceListPage";

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
    },
    cell: ({ row }) => <DirectionCell direction={row.original.egress} />,
  },
  createAgeColumn<NetworkPolicyInfo>(),
];

export const NetworkPolicyList = createResourceListPage<NetworkPolicyInfo>({
  resourceType: ResourceType.NetworkPolicy,
  title: "NetworkPolicies",
  fetcher: ({ scope }) => commands.listNetworkPoliciesIn(scope),
  deleter: (item) =>
    commands.deleteNetworkPolicy(item.name, item.namespace ?? null),
  columns: () => networkPolicyColumns,
});
