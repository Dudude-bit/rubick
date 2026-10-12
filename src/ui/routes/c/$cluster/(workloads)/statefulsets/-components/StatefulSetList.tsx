import type { ColumnDef } from "@/components/ui/table-features";

import type { StatefulSetInfo } from "@/generated/types";
import { commands } from "@/lib/commands";
import { ResourceType } from "@/lib/resource-registry";
import { matchStatefulSetPods, type ResourceMetrics } from "@/lib/metrics";
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
import { createRolloutColumn } from "../../-components/rollout-column";

type StatefulSetInfoWithMetrics = StatefulSetInfo & ResourceMetrics;

export const columns = (): ColumnDef<StatefulSetInfoWithMetrics>[] => [
  createNameColumn<StatefulSetInfoWithMetrics>(ResourceType.StatefulSet),
  createNamespaceColumn<StatefulSetInfoWithMetrics>(),
  yielding(createCpuColumn<StatefulSetInfoWithMetrics>(), 2),
  yielding(createMemoryColumn<StatefulSetInfoWithMetrics>(), 1),
  createReplicasColumn<StatefulSetInfoWithMetrics>(),
  createRolloutColumn<StatefulSetInfoWithMetrics>(),
  yielding(createAgeColumn<StatefulSetInfoWithMetrics>(), 3),
];

export const StatefulSetList = createWorkloadListPage<StatefulSetInfo>({
  resourceType: ResourceType.StatefulSet,
  title: "StatefulSets",
  fetchList: ({ scope }) => commands.listStatefulsetsIn(scope),
  matchPods: matchStatefulSetPods,
  watch: ({ scope }) => commands.subscribeStatefulsetWatch(scope),
  rolloutFromPods: true,
  deleter: (item) => commands.deleteStatefulset(item.name, item.namespace),
  columns,
});
