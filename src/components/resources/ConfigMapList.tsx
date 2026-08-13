import type { ColumnDef } from "@tanstack/react-table";

import type { ConfigMapInfo } from "@/generated/types";
import { commands } from "@/lib/commands";
import { ResourceType } from "@/lib/resource-registry";
import {
  createNameColumn,
  createNamespaceColumn,
  createAgeColumn,
  createDataKeysColumn,
} from "./columns";
import { createResourceListPage } from "./createResourceListPage";

/**
 * Exported so `column-widths.test.ts` can hold this table to the same rule as
 * the rest: `table-fixed` gives a column that declares no width an equal share
 * of the table, which is a name column's worth of room for an age.
 */
export const configMapColumns = (): ColumnDef<ConfigMapInfo>[] => [
  createNameColumn<ConfigMapInfo>(ResourceType.ConfigMap),
  createNamespaceColumn<ConfigMapInfo>(),
  createDataKeysColumn<ConfigMapInfo>(),
  createAgeColumn<ConfigMapInfo>(),
];

export const ConfigMapList = createResourceListPage<ConfigMapInfo>({
  resourceType: ResourceType.ConfigMap,
  title: "ConfigMaps",
  fetcher: ({ namespace }) =>
    commands.listConfigmaps({
      namespace,
      labelSelector: null,
      fieldSelector: null,
      limit: null,
    }),
  // Real-time updates via the resource-watch subsystem. Initial state
  // still comes from `listConfigmaps` (TanStack Query's first fetch);
  // every change after that is delivered through `resource-event`
  // Tauri events and applied to the cache via `setQueryData`. The
  // factory switches the poll `refresh` rate off automatically when `watch` is
  // set so we don't double-load.
  watch: ({ namespace }) => commands.subscribeConfigmapWatch(namespace),
  deleter: (item) => commands.deleteConfigmap(item.name, item.namespace),
  columns: configMapColumns,
});
