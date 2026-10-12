import type { EventInfo } from "@/generated/types";

/** The uid of the object an event is about; the kubelet writes a Node's name there, which names no incarnation. */
export function involvedUid(event: EventInfo): string | null {
  const { uid, name } = event.involvedObject;
  return uid && uid !== name ? uid : null;
}

/** The uid the object of this name has now, `undefined` where nothing here has read it. */
export type CurrentUid = (
  kind: string,
  namespace: string | null,
  name: string
) => string | undefined;

const nameOf = (event: EventInfo) =>
  `${event.involvedObject.namespace ?? event.namespace}/${event.involvedObject.kind}/${event.involvedObject.name}`;

const at = (value: string | null) => {
  const ms = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(ms) ? null : ms;
};

/**
 * The uids among `events` that belong to an earlier object of their name:
 * another object has had the name since, either the one read now or a later
 * one the events themselves speak about. Two objects never hold one name at
 * once, so the one whose events begin last is the later of them.
 */
export function earlierObjects(
  events: readonly EventInfo[],
  current?: CurrentUid
): ReadonlySet<string> {
  const byName = new Map<
    string,
    { event: EventInfo; began: Map<string, number | null> }
  >();
  for (const event of events) {
    const uid = involvedUid(event);
    if (!uid) continue;
    const key = nameOf(event);
    const entry = byName.get(key) ?? { event, began: new Map() };
    byName.set(key, entry);
    const began = at(event.firstTimestamp) ?? at(event.lastTimestamp);
    const seen = entry.began.get(uid);
    entry.began.set(
      uid,
      seen === undefined
        ? began
        : seen === null || began === null
          ? null
          : Math.min(seen, began)
    );
  }
  const earlier = new Set<string>();
  for (const { event, began } of byName.values()) {
    const { kind, name, namespace } = event.involvedObject;
    const now = current?.(kind, namespace ?? event.namespace, name);
    if (now !== undefined) {
      for (const uid of began.keys()) if (uid !== now) earlier.add(uid);
      continue;
    }
    if (began.size < 2) continue;
    const dated = [...began].filter(
      (entry): entry is [string, number] => entry[1] !== null
    );
    if (dated.length !== began.size) continue;
    const latest = Math.max(...dated.map(([, ms]) => ms));
    const newest = dated.filter(([, ms]) => ms === latest);
    if (newest.length !== 1) continue;
    for (const [uid] of dated) if (uid !== newest[0][0]) earlier.add(uid);
  }
  return earlier;
}

/** Whether this event is about an earlier object of its name than the one there now. */
export const aboutEarlier = (
  event: EventInfo,
  earlier: ReadonlySet<string>
): boolean => {
  const uid = involvedUid(event);
  return uid !== null && earlier.has(uid);
};
