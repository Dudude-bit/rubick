import type { EventInfo } from "@/generated/types";

/** The uid of the object an event is about; the kubelet writes a Node's name there, which names no incarnation. */
export function involvedUid(event: EventInfo): string | null {
  const { uid, name } = event.involvedObject;
  return uid && uid !== name ? uid : null;
}

/** Why a name an event gives is not the object there now: another took the name, or none has it. */
export type Past = "earlier" | "gone";

/** Who holds a name now: the uid of the object there, `null` for nothing, `undefined` where nothing here has read it. */
export type Holder = (
  kind: string,
  namespace: string | null,
  name: string
) => string | null | undefined;

/** Where an object lives and what it is called, the key whoever holds the name is read by. */
export const nameKey = (
  kind: string | null,
  namespace: string | null,
  name: string
): string => `${namespace ?? ""}/${kind ?? ""}/${name}`;

const nameOf = (event: EventInfo) =>
  nameKey(
    event.involvedObject.kind,
    event.involvedObject.namespace ?? event.namespace,
    event.involvedObject.name
  );

const at = (value: string | null) => {
  const ms = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(ms) ? null : ms;
};

/**
 * What each uid among `events` is, where it is not the object holding its
 * name now: earlier where another object holds the name, gone where nothing
 * does. Where nobody read the name, the events order the objects: two never
 * hold one name at once, so the one whose events begin last is the later,
 * and the others are earlier.
 */
export function pastObjects(
  events: readonly EventInfo[],
  holder?: Holder
): ReadonlyMap<string, Past> {
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
  const past = new Map<string, Past>();
  for (const { event, began } of byName.values()) {
    const { kind, name, namespace } = event.involvedObject;
    const now = holder?.(kind, namespace ?? event.namespace, name);
    if (now === null) {
      for (const uid of began.keys()) past.set(uid, "gone");
      continue;
    }
    if (now !== undefined) {
      for (const uid of began.keys()) if (uid !== now) past.set(uid, "earlier");
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
    for (const [uid] of dated)
      if (uid !== newest[0][0]) past.set(uid, "earlier");
  }
  return past;
}

/** What this event's object is, where it is not the one holding its name now; one with no uid goes by the names nothing holds. */
export const pastOf = (
  event: EventInfo,
  past: ReadonlyMap<string, Past>,
  heldByNobody?: ReadonlySet<string>
): Past | undefined => {
  const uid = involvedUid(event);
  if (uid !== null) return past.get(uid);
  return heldByNobody?.has(nameOf(event)) ? "gone" : undefined;
};

export interface Named {
  kind: string;
  namespace: string | null;
  name: string;
}

/** The names among `events` worth asking who holds: one several objects have had, or one whose own events warn. */
export function namesToAsk(events: readonly EventInfo[]): Map<string, Named> {
  const seen = new Map<
    string,
    { named: Named; uids: Set<string>; warned: boolean }
  >();
  for (const event of events) {
    const { kind, name } = event.involvedObject;
    if (!kind) continue;
    const namespace = event.involvedObject.namespace ?? event.namespace;
    const key = nameKey(kind, namespace, name);
    const entry = seen.get(key) ?? {
      named: { kind, namespace, name },
      uids: new Set<string>(),
      warned: false,
    };
    seen.set(key, entry);
    const uid = involvedUid(event);
    if (uid) entry.uids.add(uid);
    if (event.type === "Warning" && !FOLDED_INTO_OWNERS.has(kind))
      entry.warned = true;
  }
  return new Map(
    [...seen]
      .filter(([, entry]) => entry.warned || entry.uids.size > 1)
      .map(([key, entry]) => [key, entry.named])
  );
}

/** Kinds whose events tell their owner's story, and the owner is asked instead. */
const FOLDED_INTO_OWNERS = new Set(["Pod", "ReplicaSet"]);
