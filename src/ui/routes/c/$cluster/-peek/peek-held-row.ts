import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";

import type { Scoped } from "@/generated/types";
import { queryKeys } from "@/lib/query-keys";
import { ResourceType, type ResourceKind } from "@/lib/resource-registry";

/** Kinds whose list answers with the very type `get_*` does, so the row can stand in for the object. */
const ROW_IS_THE_OBJECT: ReadonlySet<ResourceKind> = new Set([
  ResourceType.Deployment,
  ResourceType.Pod,
  ResourceType.Namespace,
  ResourceType.Node,
  ResourceType.Service,
  ResourceType.PersistentVolume,
]);

/** The newest cached list row of this object, with when that list was read; `null` unless `wanted` and the kind's list holds it. */
export function useHeldRow(
  kind: ResourceKind | null | undefined,
  namespace: string | null,
  name: string,
  wanted: boolean
): { row: unknown; at: number } | null {
  const queryClient = useQueryClient();
  return useMemo(() => {
    if (!wanted || !kind || !ROW_IS_THE_OBJECT.has(kind)) return null;
    let held: { row: unknown; at: number } | null = null;
    for (const query of queryClient
      .getQueryCache()
      .findAll({ queryKey: queryKeys.lists(kind) })) {
      const rows = (query.state.data as Scoped<unknown> | undefined)?.rows;
      if (!Array.isArray(rows) || query.state.dataUpdatedAt <= (held?.at ?? 0))
        continue;
      const row = rows.find((candidate) => {
        const item = candidate as { name: string; namespace?: string | null };
        return item.name === name && (item.namespace ?? null) === namespace;
      });
      if (row) held = { row, at: query.state.dataUpdatedAt };
    }
    return held;
  }, [queryClient, wanted, kind, namespace, name]);
}
