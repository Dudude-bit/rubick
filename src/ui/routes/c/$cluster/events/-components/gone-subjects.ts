import { useEffect, useMemo } from "react";
import { keepPreviousData, useQueryClient } from "@tanstack/react-query";

import type { ClusterOverview } from "@/generated/types";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { useReadAt } from "@/hooks/useReadUid";
import { commands } from "@/lib/commands";
import { ERROR_CODES, errorCode } from "@/lib/error-utils";
import { mayBeGone, subjectKey, type Story } from "@/lib/event-stories";
import { queryKeys } from "@/lib/query-keys";
import { getApiVersion, toKind } from "@/lib/resource-registry";
import { useClusterStore } from "@/stores/clusterStore";

interface Named {
  key: string;
  kind: string;
  apiVersion: string;
  namespace: string | null;
  name: string;
}

/**
 * The stories whose object was deleted, asked as one question, "which of
 * these named objects no longer exist", and asked again at the steady rate
 * while the page is shown. Only a read the cluster answered with "not found"
 * says gone; a refused or failed one says nothing, and a kind the registry
 * cannot name is not asked. An object the Overview's own check calls gone is
 * asked again at once.
 *
 * The answer is one string, so it draws the page only when it changes which
 * stories are gone: the stories follow the watch once a second.
 */
export function useGoneSubjects(
  stories: readonly Story[]
): ReadonlySet<string> {
  const isConnected = useClusterStore((state) => state.isConnected);
  const client = useQueryClient();
  const named = useMemo(() => {
    const seen = new Map<string, Named>();
    for (const story of stories) {
      const kind = story.subject.kind && toKind(story.subject.kind);
      if (!kind || !mayBeGone(story)) continue;
      const key = subjectKey(story.subject);
      seen.set(key, {
        key,
        kind,
        apiVersion: getApiVersion(kind),
        namespace: story.subject.namespace,
        name: story.subject.name,
      });
    }
    return [...seen.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
  }, [stories]);
  const subjects = named.map((subject) => subject.key).join("\n");
  const queryKey = useMemo(
    () => queryKeys.held(subjects ? subjects.split("\n") : []),
    [subjects]
  );
  const asked = useLiveQuery({
    queryKey,
    queryFn: () => goneOf(named),
    enabled: isConnected && named.length > 0,
    placeholderData: keepPreviousData,
    select: (gone: string[]) => gone.join("\n"),
    notifyOnChangeProps: ["data"],
    refresh: "steady",
  });
  const gone = subjects ? asked.data : undefined;

  const overview = useGoneInOverview();
  useEffect(() => {
    if (!isConnected || !subjects) return;
    const told = client.getQueryState(overview.queryKey)?.dataUpdatedAt ?? 0;
    const said = client.getQueryState<string[]>(queryKey);
    const contradicted = [...overview.gone].some(
      (key) => subjects.split("\n").includes(key) && !said?.data?.includes(key)
    );
    if (contradicted && (said?.dataUpdatedAt ?? 0) < told)
      void client.refetchQueries({ queryKey, exact: true });
  }, [overview, subjects, queryKey, client, isConnected]);

  return useMemo(() => new Set(gone ? gone.split("\n") : []), [gone]);
}

async function goneOf(named: readonly Named[]): Promise<string[]> {
  const answers = await Promise.all(
    named.map(({ key, kind, apiVersion, name, namespace }) =>
      commands.getObjectMetadata(kind, apiVersion, name, namespace).then(
        () => null,
        (error: unknown) =>
          errorCode(error) === ERROR_CODES.NOT_FOUND ? key : null
      )
    )
  );
  return answers.filter((key): key is string => key !== null);
}

/** The objects the window's Overview answer last checked and found gone, read from the cache without asking. */
function useGoneInOverview() {
  const context = useClusterStore((state) => state.currentContext);
  const scope = useClusterStore((state) => state.namespaceScope);
  const queryKey = useMemo(
    () => queryKeys.clusterOverview(context, scope),
    [context, scope]
  );
  const data = useReadAt(queryKey, (state) =>
    (state?.data as ClusterOverview | undefined)?.warnings
      .filter((group) => group.incarnation === "gone" && group.objectName)
      .map((group) =>
        subjectKey({
          kind: group.objectKind,
          name: group.objectName ?? "",
          namespace: group.namespace,
          byName: false,
        })
      )
      .join("\n")
  );
  return useMemo(
    () => ({ queryKey, gone: new Set(data ? data.split("\n") : []) }),
    [queryKey, data]
  );
}
