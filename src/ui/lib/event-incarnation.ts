import type { EventInfo } from "@/generated/types";
import { builtInGroupOf, crdInGroup, type ObjectRef } from "./links";

/** The uid of the object an event is about; the kubelet writes a Node's name there, which names no incarnation. */
export function involvedUid(event: EventInfo): string | null {
  const { uid, name } = event.involvedObject;
  return uid && uid !== name ? uid : null;
}

/** The API group of an `apiVersion`, "" for the core `v1`; `null` where there is none to read. */
export function groupIn(apiVersion: string | null | undefined): string | null {
  if (!apiVersion) return null;
  const slash = apiVersion.indexOf("/");
  return slash === -1 ? "" : apiVersion.slice(0, slash);
}

/**
 * The group of the kind an object is named by. Where no `apiVersion` is
 * given, as the kubelet gives none for its Node, it is the built-in of that
 * name: the page its link opens and the story its events fold into. `null`
 * where no built-in has the name, which is no kind anyone can read.
 */
export const groupNamed = (
  kind: string | null | undefined,
  apiVersion: string | null | undefined
): string | null => groupIn(apiVersion) ?? (kind ? builtInGroupOf(kind) : null);

/** Why a name an event gives is not the object there now: another took the name, or none has it. */
export type Past = "earlier" | "gone";

/**
 * An object as an event names it. A kind is its group and its name: a custom
 * kind may share a built-in's, and the two are different objects of one name.
 */
export interface Named {
  kind: string;
  /** As {@link groupNamed} reads it: `null` only where no group is named and no built-in has the kind's name. */
  group: string | null;
  namespace: string | null;
  name: string;
}

/** Who holds a name now: the uid of the object there, `null` for nothing, `undefined` where nothing here has read it. */
export type Holder = (named: Named) => string | null | undefined;

/** Where an object lives, its kind and what it is called, the key whoever holds the name is read by. */
export const nameKey = (
  named: Omit<Named, "kind"> & { kind: string | null }
): string =>
  `${named.namespace ?? ""}/${named.kind ?? ""}${
    named.group === null ? "?" : named.group && `.${named.group}`
  }/${named.name}`;

/** The object an event is about. */
export const namedOf = (event: EventInfo): Named => ({
  kind: event.involvedObject.kind,
  group: groupNamed(event.involvedObject.kind, event.involvedObject.apiVersion),
  namespace: event.involvedObject.namespace ?? event.namespace,
  name: event.involvedObject.name,
});

const nameOf = (event: EventInfo) => nameKey(namedOf(event));

/**
 * How the object an event names is addressed: by the CRD of its group, so a
 * namesake of a built-in opens itself or nothing; by its kind's name alone
 * where the event names no group.
 */
export const refOfNamed = (
  named: Named,
  crdOf: (group: string, kind: string) => string | null
): ObjectRef => ({
  kind: named.kind,
  name: named.name,
  namespace: named.namespace,
  crd: named.group === null ? undefined : crdInGroup(named, crdOf),
});

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
    const now = holder?.(namedOf(event));
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

/** The names among `events` worth asking who holds: one several objects have had, or one whose own events warn. */
export function namesToAsk(events: readonly EventInfo[]): Map<string, Named> {
  const seen = new Map<
    string,
    { named: Named; uids: Set<string>; warned: boolean }
  >();
  for (const event of events) {
    const named = namedOf(event);
    if (!named.kind) continue;
    const key = nameKey(named);
    const entry = seen.get(key) ?? {
      named,
      uids: new Set<string>(),
      warned: false,
    };
    seen.set(key, entry);
    const uid = involvedUid(event);
    if (uid) entry.uids.add(uid);
    if (event.type === "Warning" && !FOLDED_INTO_OWNERS.has(named.kind))
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
