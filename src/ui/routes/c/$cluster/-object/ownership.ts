import { useQuery } from "@tanstack/react-query";

import type { KindReading, NotRead } from "@/generated/types";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { useNamespaceScope } from "@/hooks/useNamespaceScope";
import type { T } from "@/i18n/useT";
import { commands } from "@/lib/commands";
import { objectLink } from "@/lib/links";
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

/**
 * Where an ancestor or a dependent opens. A kind the registry does not hold
 * is addressed by `<plural>.<group>`, as kubectl names it.
 */
export function refLink(ref: {
  kind: string;
  group: string;
  plural: string;
  name: string;
  namespace?: string | null;
}) {
  return objectLink({
    kind: ref.kind,
    name: ref.name,
    namespace: ref.namespace,
    crd: isResourceType(ref.kind)
      ? undefined
      : ref.group
        ? `${ref.plural}.${ref.group}`
        : ref.plural,
  });
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
 * Kinds whose dependents could still be there unseen. A kind that cannot be
 * listed stores no objects, and events are left out because nothing owns
 * them; both are still named wherever every unread kind is listed.
 */
export function mightHold(reading: KindReading): boolean {
  return (
    reading.reading.says !== "unlistable" && reading.reading.says !== "skipped"
  );
}

const READING_KEYS = {
  syncing: "syncing",
  stale: "stale",
  refused: "refused",
  partial: "partial",
  failed: "readFailed",
  unlistable: "unlistable",
  skipped: "skipped",
} as const satisfies Record<KindReading["reading"]["says"], string>;

/** One unread kind in the reader's words: its name, and why. */
export function readingOf(reading: KindReading, t: T): string {
  const why = reading.reading;
  let values: Record<string, string> | undefined;
  if (why.says === "partial")
    values = { namespaces: why.namespaces.join(", ") };
  if (why.says === "stale")
    values = { since: new Date(why.since).toLocaleTimeString() };
  return `${reading.kind} (${t("owns", READING_KEYS[why.says], values)})`;
}

/** Whether nothing could still be hiding: every listable kind read live. */
export function readAll(notRead: NotRead): boolean {
  return notRead.groups.length === 0 && !notRead.kinds.some(mightHold);
}
