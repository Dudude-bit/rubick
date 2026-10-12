import { useEffect, useMemo } from "react";
import { keepPreviousData, useQueryClient } from "@tanstack/react-query";

import type { ClusterOverview, EventInfo } from "@/generated/types";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { useReadAt } from "@/hooks/useReadUid";
import { commands } from "@/lib/commands";
import { ERROR_CODES, errorCode } from "@/lib/error-utils";
import { namesToAsk, nameKey, type Named } from "@/lib/event-incarnation";
import { mayBeGone, subjectKey, type Story } from "@/lib/event-stories";
import { queryKeys } from "@/lib/query-keys";
import {
  getApiVersion,
  toKind,
  type ResourceKind,
} from "@/lib/resource-registry";
import { useClusterStore } from "@/stores/clusterStore";

interface Asked extends Named {
  key: string;
  kind: ResourceKind;
}

/**
 * Who holds each name the page speaks of now: the uid of the object there,
 * or `null` where the cluster answered that nothing is. One question for
 * every name, asked again at the steady rate while the page is shown, and
 * the one answer every story, row and chip reads. A refused or failed read
 * leaves its name out, which is unknown; a kind the registry cannot name is
 * not asked. A name the Overview's own check calls gone is asked again at once.
 *
 * The answer is one string, so it draws the page only when a holder
 * changes: the stories follow the watch once a second.
 */
export function useNameHolders(
  stories: readonly Story[],
  events: readonly EventInfo[]
): ReadonlyMap<string, string | null> {
  const isConnected = useClusterStore((state) => state.isConnected);
  const client = useQueryClient();
  const named = useMemo(() => {
    const seen = new Map<string, Asked>();
    const ask = (key: string, { kind, namespace, name }: Named) => {
      const known = toKind(kind);
      if (known) seen.set(key, { key, kind: known, namespace, name });
    };
    for (const [key, name] of namesToAsk(events)) ask(key, name);
    for (const story of stories) {
      if (!story.subject.kind || !mayBeGone(story)) continue;
      ask(subjectKey(story.subject), {
        ...story.subject,
        kind: story.subject.kind,
      });
    }
    return [...seen.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
  }, [stories, events]);
  const subjects = named.map((subject) => subject.key).join("\n");
  const queryKey = useMemo(
    () => queryKeys.held(subjects ? subjects.split("\n") : []),
    [subjects]
  );
  const asked = useLiveQuery({
    queryKey,
    queryFn: () => holdersOf(named),
    enabled: isConnected && named.length > 0,
    placeholderData: keepPreviousData,
    select: (held: string[]) => held.join("\n"),
    notifyOnChangeProps: ["data"],
    refresh: "steady",
  });
  const answer = subjects ? asked.data : undefined;

  const overview = useGoneInOverview();
  useEffect(() => {
    if (!isConnected || !subjects) return;
    const told = client.getQueryState(overview.queryKey)?.dataUpdatedAt ?? 0;
    const said = client.getQueryState<string[]>(queryKey);
    const contradicted = [...overview.gone].some(
      (key) =>
        subjects.split("\n").includes(key) && !said?.data?.includes(`${key}\t`)
    );
    if (contradicted && (said?.dataUpdatedAt ?? 0) < told)
      void client.refetchQueries({ queryKey, exact: true });
  }, [overview, subjects, queryKey, client, isConnected]);

  return useMemo(
    () =>
      new Map(
        (answer ? answer.split("\n") : []).map((line) => {
          const [key, uid] = line.split("\t");
          return [key, uid || null];
        })
      ),
    [answer]
  );
}

/** One line per name the cluster answered for: its key, a tab, and the uid there now or nothing. */
async function holdersOf(named: readonly Asked[]): Promise<string[]> {
  const answers = await Promise.all(
    named.map(({ key, kind, name, namespace }) =>
      commands
        .getObjectMetadata(kind, getApiVersion(kind), name, namespace)
        .then(
          ({ uid }) => (uid ? `${key}\t${uid}` : null),
          (error: unknown) =>
            errorCode(error) === ERROR_CODES.NOT_FOUND ? `${key}\t` : null
        )
    )
  );
  return answers.filter((line): line is string => line !== null);
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
        nameKey(group.objectKind, group.namespace, group.objectName ?? "")
      )
      .join("\n")
  );
  return useMemo(
    () => ({ queryKey, gone: new Set(data ? data.split("\n") : []) }),
    [queryKey, data]
  );
}
