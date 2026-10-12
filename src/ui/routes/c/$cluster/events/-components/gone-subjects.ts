import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import { ERROR_CODES, errorCode } from "@/lib/error-utils";
import { mayBeGone, subjectKey, type Story } from "@/lib/event-stories";
import { queryKeys } from "@/lib/query-keys";
import { STALE_TIMES } from "@/lib/refresh";
import { getApiVersion, toKind } from "@/lib/resource-registry";
import { useClusterStore } from "@/stores/clusterStore";

/**
 * The stories whose warnings stopped because their object was deleted: each
 * one that may be is read once, and only a read the cluster answered with
 * "not found" says gone. A refused or failed read says nothing, and a kind
 * the registry cannot name is not asked.
 */
export function useGoneSubjects(
  stories: readonly Story[]
): ReadonlySet<string> {
  const isConnected = useClusterStore((state) => state.isConnected);
  const asked = useMemo(() => {
    const seen = new Map<
      string,
      { kind: string; name: string; namespace: string | null }
    >();
    for (const story of stories) {
      const kind = story.subject.kind && toKind(story.subject.kind);
      if (!kind || !mayBeGone(story)) continue;
      seen.set(subjectKey(story.subject), {
        kind,
        name: story.subject.name,
        namespace: story.subject.namespace,
      });
    }
    return [...seen];
  }, [stories]);
  const held = useQueries({
    queries: asked.map(([, { kind, name, namespace }]) => ({
      queryKey: queryKeys.held(kind, getApiVersion(kind), namespace, name),
      queryFn: () =>
        commands
          .getObjectMetadata(kind, getApiVersion(kind), name, namespace)
          .then(
            () => true,
            (error: unknown) => {
              if (errorCode(error) === ERROR_CODES.NOT_FOUND) return false;
              throw error;
            }
          ),
      enabled: isConnected,
      retry: false,
      staleTime: STALE_TIMES.resourceDetail,
    })),
  });
  const gone = asked
    .filter((_, index) => held[index]?.data === false)
    .map(([key]) => key)
    .join("\n");
  return useMemo(() => new Set(gone ? gone.split("\n") : []), [gone]);
}
