import type { ColumnDef } from "@/components/ui/table-features";
import { columnHeader } from "@/i18n/column-header";

import type { DeploymentInfo } from "@/generated/types";
import { commands } from "@/lib/commands";
import { ResourceType } from "@/lib/resource-registry";
import { matchDeploymentPods } from "@/lib/metrics";
import { widestText } from "@/lib/text-width";
import {
  createNameColumn,
  createNamespaceColumn,
  createAgeColumn,
  createCpuColumn,
  createMemoryColumn,
  createReplicasColumn,
  yielding,
} from "../../../-list/columns";
import { createWorkloadListPage } from "../../-components/createWorkloadListPage";
import type { WorkloadRow } from "../../-components/row-cause";
import { createRolloutColumn } from "../../-components/rollout-column";

type DeploymentInfoWithMetrics = WorkloadRow<DeploymentInfo>;

export const columns = (): ColumnDef<DeploymentInfoWithMetrics>[] => [
  createNameColumn<DeploymentInfoWithMetrics>(ResourceType.Deployment),
  createNamespaceColumn<DeploymentInfoWithMetrics>(),
  yielding(createCpuColumn<DeploymentInfoWithMetrics>(), 2),
  yielding(createMemoryColumn<DeploymentInfoWithMetrics>(), 1),
  createReplicasColumn<DeploymentInfoWithMetrics>(),
  {
    // "RollingUpdate" or "Recreate".
    size: 130,
    id: "strategy",
    header: columnHeader("columns", "strategy"),
    meta: {
      yields: 3,
      floor: () => widestText(["RollingUpdate", "Recreate"], "sans", 6.6) + 20,
      share: (row: DeploymentInfoWithMetrics) =>
        row.strategy || "RollingUpdate",
    },
    cell: ({ row }) => (
      <span className="text-fg-mut">
        {row.original.strategy || "RollingUpdate"}
      </span>
    ),
  },
  createRolloutColumn<DeploymentInfoWithMetrics>(),
  yielding(createAgeColumn<DeploymentInfoWithMetrics>(), 4),
];

export const DeploymentList = createWorkloadListPage<DeploymentInfo>({
  resourceType: ResourceType.Deployment,
  title: "Deployments",
  fetchList: ({ scope }) => commands.listDeploymentsIn(scope),
  matchPods: matchDeploymentPods,
  watch: ({ scope }) => commands.subscribeDeploymentWatch(scope),
  rolloutFromPods: true,
  deleter: (item) => commands.deleteDeployment(item.name, item.namespace),
  columns,
});
