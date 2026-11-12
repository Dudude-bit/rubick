import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import type { KindReading, NotRead, Reading } from "@/generated/types";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { useNamespaceScope } from "@/hooks/useNamespaceScope";
import { useReadUidAt } from "@/hooks/useReadUid";
import { commands } from "@/lib/commands";
import { scopeCacheKey } from "@/lib/namespace-scope";
import { queryKeys } from "@/lib/query-keys";
import {
  isResourceType,
  listQueryFor,
  RESOURCE_REGISTRY,
  toKind,
} from "@/lib/resource-registry";
import { useClusterStore } from "@/stores/clusterStore";
import type { ServedResource } from "./served";

/** Where a registry kind is served; `null` for a kind the registry does not hold. */
export function servedOfKind(kind: string): ServedResource | null {
  const known = isResourceType(kind) ? toKind(kind) : null;
  if (!known) return null;
  const { group, resource } = listQueryFor(known);
  return { group, plural: resource };
}

/** The registry kind served at a group and plural, which its page's read is kept under. */
const KIND_AT = new Map(
  RESOURCE_REGISTRY.map(({ kind }) => {
    const { group, resource } = listQueryFor(kind);
    return [`${group}/${resource}`, kind];
  })
);

/**
 * The controllers above one object, and its uid. A rollout is what moves it,
 * and so does the object being made again under its name: the answer is
 * about the uid it was read for, so one the page's own read no longer agrees
 * with is asked again and not given out meanwhile. `fresh` asks again on
 * every mount, for a reader with no page behind it.
 */
export function useLineage(
  served: ServedResource | null,
  name: string,
  namespace: string | null | undefined,
  fresh = false
) {
  const isConnected = useClusterStore((state) => state.isConnected);
  const client = useQueryClient();
  const group = served?.group ?? "";
  const plural = served?.plural ?? "";
  const queryKey = useMemo(
    () => queryKeys.lineage(group, plural, namespace, name),
    [group, plural, namespace, name]
  );
  const query = useQuery({
    queryKey,
    queryFn: () =>
      commands.objectLineage(
        served!.group,
        served!.plural,
        name,
        namespace ?? null
      ),
    enabled: isConnected && !!served && !!name,
    staleTime: 30_000,
    refetchOnMount: fresh ? "always" : true,
    retry: false,
  });
  const typed = useReadUidAt(
    queryKeys.detail(KIND_AT.get(`${group}/${plural}`) ?? "", namespace, name)
  );
  const generic = useReadUidAt(
    queryKeys.servedObject(group, plural, namespace, name)
  );
  // A custom resource's own page keeps its read under the CRD's name.
  const custom = useReadUidAt(
    queryKeys.customResource(
      group ? `${plural}.${group}` : plural,
      namespace,
      name
    )
  );
  const read = typed ?? generic ?? custom;
  const uid = query.data?.uid;
  const replaced = !!read && !!uid && read !== uid;
  useEffect(() => {
    if (replaced) void client.invalidateQueries({ queryKey });
  }, [replaced, client, queryKey]);
  const held = replaced || (fresh && query.isFetching);
  return { data: held ? undefined : query.data, error: query.error };
}

/** One page of what `uid` owns. Asking is what keeps the index running. */
export function useDependents(uid: string | null, enabled: boolean, page = 0) {
  const scope = useNamespaceScope();
  const isConnected = useClusterStore((state) => state.isConnected);
  return useLiveQuery({
    queryKey: queryKeys.dependents(uid ?? "", scopeCacheKey(scope.scope), page),
    queryFn: () => commands.listDependents(uid!, scope.wire, page),
    enabled: enabled && isConnected && !!uid,
    refresh: "resourceDetail",
    // The page before stays up while the next one is read, the same owner's only.
    placeholderData: (previous, query) =>
      query?.queryKey[1] === uid ? previous : undefined,
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

/** Which readings mean the index never watches the kind. A new one fails the compiler. */
const LEFT_OUT: Record<Reading["says"], boolean> = {
  syncing: false,
  queued: false,
  stale: false,
  refused: false,
  partial: false,
  failed: false,
  unlistable: true,
  unwatchable: true,
  skipped: true,
};

/** A kind the index leaves out: no list, no watch, or Events. */
export const leftOut = ({ reading }: KindReading): boolean =>
  LEFT_OUT[reading.says];

/**
 * Kinds whose dependents could still be there unseen. The garbage collector
 * tracks only kinds it can list and watch, and events are left out because
 * nothing owns them; both are still named wherever every unread kind is
 * listed.
 */
export function mightHold(
  reading: KindReading,
  namespace: string | null = null
): boolean {
  return !leftOut(reading) && !readWhereTheyLive(reading, namespace);
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
