import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";
import type { RefreshRate } from "@/lib/refresh";
import { useLiveQuery } from "@/hooks/useLiveQuery";

/** Enough of one object's events that a short list shown from them has a true total behind it. */
export const OBJECT_EVENTS_READ = 200;

/** One object's events, newest first: the peek, the pod page and Share read the same answer. */
export function useObjectEvents(
  kind: string,
  name: string | null | undefined,
  namespace: string | null | undefined,
  { enabled = true, refresh }: { enabled?: boolean; refresh: RefreshRate }
) {
  return useLiveQuery({
    queryKey: [
      ...queryKeys.events(namespace ?? null),
      "object",
      kind,
      name ?? "",
    ],
    queryFn: () =>
      commands.listEvents({
        namespace: namespace || null,
        involved_object_name: name ?? null,
        involved_object_kind: kind,
        event_type: null,
        field_selector: null,
        limit: OBJECT_EVENTS_READ,
      }),
    enabled: enabled && !!name,
    refresh,
    retry: false,
  });
}

/** The newest `shown` of what was read, and the total they are out of where they are not all of it. */
export function latestOf<E>(
  events: E[],
  shown: number
): { rows: E[]; of: string | null } {
  if (events.length <= shown) return { rows: events, of: null };
  return {
    rows: events.slice(0, shown),
    of:
      events.length >= OBJECT_EVENTS_READ
        ? `${OBJECT_EVENTS_READ}+`
        : String(events.length),
  };
}
