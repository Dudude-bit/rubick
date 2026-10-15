/**
 * The services a person said were theirs, and the five things they want to
 * know without opening anything.
 *
 * Membership is never inferred. Nothing here reads what was viewed recently,
 * what carries a label somebody's platform team agreed on, or what looks
 * important: a service is on this page because a human pressed Pin on it, and
 * it leaves when they press it again. That is the whole rule, and it is what
 * makes the page worth trusting at eight in the morning.
 *
 * Every answer below carries whether it was read. A service whose read was
 * refused is not a service with no entry points.
 */

import type {
  ResourceConnections,
  Rollout,
  UnexploredKind,
  ServicePublished,
} from "@/generated/types";
import {
  policiesElsewhere,
  type ChainPath,
  type ChainHop,
} from "@/lib/connections";
import type { JournalEntry } from "@/lib/changes";
import type { IngressAddress } from "@/lib/ingress-health";
import { ERROR_CODES, errorCode, errorToShow } from "@/lib/error-utils";
import { endpointCount, servingCount } from "@/lib/published";
import { isOpen, type Watch } from "@/lib/tell-me-when";
import type { RefreshRate } from "@/lib/refresh";

/**
 * How many one person may pin per cluster.
 *
 * Each card is a neighbourhood read, so this is a budget and not a taste
 * limit. Past it the app refuses and says which to unpin, the way the
 * watch list does, rather than silently dropping the oldest thing somebody
 * chose to keep an eye on.
 */
export const MAX_PINNED_PER_CONTEXT = 12;

/**
 * How often a card asks for its neighbourhood again.
 *
 * The page's bill is the cap times this rate, and a card's read is not one
 * list but a whole neighbourhood — so at the detail pages' eight seconds a
 * full home page asks the cluster ninety times a minute for a screen
 * somebody glances at over coffee. Nothing a card shows turns over faster
 * than this anyway: a rollout takes minutes and a card carries when the
 * change it names happened.
 */
export const CARD_REFRESH: RefreshRate = "steady";

/** The workload kinds a service can be. */
export const PINNABLE_KINDS = [
  "Deployment",
  "StatefulSet",
  "DaemonSet",
  "CronJob",
] as const;

export type PinnableKind = (typeof PINNABLE_KINDS)[number];

export interface ServicePin {
  context: string;
  kind: string;
  namespace: string;
  name: string;
  pinnedAt: number;
}

export function pinKey(pin: {
  kind: string;
  namespace: string;
  name: string;
}): string {
  return `${pin.kind}/${pin.namespace}/${pin.name}`;
}

/**
 * What is pinned in one cluster, oldest choice first.
 *
 * Here rather than on the store because a Zustand selector that derives a
 * new array is a new snapshot every render; the screens memoise this one.
 * It was written twice — the home page and the Pin button each did their
 * own filtering — which is how the two disagree the day one is fixed.
 */
export function pinsOf(pins: readonly ServicePin[], context: string | null) {
  return context === null
    ? []
    : pins
        .filter((pin) => pin.context === context)
        .sort((a, b) => a.pinnedAt - b.pinnedAt);
}

/** Whether this cluster's list already holds that object. */
export function isPinned(
  pins: readonly ServicePin[],
  context: string | null,
  key: string | null
): boolean {
  return (
    key !== null &&
    context !== null &&
    pins.some((pin) => pin.context === context && pinKey(pin) === key)
  );
}

/**
 * What the workload is doing, or why the app cannot say.
 *
 * `gone` and `unread` are the two states a count of zero would swallow: a
 * service somebody pinned and someone else deleted is not a service with no
 * replicas, and neither is one this token may not read.
 */
export type ServiceState =
  | { state: "ready"; ready: number; total: number }
  | {
      state: "short";
      ready: number;
      total: number;
      /** The rollout's verdict, where the workload is a kind that rolls out. */
      rollout: Rollout | null;
    }
  | { state: "gone" }
  /** Still being read. Not an answer, and not a refusal either. */
  | { state: "reading" }
  | { state: "unread"; why: string };

export function stateOf(
  connections: ResourceConnections | undefined,
  /** The query's error as thrown, so its code comes with it. */
  error: unknown,
  /** The pinned object, for telling its own 404 from the app's other ones. */
  pin?: { kind: string; name: string },
  /** Whether the read is still in flight. */
  pending = false
): ServiceState {
  // The error first, and not only when there is nothing in hand: the read is
  // kept across refreshes, so a workload deleted or refused after the first
  // answer left the last good one on screen — green — with the failure
  // sitting beside it unread.
  if (error) {
    const said = errorToShow(error);
    // The code says the cluster answered "not there"; `Kind/name` says it
    // was about this object and not a namesake a chain walked into.
    // Escaped, because a name is data: `payments.v1` matched `paymentsXv1`.
    // Bounded by name characters, not `\b`: `-` and `.` are inside a name,
    // so `payments` matched `payments-worker`. A dot is only the sentence's
    // when no name character follows it.
    const quoted = (text: string) =>
      text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const gone =
      errorCode(error) === ERROR_CODES.NOT_FOUND &&
      (!pin ||
        new RegExp(
          `(?<![\\w./-])${quoted(pin.kind)}/${quoted(pin.name)}(?![\\w-]|\\.[\\w-])`
        ).test(said));
    return gone ? { state: "gone" } : { state: "unread", why: said };
  }
  // A read that has not answered yet is not a read that failed: the card
  // said "could not read" for the first second of every visit.
  if (!connections)
    return pending ? { state: "reading" } : { state: "unread", why: "" };
  if (connections.subject.existence === "missing") return { state: "gone" };
  const facts = connections.subject.facts;
  if (facts?.kind !== "workload") return { state: "unread", why: "" };
  // A CronJob has no replicas to be ready: the backend reports 0 of 0, which
  // read as "all ready" and drew green about a schedule nobody has checked.
  if (pin?.kind === "CronJob" || connections.subject.kind === "CronJob")
    return { state: "unread", why: "" };
  // The rollout's verdict where there is one: a Deployment past its progress
  // deadline counts every old replica ready and is still not fine.
  const settled = facts.rollout
    ? facts.rollout.state === "ready" || facts.rollout.state === "idle"
    : facts.readyReplicas >= facts.replicas;
  return settled
    ? { state: "ready", ready: facts.readyReplicas, total: facts.replicas }
    : {
        state: "short",
        ready: facts.readyReplicas,
        total: facts.replicas,
        rollout: facts.rollout,
      };
}

/** One way in, as a person would paste it or name it. */
export interface EntryPoint {
  key: string;
  /** Pasteable, where the chain knew a host and a scheme. */
  url: string | null;
  /** The Service or the hostname, whichever this entry is. */
  label: string;
  /** Ports, or what the far end calls itself. */
  detail: string | null;
  /** Whether anything is behind it right now, and whether that was read. */
  serving: boolean;
  servingKnown: boolean;
  /** Ready pods are behind it and a NetworkPolicy admits nobody to them. */
  shut: boolean;
  /** Its chain reaches a door nobody could settle, rather than one unread. */
  unsure: boolean;
  /** Whether the Ingress handing out this URL has an address to reach it on. */
  address: IngressAddress | null;
}

export type WayState =
  | "noController"
  | "noAddress"
  | "unread"
  | "unsure"
  | "shut"
  | "empty";

/** What a way in says beside its name, the break nearest the client first; null where something serves it. */
export function wayState(way: EntryPoint): WayState | null {
  if (way.address === "noController") return "noController";
  if (way.address === "pending") return "noAddress";
  if (!way.servingKnown) return way.unsure ? "unsure" : "unread";
  if (way.shut) return "shut";
  return way.serving ? null : "empty";
}

/** Every way in read and none serving; null where one serves or one was not read. */
export function noWayServes(ways: {
  entries: EntryPoint[];
  known: boolean;
}): "shut" | "empty" | null {
  if (!ways.known || ways.entries.length === 0) return null;
  const states = ways.entries.map(wayState);
  if (
    !states.every(
      (state) =>
        state === "shut" || state === "empty" || state === "noController"
    )
  )
    return null;
  return states.every((state) => state === "shut") ? "shut" : "empty";
}

/**
 * The ways in, read off the same chain the detail page draws.
 *
 * `known` is false when the neighbourhood was never read: no entry points and
 * an unread neighbourhood are the same empty list, and only one of them means
 * "nothing publishes this".
 */
export function entryPointsOf(
  connections: ResourceConnections | undefined,
  chains: ChainPath[]
): {
  entries: EntryPoint[];
  known: boolean;
} {
  if (!connections) return { entries: [], known: false };
  // A Services or Ingresses list the cluster refused is named here, and
  // without it "nothing publishes this" is stated over a list nobody read.
  const unread = connections.notLookedAt.some(
    (kind) => kind.kind === "Service" || kind.kind === "Ingress"
  );
  const byKey = new Map<string, EntryPoint>();
  for (const chain of chains) {
    for (const hop of chain.hops) {
      const found = entryOf(hop);
      if (!found) continue;
      const entry =
        found.url === null
          ? found
          : { ...found, ...chainEnd(chain, found.url) };
      const seen = byKey.get(entry.key);
      // The object hop and the published hop are the same Service under the
      // same key, and only the published one knows whether anything is
      // behind it. First-one-wins dropped that answer every time, so
      // "nothing behind it" could never be drawn.
      if (!seen || (!seen.servingKnown && entry.servingKnown)) {
        byKey.set(entry.key, seen ? { ...seen, ...entry } : entry);
      }
    }
  }
  return { entries: [...byKey.values()], known: !unread };
}

/**
 * Whether a request on an address reaches anything: what the far end of its
 * chain says, a stop on its way before the pods first, and nothing known
 * without either.
 */
function chainEnd(
  chain: ChainPath,
  url: string
): Pick<EntryPoint, "serving" | "servingKnown" | "shut" | "unsure"> {
  const unknown = { serving: false, servingKnown: false, shut: false };
  const stops = chain.hops.flatMap((hop) =>
    hop.at === "stop" && (!hop.only || hop.only.includes(url)) ? [hop] : []
  );
  if (stops.some((hop) => hop.mood === "unchecked"))
    return { ...unknown, unsure: true };
  if (stops.length > 0)
    return {
      serving: false,
      servingKnown: true,
      shut: stops.some((hop) => hop.shut === true),
      unsure: false,
    };
  const published = chain.hops.find((hop) => hop.at === "published");
  if (published?.at !== "published") return { ...unknown, unsure: false };
  const { serving, servingKnown, shut } = publishedEntry(published.published);
  return { serving, servingKnown, shut, unsure: false };
}

function entryOf(hop: ChainHop): EntryPoint | null {
  if (hop.at === "object") {
    if (hop.urls.length > 0) {
      return {
        key: hop.urls[0],
        url: hop.urls[0],
        label: hop.urls[0],
        detail: hop.detail,
        serving: true,
        // An address is an address: whether anything answers on it is the
        // published hop's answer, not this one's.
        servingKnown: false,
        shut: false,
        unsure: false,
        address: hop.address?.state ?? null,
      };
    }
    if (hop.object.kind !== "Service") return null;
    return {
      key: `${hop.object.namespace ?? ""}/${hop.object.name}`,
      url: null,
      label: hop.object.name,
      detail: hop.detail,
      serving: false,
      servingKnown: false,
      shut: false,
      unsure: false,
      address: null,
    };
  }
  if (hop.at === "published") return publishedEntry(hop.published);
  return null;
}

function publishedEntry(published: ServicePublished): EntryPoint {
  const shut = published.stop?.reason === "policyRefuses";
  return {
    key: `${published.service.namespace ?? ""}/${published.service.name}`,
    url: null,
    label: published.service.name,
    detail: published.ports
      .map((port) => (port.name === null ? `${port.port}` : port.name))
      .join(", "),
    serving: !shut && servingCount(published) > 0,
    // `whole` is about the one address a summary keeps, not the counts. The
    // one answer that is nobody's read is a deduction from pods that matched
    // nothing — possibly because nobody could list them.
    servingKnown:
      published.source !== "podReadiness" || endpointCount(published) > 0,
    shut,
    unsure: false,
    address: null,
  };
}

/** Everything the app admits it did not look at for this service. */
export function openQuestionsOf(
  connections: ResourceConnections | undefined
): UnexploredKind[] {
  return (connections?.notLookedAt ?? []).filter(
    (entry) => !policiesElsewhere(entry)
  );
}

/** This service's entries, newest first. */
export function changesFor(
  entries: JournalEntry[],
  pin: { context: string; kind: string; namespace: string; name: string }
): JournalEntry[] {
  return entries
    .filter(
      (entry) =>
        entry.context === pin.context &&
        entry.kind === pin.kind &&
        entry.namespace === pin.namespace &&
        entry.name === pin.name
    )
    .sort((a, b) => b.at - a.at);
}

/** The questions still open on this service, newest first. */
export function waitingFor(
  watches: Watch[],
  pin: { context: string; kind: string; namespace: string; name: string }
): Watch[] {
  return watches
    .filter(
      (watch) =>
        watch.context === pin.context &&
        watch.namespace === pin.namespace &&
        watch.name === pin.name &&
        // The kind too: a Deployment and a Job of the same name in the same
        // namespace are two objects, and the card showed one's wait on the
        // other's row. Its two neighbours already match on all three.
        watch.kind === pin.kind &&
        isOpen(watch)
    )
    .sort((a, b) => b.startedAt - a.startedAt);
}
