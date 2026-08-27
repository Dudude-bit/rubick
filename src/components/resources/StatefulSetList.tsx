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
} from "./columns";
import { createWorkloadListPage } from "./createWorkloadListPage";

type StatefulSetInfoWithMetrics = StatefulSetInfo & ResourceMetrics;

export const columns = (): ColumnDef<StatefulSetInfoWithMetrics>[] => [
  createNameColumn<StatefulSetInfoWithMetrics>(ResourceType.StatefulSet),
  createNamespaceColumn<StatefulSetInfoWithMetrics>(),
  createCpuColumn<StatefulSetInfoWithMetrics>(),
  createMemoryColumn<StatefulSetInfoWithMetrics>(),
  createReplicasColumn<StatefulSetInfoWithMetrics>(),
  createAgeColumn<StatefulSetInfoWithMetrics>(),
];

export const StatefulSetList = createWorkloadListPage<StatefulSetInfo>({
  resourceType: ResourceType.StatefulSet,
  title: "StatefulSets",
  fetchList: ({ namespace }) =>
    commands.listStatefulsets({
      namespace,
      labelSelector: null,
      fieldSelector: null,
      limit: null,
    }),
  matchPods: matchStatefulSetPods,
  watch: ({ namespace }) => commands.subscribeStatefulsetWatch(namespace),
  deleter: (item) => commands.deleteStatefulset(item.name, item.namespace),
  columns,
});
