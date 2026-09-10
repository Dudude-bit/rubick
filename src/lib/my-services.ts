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
  UnexploredKind,
  ServicePublished,
} from "@/generated/types";
import type { ChainPath, ChainHop } from "@/lib/connections";
import type { JournalEntry } from "@/lib/changes";
import { isOpen, type Watch } from "@/lib/tell-me-when";

/**
 * How many one person may pin per cluster.
 *
 * Each card is a neighbourhood read, so this is a budget and not a taste
 * limit. Past it the app refuses and says which to unpin, the way the
 * watch list does, rather than silently dropping the oldest thing somebody
 * chose to keep an eye on.
 */
export const MAX_PINNED_PER_CONTEXT = 12;

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

export function isPinnable(kind: string): kind is PinnableKind {
  return (PINNABLE_KINDS as readonly string[]).includes(kind);
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
  | { state: "short"; ready: number; total: number }
  | { state: "gone" }
  | { state: "unread"; why: string };

export function stateOf(
  connections: ResourceConnections | undefined,
  error: { message: string } | null
): ServiceState {
  if (!connections) {
    if (!error) return { state: "unread", why: "" };
    // "Not found" is the cluster answering, not failing: the object is gone.
    return /\bnot found\b/i.test(error.message)
      ? { state: "gone" }
      : { state: "unread", why: error.message };
  }
  if (connections.subject.existence === "missing") return { state: "gone" };
  const facts = connections.subject.facts;
  if (facts?.kind !== "workload") return { state: "unread", why: "" };
  return facts.readyReplicas >= facts.replicas
    ? { state: "ready", ready: facts.readyReplicas, total: facts.replicas }
    : { state: "short", ready: facts.readyReplicas, total: facts.replicas };
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
  const entries: EntryPoint[] = [];
  for (const chain of chains) {
    for (const hop of chain.hops) {
      const entry = entryOf(hop);
      if (entry && !entries.some((seen) => seen.key === entry.key)) {
        entries.push(entry);
      }
    }
  }
  return { entries, known: true };
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
    };
  }
  if (hop.at === "published") return publishedEntry(hop.published);
  return null;
}

function publishedEntry(published: ServicePublished): EntryPoint {
  return {
    key: `${published.service.namespace ?? ""}/${published.service.name}`,
    url: null,
    label: published.service.name,
    detail: published.ports
      .map((port) => (port.name === null ? `${port.port}` : port.name))
      .join(", "),
    serving: published.ready > 0,
    servingKnown: published.whole,
  };
}

/** Everything the app admits it did not look at for this service. */
export function openQuestionsOf(
  connections: ResourceConnections | undefined
): UnexploredKind[] {
  return connections?.notLookedAt ?? [];
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
        isOpen(watch)
    )
    .sort((a, b) => b.startedAt - a.startedAt);
}
