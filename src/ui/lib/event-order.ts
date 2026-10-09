import type { EventInfo } from "@/generated/types";

/**
 * Whether `a` stands above `b` in a feed: newest first, undated last, then by
 * namespace and name so that every event has one place. The timestamps are
 * UTC RFC 3339 from the same backend, so string order is time order.
 */
export function newerEvent(a: EventInfo, b: EventInfo): boolean {
  const mine = a.lastTimestamp ?? "";
  const theirs = b.lastTimestamp ?? "";
  if (mine !== theirs) return mine > theirs;
  if (a.namespace !== b.namespace) return a.namespace < b.namespace;
  return a.name < b.name;
}

export const byNewest = (a: EventInfo, b: EventInfo) =>
  newerEvent(a, b) ? -1 : newerEvent(b, a) ? 1 : 0;
