import { useMemo } from "react";
import {
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";

import type { Scoped } from "@/generated/types";
import { queryKeys } from "@/lib/query-keys";
import { ResourceType, type ResourceKind } from "@/lib/resource-registry";

/** Kinds whose list answers with the very type `get_*` does, so the row can stand in for the object. */
const ROW_IS_THE_OBJECT: ReadonlySet<string> = new Set<ResourceKind>([
  ResourceType.Deployment,
  ResourceType.Pod,
  ResourceType.Namespace,
  ResourceType.Node,
  ResourceType.Service,
  ResourceType.PersistentVolume,
]);

/** Where a kind's own list page keeps its rows, where that is not `queryKeys.lists`: the Pods table reads slim rows. */
const LISTED_UNDER: Readonly<Record<string, QueryKey>> = {
  [ResourceType.Pod]: queryKeys.everyPodRows(),
};

export interface HeldRow {
  row: unknown;
  /** When the list holding it last answered. */
  at: number;
  /** The list it was found in. */
  key: QueryKey;
}

function newestHolding(
  queryClient: QueryClient,
  prefix: QueryKey,
  namespace: string | null,
  name: string
): HeldRow | null {
  let held: HeldRow | null = null;
  for (const query of queryClient
    .getQueryCache()
    .findAll({ queryKey: prefix })) {
    const rows = (query.state.data as Scoped<unknown> | undefined)?.rows;
    if (!Array.isArray(rows) || query.state.dataUpdatedAt <= (held?.at ?? 0))
      continue;
    const row = rows.find((candidate) => {
      const item = candidate as { name: string; namespace?: string | null };
      return item.name === name && (item.namespace ?? null) === namespace;
    });
    if (row) held = { row, at: query.state.dataUpdatedAt, key: query.queryKey };
  }
  return held;
}

/** The newest cached list row of this object; `null` unless `wanted` and the kind's list holds it. */
export function useHeldRow(
  kind: string | null | undefined,
  namespace: string | null,
  name: string | undefined,
  wanted: boolean
): HeldRow | null {
  const queryClient = useQueryClient();
  return useMemo(
    () =>
      wanted && kind && name && ROW_IS_THE_OBJECT.has(kind)
        ? newestHolding(
            queryClient,
            queryKeys.lists(kind as ResourceKind),
            namespace,
            name
          )
        : null,
    [queryClient, wanted, kind, namespace, name]
  );
}

/**
 * The newest list page holding this object, whose watch reads it again at
 * every change (`rowDetail`): what a peek may call live. Looked for where the
 * page keeps it, which for Pods is not where a stand-in row is found.
 */
export function useHoldingList(
  kind: string | null | undefined,
  namespace: string | null,
  name: string | undefined,
  wanted: boolean
): QueryKey | null {
  const queryClient = useQueryClient();
  return useMemo(
    () =>
      wanted && kind && name && ROW_IS_THE_OBJECT.has(kind)
        ? (newestHolding(
            queryClient,
            LISTED_UNDER[kind] ?? queryKeys.lists(kind as ResourceKind),
            namespace,
            name
          )?.key ?? null)
        : null,
    [queryClient, wanted, kind, namespace, name]
  );
}
