import { useQuery } from "@tanstack/react-query";

import type { KindReading, NotRead } from "@/generated/types";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { useNamespaceScope } from "@/hooks/useNamespaceScope";
import { commands } from "@/lib/commands";
import { scopeCacheKey } from "@/lib/namespace-scope";
import { queryKeys } from "@/lib/query-keys";
import { isResourceType, listQueryFor, toKind } from "@/lib/resource-registry";
import { useClusterStore } from "@/stores/clusterStore";
import type { ServedResource } from "./served";

/** Where a registry kind is served; `null` for a kind the registry does not hold. */
export function servedOfKind(kind: string): ServedResource | null {
  const known = isResourceType(kind) ? toKind(kind) : null;
  if (!known) return null;
  const { group, resource } = listQueryFor(known);
  return { group, plural: resource };
}

/** The controllers above one object, and its uid. A rollout is what moves it. */
export function useLineage(
  served: ServedResource | null,
  name: string,
  namespace: string | null | undefined
) {
  const isConnected = useClusterStore((state) => state.isConnected);
  return useQuery({
    queryKey: queryKeys.lineage(
      served?.group ?? "",
      served?.plural ?? "",
      namespace,
      name
    ),
    queryFn: () =>
      commands.objectLineage(
        served!.group,
        served!.plural,
        name,
        namespace ?? null
      ),
    enabled: isConnected && !!served && !!name,
    staleTime: 30_000,
    retry: false,
  });
}

/** What `uid` owns. Asking is what keeps the index running. */
export function useDependents(uid: string | null, enabled: boolean) {
  const scope = useNamespaceScope();
  const isConnected = useClusterStore((state) => state.isConnected);
  return useLiveQuery({
    queryKey: queryKeys.dependents(uid ?? "", scopeCacheKey(scope.scope)),
    queryFn: () => commands.listDependents(uid!, scope.wire),
    enabled: enabled && isConnected && !!uid,
    refresh: "resourceDetail",
  });
}

export function useCascade(uid: string | null, enabled: boolean) {
  const scope = useNamespaceScope();
  const isConnected = useClusterStore((state) => state.isConnected);
  return useLiveQuery({
    queryKey: queryKeys.cascade(uid ?? "", scopeCacheKey(scope.scope)),
    queryFn: () => commands.previewCascade(uid!, scope.wire),
    enabled: enabled && isConnected && !!uid,
    refresh: "resourceDetail",
  });
}

/**
 * A namespaced owner's dependents live in its own namespace, so a kind read
 * there is read wherever they could be.
 */
export const readWhereTheyLive = (
  { reading }: KindReading,
  namespace: string | null
): boolean =>
  reading.says === "partial" &&
  namespace !== null &&
  reading.namespaces.includes(namespace);

/**
 * Kinds whose dependents could still be there unseen. A kind that cannot be
 * listed stores no objects, and events are left out because nothing owns
 * them; both are still named wherever every unread kind is listed.
 */
export function mightHold(
  reading: KindReading,
  namespace: string | null = null
): boolean {
  const { says } = reading.reading;
  return (
    says !== "unlistable" &&
    says !== "skipped" &&
    !readWhereTheyLive(reading, namespace)
  );
}

/** The kinds whose delete takes what they hold, which no ownerReference names. */
const HOLDERS = new Set([
  "apiextensions.k8s.io/customresourcedefinitions",
  "/namespaces",
]);

export const holdsContents = (served: ServedResource | null): boolean =>
  !!served && HOLDERS.has(`${served.group}/${served.plural}`);

/** Kinds the index is still listing; none once it has read every one once. */
export const listing = (notRead: NotRead): number =>
  notRead.kinds.filter((reading) => reading.reading.says === "syncing").length;

/** Whether nothing could still be hiding: every listable kind read live. */
export function readAll(
  notRead: NotRead,
  namespace: string | null = null
): boolean {
  return (
    notRead.groups.length === 0 &&
    !notRead.kinds.some((reading) => mightHold(reading, namespace))
  );
}
