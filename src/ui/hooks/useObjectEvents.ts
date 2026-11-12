import { useCallback, useMemo } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import { useReadEventsUid } from "@/hooks/useReadUid";
import type { EventInfo, LatestEvents } from "@/generated/types";
import { queryKeys } from "@/lib/query-keys";
import { STALE_TIMES, type RefreshRate } from "@/lib/refresh";
import {
  getResourceDefinition,
  ResourceType,
  type ResourceKind,
} from "@/lib/resource-registry";
import { builtInKindOf, crdFor, type ObjectRef } from "@/lib/links";
import { servedOf } from "@/lib/served-segment";
import { isRefusal } from "@/lib/error-utils";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { groupIn, involvedUid } from "@/lib/event-incarnation";
import { cronJobRunsKey, readCronJobRuns } from "@/lib/cron-runs";

/** Enough of one object's events that a short list shown from them has a true total behind it. */
export const OBJECT_EVENTS_READ = 200;

export type ObjectEventsQuery = ReturnType<typeof useObjectEvents>;

/**
 * Whose events are read: a kind of the registry, or a custom one by the
 * name it goes by. Knative's Service and Volcano's Job share a built-in's
 * name and nothing else, so no free string is taken for a registry kind.
 * Its group tells its events from a namesake's; `null` where nobody knows it.
 */
export type EventsKind =
  | ResourceKind
  | { custom: string; group: string | null };

/** The kind a reference's events are read as: the registry's only where it is that very kind. */
export function eventsKindOf(ref: ObjectRef): EventsKind {
  const builtIn = builtInKindOf(ref);
  if (builtIn) return builtIn;
  const crd = ref.crd === null ? undefined : crdFor(ref);
  return { custom: ref.kind, group: crd ? servedOf(crd).group : null };
}

/** Whether an event may be about a kind of `group`: it names that group, or none, which could be any kind's. */
function mayBeOf(event: EventInfo, group: string | null) {
  const said = groupIn(event.involvedObject.apiVersion);
  return group === null || said === null || said === group;
}

/**
 * The object's own among events asked for by its kind's name and its own.
 * A uid settles it where the event names one and the object's is known,
 * whatever group the event was written with: a controller may name a legacy
 * one. Only where no uid does, the group tells a namesake kind's events
 * apart; an event that names neither is kept by name.
 */
export function ofObject(
  events: EventInfo[],
  group: string | null,
  uid: string | undefined
): EventInfo[] {
  const own = events.filter((event) => {
    const of = involvedUid(event);
    return uid && of !== null ? of === uid : mayBeOf(event, group);
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
      kind: ResourceKind;
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
  of: EventsKind,
  name: string | null | undefined,
  namespace: string | null | undefined,
  {
    enabled = true,
    refresh,
    uid: known,
  }: {
    enabled?: boolean;
    refresh: RefreshRate;
    /** The uid its events carry (`eventsUidIn`), where its reader holds the object outside the shared detail entry. */
    uid?: string | null;
  }
) {
  const builtIn = typeof of === "string" ? of : null;
  const kind = typeof of === "string" ? of : of.custom;
  // A Namespace's events are those of every object in it, of every group,
  // which is what a reader opening one asks for.
  const everyObject = builtIn === ResourceType.Namespace;
  const group = everyObject
    ? null
    : typeof of === "string"
      ? getResourceDefinition(of).group
      : of.group;
  const scope = everyObject ? name : namespace;
  const read = useReadEventsUid(
    builtIn ?? "",
    namespace,
    name,
    builtIn !== null && !everyObject
  );
  const uid = everyObject ? undefined : (known ?? read);
  const select = useCallback(
    (read: LatestEvents): LatestEvents => ({
      events: ofObject(read.events, group, uid),
      short: read.short,
    }),
    [uid, group]
  );
  const own = useLiveQuery({
    queryKey: [...queryKeys.events(scope ?? null), "object", kind, name ?? ""],
    queryFn: async (): Promise<LatestEvents> => {
      const filters = {
        namespace: scope || null,
        involved_object_name: everyObject ? null : (name ?? null),
        involved_object_kind: everyObject ? null : kind,
        event_type: null,
        field_selector: null,
        limit: OBJECT_EVENTS_READ,
      };
      // Every object's events are the one read long enough to be cut short;
      // one object's are few, and their read says nothing of it.
      return everyObject
        ? commands.listLatestEvents(filters)
        : { events: await commands.listEvents(filters), short: false };
    },
    enabled: enabled && !!name,
    select,
    refresh,
    retry: false,
  });
  const client = useQueryClient();
  const from = builtIn && !everyObject ? WARNINGS_OF_OWNED[builtIn] : undefined;
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
      const group = getResourceDefinition(from!.kind).group;
      return warnings.filter((event) => {
        const of = involvedUid(event);
        return of
          ? uids.has(of)
          : names.has(event.involvedObject.name) && mayBeOf(event, group);
      });
    },
    enabled: readsOwned,
    refresh,
    retry: false,
  });
  const ownEvents = own.data?.events;
  const data = useMemo(() => {
    if (!readsOwned || !ownEvents) return ownEvents;
    if (owned.error) return ownEvents;
    if (!owned.data) return undefined;
    return owned.data.length === 0
      ? ownEvents
      : [...ownEvents, ...owned.data]
          .sort(newestFirst)
          .slice(0, OBJECT_EVENTS_READ);
  }, [readsOwned, ownEvents, owned.data, owned.error]);
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
    /** The rows are every object's in the namespace, not one object's. */
    everyObject,
    /** The read stopped before the collection's end: the rows are the newest of those read, and newer ones may be missing. */
    short: own.data?.short ?? false,
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
