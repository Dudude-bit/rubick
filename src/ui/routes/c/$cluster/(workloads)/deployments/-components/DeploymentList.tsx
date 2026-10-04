import { workloadStatus } from "@/lib/workload-status";
import type { ColumnDef } from "@/components/ui/table-features";
import { columnHeader } from "@/i18n/column-header";

import type { DeploymentInfo } from "@/generated/types";
import { commands } from "@/lib/commands";
import { ResourceType } from "@/lib/resource-registry";
import { matchDeploymentPods, type ResourceMetrics } from "@/lib/metrics";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  createNameColumn,
  createNamespaceColumn,
  createAgeColumn,
  createCpuColumn,
  createMemoryColumn,
  createReplicasColumn,
} from "../../../-list/columns";
import { createWorkloadListPage } from "../../-components/createWorkloadListPage";

type DeploymentInfoWithMetrics = DeploymentInfo & ResourceMetrics;

export const columns = (): ColumnDef<DeploymentInfoWithMetrics>[] => [
  createNameColumn<DeploymentInfoWithMetrics>(ResourceType.Deployment),
  createNamespaceColumn<DeploymentInfoWithMetrics>(),
  createCpuColumn<DeploymentInfoWithMetrics>(),
  createMemoryColumn<DeploymentInfoWithMetrics>(),
  createReplicasColumn<DeploymentInfoWithMetrics>(),
  {
    // "RollingUpdate" or "Recreate".
    size: 130,
    id: "strategy",
    header: columnHeader("columns", "strategy"),
    meta: {
      share: (row: DeploymentInfoWithMetrics) =>
        row.strategy || "RollingUpdate",
    },
    cell: ({ row }) => (
      <span className="text-fg-mut">
        {row.original.strategy || "RollingUpdate"}
      </span>
    ),
  },
  {
    size: 120,
    id: "status",
    header: columnHeader("columns", "status"),
    meta: {
      share: (row: DeploymentInfoWithMetrics) => workloadStatus(row.replicas),
    },
    cell: ({ row }) => {
      return <StatusBadge status={workloadStatus(row.original.replicas)} />;
    },
  },
  createAgeColumn<DeploymentInfoWithMetrics>(),
];

export const DeploymentList = createWorkloadListPage<DeploymentInfo>({
  resourceType: ResourceType.Deployment,
  title: "Deployments",
  fetchList: ({ scope }) => commands.listDeploymentsIn(scope),
  matchPods: matchDeploymentPods,
  watch: ({ scope }) => commands.subscribeDeploymentWatch(scope),
  deleter: (item) => commands.deleteDeployment(item.name, item.namespace),
  columns,
});
