import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";
import type { RefreshRate } from "@/lib/refresh";
import { ResourceType } from "@/lib/resource-registry";
import { useLiveQuery } from "@/hooks/useLiveQuery";

/** Enough of one object's events that a short list shown from them has a true total behind it. */
export const OBJECT_EVENTS_READ = 200;

export type ObjectEventsQuery = ReturnType<typeof useObjectEvents>;

/** A Namespace's events are those of every object in it, which is what a reader opening one asks for. */
export const eventsOfEveryObject = (kind: string) =>
  kind === ResourceType.Namespace;

/** One object's events, newest first: the peek, the object's page and Share read the same answer. */
export function useObjectEvents(
  kind: string,
  name: string | null | undefined,
  namespace: string | null | undefined,
  { enabled = true, refresh }: { enabled?: boolean; refresh: RefreshRate }
) {
  const everyObject = eventsOfEveryObject(kind);
  const scope = everyObject ? name : namespace;
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
    refresh,
    retry: false,
  });
}

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
