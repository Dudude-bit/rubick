import { useCallback } from "react";

import { commands } from "@/lib/commands";
import { useReadUid } from "@/hooks/useReadUid";
import type { EventInfo } from "@/generated/types";
import { queryKeys } from "@/lib/query-keys";
import type { RefreshRate } from "@/lib/refresh";
import { ResourceType } from "@/lib/resource-registry";
import { isRefusal } from "@/lib/error-utils";
import { useLiveQuery } from "@/hooks/useLiveQuery";

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
  const own = events.filter(
    (event) => !event.involvedObject.uid || event.involvedObject.uid === uid
  );
  return own.length === events.length ? events : own;
}

/**
 * One object's events, newest first: the peek, the object's page and Share
 * read the same answer. Once the object itself has been read, only its own
 * incarnation's: wd-demo deleted and created twice listed fifteen events,
 * eleven of them about the pods before it.
 */
export function useObjectEvents(
  kind: string,
  name: string | null | undefined,
  namespace: string | null | undefined,
  { enabled = true, refresh }: { enabled?: boolean; refresh: RefreshRate }
) {
  const everyObject = eventsOfEveryObject(kind);
  const scope = everyObject ? name : namespace;
  const uid = useReadUid(kind, namespace, name, !everyObject);
  const select = useCallback(
    (events: EventInfo[]) => ofIncarnation(events, uid) ?? events,
    [uid]
  );
  return useLiveQuery({
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
}

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
