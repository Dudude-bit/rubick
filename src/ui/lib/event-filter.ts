/**
 * Narrowing the event feed to the rows a reader is looking for.
 *
 * The feed arrives as one stream and the only knob was Warning/Normal, so
 * finding what one group of pods did meant reading past everything else the
 * cluster said in the same minute. This matches the words the row actually
 * shows — the reason, the object it is about, its namespace and the message
 * — because a filter that matches something invisible looks broken, and one
 * that misses something visible looks broken in the other direction.
 *
 * Case-insensitive substring, the same thing the resource lists' search box
 * does. Not a glob and not a regex: a reader typing `web-` means the letters
 * `web-`, and the day somebody's pod is called `api.v2` a regex would quietly
 * stop meaning what they typed.
 */

import type { EventInfo } from "@/generated/types";

/** The words one row puts on screen, in the order it puts them. */
function haystack(event: EventInfo): string {
  return [
    event.reason,
    event.involvedObject.kind,
    event.involvedObject.name,
    event.involvedObject.namespace ?? event.namespace,
    event.message,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Whether this event is one of the ones being looked for.
 *
 * An empty or blank query matches everything: a filter nobody has typed into
 * is not a filter that hides things.
 */
export function eventMatches(event: EventInfo, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return haystack(event).toLowerCase().includes(needle);
}

/**
 * The feed, narrowed.
 *
 * Applied before the "latest N" cut rather than after it, so the search
 * reaches the whole pool the reader paid for. Filtering the cut instead would
 * search the newest 500 rows and call it the answer — which reads as "there
 * are none" about a cluster that has plenty, just older than the window.
 */
export function filterEvents(events: EventInfo[], query: string): EventInfo[] {
  if (query.trim() === "") return events;
  return events.filter((event) => eventMatches(event, query));
}
