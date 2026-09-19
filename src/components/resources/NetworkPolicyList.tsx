import type { ColumnDef } from "@/components/ui/table-features";

import type { NetworkPolicyInfo } from "@/generated/types";
import { T } from "@/i18n/T";
import { commands } from "@/lib/commands";
import { ResourceType } from "@/lib/resource-registry";
import { DirectionCell, ReachCell, SelectsCell } from "./network-policy-cells";
import {
  createNameColumn,
  createNamespaceColumn,
  createAgeColumn,
} from "./columns";
import { createResourceListPage } from "./createResourceListPage";

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
    header: () => <T section="columns" k="selects" />,
    cell: ({ row }) => <SelectsCell policy={row.original} />,
  },
  {
    size: 110,
    id: "behind",
    header: () => <T section="columns" k="pods" />,
    cell: ({ row }) => <ReachCell policy={row.original} />,
  },
  {
    size: 130,
    id: "ingress",
    // `policyTypes` writes these two words; they are the cluster's, not ours.
    header: "Ingress",
    cell: ({ row }) => <DirectionCell direction={row.original.ingress} />,
  },
  {
    size: 130,
    id: "egress",
    header: "Egress",
    cell: ({ row }) => <DirectionCell direction={row.original.egress} />,
  },
  createAgeColumn<NetworkPolicyInfo>(),
];

export const NetworkPolicyList = createResourceListPage<NetworkPolicyInfo>({
  resourceType: ResourceType.NetworkPolicy,
  title: "NetworkPolicies",
  fetcher: ({ namespace }) => commands.listNetworkPolicies(namespace),
  deleter: (item) =>
    commands.deleteNetworkPolicy(item.name, item.namespace ?? null),
  columns: () => networkPolicyColumns,
});
