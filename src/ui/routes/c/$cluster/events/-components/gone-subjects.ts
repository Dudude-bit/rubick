import { useEffect, useMemo, useState } from "react";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";

import type { ClusterOverview } from "@/generated/types";
import { commands } from "@/lib/commands";
import { ERROR_CODES, errorCode } from "@/lib/error-utils";
import { mayBeGone, subjectKey, type Story } from "@/lib/event-stories";
import { queryKeys } from "@/lib/query-keys";
import { getApiVersion, toKind } from "@/lib/resource-registry";
import { useClusterStore } from "@/stores/clusterStore";

/** How long an answer about an object's existence is taken as still true. */
export const HELD_FOR_MS = 30_000;

interface Ask {
  queryKey: (string | null)[];
  read: () => Promise<unknown>;
}

/**
 * The stories whose object was deleted. Each one that may be is read, burning
 * or settled, and read again as the page's clock moves on; only a read the
 * cluster answered with "not found" says gone. A refused or failed read says
 * nothing, and a kind the registry cannot name is not asked. An object the
 * Overview's own check calls gone is read again at once.
 *
 * Read imperatively and kept as one string, so an answer that changes no
 * story draws nothing: the stories follow the watch once a second, and a
 * query per story redrew the page on every one of their answers.
 */
export function useGoneSubjects(
  stories: readonly Story[],
  now: number
): ReadonlySet<string> {
  const isConnected = useClusterStore((state) => state.isConnected);
  const client = useQueryClient();
  const asked = useMemo(() => {
    const seen = new Map<string, Ask>();
    for (const story of stories) {
      const kind = story.subject.kind && toKind(story.subject.kind);
      if (!kind || !mayBeGone(story)) continue;
      const { name, namespace } = story.subject;
      const apiVersion = getApiVersion(kind);
      seen.set(subjectKey(story.subject), {
        queryKey: queryKeys.held(kind, apiVersion, namespace, name),
        read: () =>
          commands.getObjectMetadata(kind, apiVersion, name, namespace),
      });
    }
    return [...seen];
  }, [stories]);
  const overview = useGoneInOverview();
  const [gone, setGone] = useState("");
  useEffect(() => {
    if (!isConnected) return;
    let live = true;
    const toldAt = client.getQueryState(overview.queryKey)?.dataUpdatedAt ?? 0;
    void Promise.all(
      asked.map(async ([key, { queryKey, read }]) => {
        const seen = client.getQueryState<boolean>(queryKey);
        const contradicted =
          overview.gone.has(key) &&
          seen?.data === true &&
          seen.dataUpdatedAt < toldAt;
        const held = await client
          .fetchQuery({
            queryKey,
            queryFn: () =>
              read().then(
                () => true,
                (error: unknown) => {
                  if (errorCode(error) === ERROR_CODES.NOT_FOUND) return false;
                  throw error;
                }
              ),
            staleTime: contradicted ? 0 : HELD_FOR_MS,
            retry: false,
          })
          .catch(() => null);
        return held === false ? [key] : [];
      })
    ).then((found) => {
      if (live) setGone(found.flat().sort().join("\n"));
    });
    return () => {
      live = false;
    };
  }, [asked, overview, now, client, isConnected]);
  return useMemo(() => new Set(gone ? gone.split("\n") : []), [gone]);
}

/** The objects the window's Overview answer last checked and found gone, read from the cache without asking. */
function useGoneInOverview() {
  const context = useClusterStore((state) => state.currentContext);
  const scope = useClusterStore((state) => state.namespaceScope);
  const queryKey = useMemo(
    () => queryKeys.clusterOverview(context, scope),
    [context, scope]
  );
  const { data } = useQuery({
    queryKey,
    queryFn: skipToken,
    select: (overview: ClusterOverview) =>
      overview.warnings
        .filter((group) => group.incarnation === "gone" && group.objectName)
        .map((group) =>
          subjectKey({
            kind: group.objectKind,
            name: group.objectName ?? "",
            namespace: group.namespace,
            byName: false,
          })
        )
        .join("\n"),
  });
  return useMemo(
    () => ({ queryKey, gone: new Set(data ? data.split("\n") : []) }),
    [queryKey, data]
  );
}
