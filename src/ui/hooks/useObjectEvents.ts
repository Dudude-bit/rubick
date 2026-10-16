import { useCallback, useMemo } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import { useReadUid } from "@/hooks/useReadUid";
import type { EventInfo } from "@/generated/types";
import { queryKeys } from "@/lib/query-keys";
import { STALE_TIMES, type RefreshRate } from "@/lib/refresh";
import { ResourceType } from "@/lib/resource-registry";
import { isRefusal } from "@/lib/error-utils";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { involvedUid } from "@/lib/event-incarnation";
import { cronJobRunsKey, readCronJobRuns } from "@/lib/cron-runs";

/** Enough of one object's events that a short list shown from them has a true total behind it. */
export const OBJECT_EVENTS_READ = 200;

export type ObjectEventsQuery = ReturnType<typeof useObjectEvents>;

/** A Namespace's events are those of every object in it, which is what a reader opening one asks for. */
export const eventsOfEveryObject = (kind: string) =>
  kind === ResourceType.Namespace;

/**
 * The events of the object with `uid`, where it is known: an event that names
 * a uid is about that incarnation alone, and one with none is kept by name.
 */
export function ofIncarnation(
  events: EventInfo[] | undefined,
  uid: string | undefined
): EventInfo[] | undefined {
  if (!uid || !events) return events;
  const own = events.filter((event) => {
    const of = involvedUid(event);
    return of === null || of === uid;
  });
  return own.length === events.length ? events : own;
}

/**
 * Where a kind's controller writes the news about it on objects it owns:
 * a Deployment's refused pods are a FailedCreate on its ReplicaSet, and
 * live its own Events said none beside a page explaining the refusal. Each
 * reads its owned objects through the cache entry its page reads them by.
 */
const WARNINGS_OF_OWNED: Partial<
  Record<
    string,
    {
      kind: string;
      owned: (
        client: QueryClient,
        name: string,
        namespace: string
      ) => Promise<{ uid: string; name: string }[]>;
      unread: "replicaSetWarningsUnread" | "jobWarningsUnread";
    }
  >
> = {
  [ResourceType.Deployment]: {
    kind: ResourceType.ReplicaSet,
    owned: (client, name, namespace) =>
      client.fetchQuery({
        queryKey: queryKeys.deploymentReplicaSets(namespace, name),
        queryFn: () => commands.getDeploymentReplicasets(name, namespace),
        staleTime: STALE_TIMES.resourceList,
      }),
    unread: "replicaSetWarningsUnread",
  },
  [ResourceType.CronJob]: {
    kind: ResourceType.Job,
    owned: (client, name, namespace) =>
      client.fetchQuery({
        queryKey: cronJobRunsKey(namespace, name),
        queryFn: () => readCronJobRuns(name, namespace),
        staleTime: STALE_TIMES.resourceList,
      }),
    unread: "jobWarningsUnread",
  },
};

const newestFirst = (a: EventInfo, b: EventInfo) =>
  (Date.parse(b.lastTimestamp ?? "") || 0) -
  (Date.parse(a.lastTimestamp ?? "") || 0);

/**
 * One object's events, newest first: the peek, the object's page and Share
 * read the same answer. Once the object itself has been read, only its own
 * incarnation's: wd-demo deleted and created twice listed fifteen events,
 * eleven of them about the pods before it. A kind whose news is written on
 * what it owns also carries those objects' warnings.
 */
export function useObjectEvents(
  kind: string,
  name: string | null | undefined,
  namespace: string | null | undefined,
  {
    enabled = true,
    refresh,
    uid: known,
  }: {
    enabled?: boolean;
    refresh: RefreshRate;
    /** The object's uid where its reader holds it outside the shared detail entry. */
    uid?: string | null;
  }
) {
  const everyObject = eventsOfEveryObject(kind);
  const scope = everyObject ? name : namespace;
  const read = useReadUid(kind, namespace, name, !everyObject);
  const uid = everyObject ? undefined : (known ?? read);
  const select = useCallback(
    (events: EventInfo[]) => ofIncarnation(events, uid) ?? events,
    [uid]
  );
  const own = useLiveQuery({
    queryKey: [...queryKeys.events(scope ?? null), "object", kind, name ?? ""],
    queryFn: () =>
      commands.listEvents({
        namespace: scope || null,
        involved_object_name: everyObject ? null : (name ?? null),
        involved_object_kind: everyObject ? null : kind,
        event_type: null,
        field_selector: null,
        limit: OBJECT_EVENTS_READ,
      }),
    enabled: enabled && !!name,
    select,
    refresh,
    retry: false,
  });
  const client = useQueryClient();
  const from = everyObject ? undefined : WARNINGS_OF_OWNED[kind];
  const readsOwned = enabled && !!name && !!namespace && !!from;
  const owned = useLiveQuery({
    queryKey: [
      ...queryKeys.events(namespace ?? null),
      "owned",
      kind,
      name ?? "",
    ],
    queryFn: async () => {
      const [sets, warnings] = await Promise.all([
        from!.owned(client, name!, namespace!),
        commands.listEvents({
          namespace: namespace!,
          involved_object_name: null,
          involved_object_kind: from!.kind,
          event_type: "Warning",
          field_selector: null,
          limit: OBJECT_EVENTS_READ,
        }),
      ]);
      const uids = new Set(sets.map((set) => set.uid));
      const names = new Set(sets.map((set) => set.name));
      return warnings.filter((event) => {
        const of = involvedUid(event);
        return of ? uids.has(of) : names.has(event.involvedObject.name);
      });
    },
    enabled: readsOwned,
    refresh,
    retry: false,
  });
  const data = useMemo(() => {
    if (!readsOwned || !own.data) return own.data;
    if (owned.error) return own.data;
    if (!owned.data) return undefined;
    return owned.data.length === 0
      ? own.data
      : [...own.data, ...owned.data]
          .sort(newestFirst)
          .slice(0, OBJECT_EVENTS_READ);
  }, [readsOwned, own.data, owned.data, owned.error]);
  const refetchOwn = own.refetch;
  const refetchOwned = owned.refetch;
  const refetch = useCallback(
    () => Promise.all([refetchOwn(), readsOwned ? refetchOwned() : null]),
    [refetchOwn, refetchOwned, readsOwned]
  );
  const ownedUnread = useMemo(
    () =>
      readsOwned && owned.error && from
        ? { unread: from.unread, error: owned.error }
        : null,
    [readsOwned, owned.error, from]
  );
  return {
    subject: { kind, name: name ?? "", namespace: namespace ?? "" },
    data,
    error: own.error,
    isPending: own.isPending || (readsOwned && owned.isPending),
    dataUpdatedAt: Math.max(own.dataUpdatedAt, owned.dataUpdatedAt),
    refetch,
    /** Where the owned objects' warnings could not be read, so the rows are only the object's own. */
    ownedUnread,
  };
}

/** Whether an event is about another object than the one whose events these are. */
export const aboutAnother = (
  event: EventInfo,
  subject: { kind: string; name: string }
) =>
  event.involvedObject.kind !== subject.kind ||
  event.involvedObject.name !== subject.name;

/** Why an object's events are not on screen: refused here, or a read that failed. */
export const eventsUnreadWords = (
  error: unknown
): "eventsRefusedHere" | "couldNotReadEvents" =>
  isRefusal(error) ? "eventsRefusedHere" : "couldNotReadEvents";

/** How many events were read, marked a floor where the read itself was cut. */
export const eventTotal = (events: unknown[]): string =>
  events.length >= OBJECT_EVENTS_READ
    ? `${OBJECT_EVENTS_READ}+`
    : String(events.length);

/** The newest `shown` of what was read, and the total they are out of where they are not all of it. */
export function latestOf<E>(
  events: E[],
  shown: number
): { rows: E[]; of: string | null } {
  return events.length > shown
    ? { rows: events.slice(0, shown), of: eventTotal(events) }
    : { rows: events, of: null };
}
