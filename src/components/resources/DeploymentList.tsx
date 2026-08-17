import type { ColumnDef } from "@tanstack/react-table";
import { T } from "@/i18n/T";
import { Scale, RotateCw } from "lucide-react";

import type { DeploymentInfo } from "@/generated/types";
import { commands } from "@/lib/commands";
import { ResourceType } from "@/lib/resource-registry";
import { getResourceDetailUrl } from "@/lib/navigation-utils";
import { matchDeploymentPods, type ResourceMetrics } from "@/lib/metrics";
import { StatusBadge } from "@/components/ui/status-badge";
import type { QuickAction } from "@/components/ui/quick-actions";
import {
  createNameColumn,
  createNamespaceColumn,
  createAgeColumn,
  createCpuColumn,
  createMemoryColumn,
  createReplicasColumn,
} from "./columns";
import { createWorkloadListPage } from "./createWorkloadListPage";

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
    header: () => <T section="columns" k="strategy" />,
    cell: ({ row }) => (
      <span className="text-fg-mut">
        {row.original.strategy || "RollingUpdate"}
      </span>
    ),
  },
  {
    size: 120,
    id: "status",
    header: () => <T section="columns" k="status" />,
    cell: ({ row }) => {
      const available = row.original.replicas.available || 0;
      const total = row.original.replicas.desired;
      const status = available === total ? "Available" : "Progressing";
      return <StatusBadge status={status} />;
    },
  },
  createAgeColumn<DeploymentInfoWithMetrics>(),
];

const extraActions = ({
  navigate,
}: {
  navigate: (path: string) => void;
}): QuickAction<DeploymentInfoWithMetrics>[] => [
  {
    icon: Scale,
    label: "Scale",
    onClick: (item) =>
      navigate(
        `${getResourceDetailUrl(ResourceType.Deployment, item.name, item.namespace)}?action=scale`
      ),
  },
  {
    icon: RotateCw,
    label: "Restart",
    onClick: (item) =>
      navigate(
        `${getResourceDetailUrl(ResourceType.Deployment, item.name, item.namespace)}?action=restart`
      ),
  },
];

export const DeploymentList = createWorkloadListPage<DeploymentInfo>({
  resourceType: ResourceType.Deployment,
  title: "Deployments",
  fetchList: ({ namespace }) =>
    commands.listDeployments({
      namespace,
      labelSelector: null,
      fieldSelector: null,
      limit: null,
    }),
  matchPods: matchDeploymentPods,
  watch: ({ namespace }) => commands.subscribeDeploymentWatch(namespace),
  deleter: (item) => commands.deleteDeployment(item.name, item.namespace),
  columns,
  extraActions,
});
