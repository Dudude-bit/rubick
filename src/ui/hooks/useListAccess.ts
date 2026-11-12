/**
 * Which kinds this user may list, asked before they walk into the refusal.
 *
 * The nav is the one place that offers every kind at once, so it is the one
 * place a reader meets a wall they had no way to see coming: they click
 * Nodes, and a paragraph of Kubernetes tells them what they are not. Marking
 * the row costs one question to the cluster's own authorizer.
 *
 * A mark, never a lock. The answer here decides how a row is *drawn*; the
 * list call still decides what happens when it is clicked, and if the two
 * disagree the call wins and the mark goes away on the next answer. That
 * ordering is what keeps a wrong review cheap — the alternative, a disabled
 * row, shuts somebody out of a screen they could have used.
 */

import { useQuery } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import {
  askedKind,
  heldWhileAskedAgain,
  queryKeys,
  type ListQuestion,
} from "@/lib/query-keys";
import { useRightsAsked } from "@/lib/refusals";
import { seedScope } from "@/lib/namespace-scope";
import { useClusterStore } from "@/stores/clusterStore";
import { useNamespaceRecencyStore } from "@/stores/namespaceRecencyStore";
import { listQueryFor, type ResourceKind } from "@/lib/resource-registry";
import type { ListQuery } from "@/generated/types";

/** What the authorizer said, for the rows that carry a kind. */
export type ListAccessMap = Partial<Record<ResourceKind, boolean>>;

/**
 * A review is worth re-asking when the reader's rights could have changed,
 * which is rarely — and never inside the seconds a nav row is on screen.
 * Five minutes keeps a role granted mid-session from staying invisible for
 * the rest of it without asking nineteen questions on every render.
 */
const REVIEW_FRESH_MS = 5 * 60 * 1000;

export function useListAccess(kinds: ResourceKind[]): ListAccessMap {
  const allowed = useResourceAccess(kinds.map(listQueryFor));
  const marks: ListAccessMap = {};
  for (const kind of kinds) {
    const mark = allowed.get(listQueryFor(kind));
    if (mark !== undefined) marks[kind] = mark;
  }
  return marks;
}

/**
 * Answers held per kind, and read back only with the question itself: a
 * plural is not a kind, and looked up by it a namesake took another's answer.
 */
export interface PerKind<V> {
  get(asked: ListQuestion): V | undefined;
}

function perKind<V>(entries: Iterable<readonly [ListQuestion, V]>): PerKind<V> {
  const held = new Map<string, V>();
  for (const [asked, value] of entries) held.set(askedKind(asked), value);
  return { get: (asked) => held.get(askedKind(asked)) };
}

const NO_ANSWERS = perKind<never>([]);

/**
 * Asks the authorizer. An answer names only its plural, so each is matched
 * to its question by position, and one that does not line up is no answer.
 */
export async function askListAccess(
  queries: readonly ListQuery[],
  namespaces: string[]
): Promise<PerKind<boolean | null>> {
  const answers = await commands.checkListAccess([...queries], namespaces);
  return perKind(
    queries.map((query, at) => {
      const answer = answers[at];
      return [
        query,
        answer?.resource === query.resource ? answer.allowed : null,
      ] as const;
    })
  );
}

/**
 * The same question for kinds the registry does not hold, asked in the
 * terms the API server matches. A kind the cluster could not be asked about
 * has no answer, which is not a refusal.
 */
export function useResourceAccess(queries: ListQuery[]): PerKind<boolean> {
  const currentContext = useClusterStore((s) => s.currentContext);
  const isConnected = useClusterStore((s) => s.isConnected);
  const scope = useClusterStore((s) => s.namespaceScope);

  // Sorted into the key, not passed as it comes: the same selection made in
  // a different order is the same question, and keying on the order would
  // ask it again and hold two copies of one answer.
  const namespaces = [...scope].sort();
  const rights = useRightsAsked();

  // The asked kinds are part of the question: the nav asks about its own
  // rows, the Gateway rows ask about theirs, and one key for both would
  // hand the second asker the first one's answers.
  const queryKey = queryKeys.listAccess(
    "may",
    currentContext,
    namespaces,
    queries,
    rights
  );
  const { data } = useQuery({
    queryKey,
    placeholderData: heldWhileAskedAgain(queryKey),
    queryFn: () => askListAccess(queries, namespaces),
    enabled: isConnected && Boolean(currentContext),
    staleTime: REVIEW_FRESH_MS,
    // A cluster that cannot answer leaves every row unmarked, which is the
    // state the app has always been in. Retrying that is spending requests
    // to be told the same thing.
    retry: false,
  });

  // `null` is "could not ask", and has to stay out: a row drawn as refused
  // because the review failed says something untrue about the reader.
  return perKind(
    queries.flatMap((query) => {
      const allowed = data?.get(query);
      return allowed == null ? [] : [[query, allowed] as const];
    })
  );
}

/**
 * Why a row is locked. Under All namespaces a namespaced kind is asked about
 * the whole cluster, and a refusal there is not a refusal in every
 * namespace: a reader with rights in their own still lists it once they
 * choose one.
 */
export type Lock = { says: "refused" } | ({ says: "clusterWide" } & Reach);

/** What the namespaces the app can name answered about one kind. */
export interface Reach {
  /** Asked, and it may be listed there. */
  readableIn: readonly string[];
  /** Asked, and refused there too. */
  refusedIn: readonly string[];
  /** A namespace the reader may have went unasked or unanswered, so one may still list it. */
  unasked: boolean;
}

const UNASKED: Reach = { readableIn: [], refusedIn: [], unasked: true };

/** The namespaces the app can name without listing them: the kubeconfig's, then the recent ones. */
const NAMEABLE = 3;
const NO_RECENT: readonly string[] = [];

function useNameableNamespaces(): string[] {
  const context = useClusterStore((s) => s.currentContext);
  const named = useClusterStore(
    (s) => s.contexts.find((c) => c.name === s.currentContext)?.namespace
  );
  const recent =
    useNamespaceRecencyStore((s) =>
      context ? s.recent[context] : undefined
    ) ?? NO_RECENT;
  return [...new Set([...seedScope(named), ...recent])].slice(0, NAMEABLE);
}

/**
 * What each kind's answer was in the namespaces the app can name. A kind
 * nobody could ask about has no entry, which is unasked.
 */
function useReadableIn(queries: ListQuery[]): PerKind<Reach> {
  const currentContext = useClusterStore((s) => s.currentContext);
  const isConnected = useClusterStore((s) => s.isConnected);
  const namespaces = useNameableNamespaces();
  const rights = useRightsAsked();

  const queryKey = queryKeys.listAccess(
    "where",
    currentContext,
    namespaces,
    queries,
    rights
  );
  const { data } = useQuery({
    queryKey,
    placeholderData: heldWhileAskedAgain(queryKey),
    queryFn: async () => {
      const answers = await Promise.all(
        namespaces.map((namespace) =>
          askListAccess(queries, [namespace])
            .catch(() => NO_ANSWERS)
            .then((each) => ({ namespace, each }))
        )
      );
      return perKind(
        queries.map((query) => {
          const said = answers.map(({ namespace, each }) => ({
            namespace,
            allowed: each.get(query) ?? null,
          }));
          const where = (allowed: boolean) =>
            said.filter((a) => a.allowed === allowed).map((a) => a.namespace);
          return [
            query,
            {
              readableIn: where(true),
              refusedIn: where(false),
              unasked: said.some((a) => a.allowed === null),
            },
          ] as const;
        })
      );
    },
    enabled:
      isConnected &&
      Boolean(currentContext) &&
      queries.length > 0 &&
      namespaces.length > 0,
    staleTime: REVIEW_FRESH_MS,
    retry: false,
  });
  return data ?? NO_ANSWERS;
}

/** The lock on each refused kind; an allowed or unasked kind has none. */
export function useLocks(queries: ListQuery[]): PerKind<Lock> {
  const allowed = useResourceAccess(queries);
  const everywhere = useClusterStore((s) => s.namespaceScope.length === 0);
  const acrossCluster = everywhere
    ? queries.filter(
        (query) => query.namespaced && allowed.get(query) === false
      )
    : [];
  const readable = useReadableIn(acrossCluster);
  return perKind(
    queries.flatMap((query) => {
      if (allowed.get(query) !== false) return [];
      const lock: Lock = acrossCluster.includes(query)
        ? { says: "clusterWide", ...(readable.get(query) ?? UNASKED) }
        : { says: "refused" };
      return [[query, lock] as const];
    })
  );
}

/** {@link useLocks} for the kinds the registry holds. */
export function useListLocks(
  kinds: ResourceKind[]
): Partial<Record<ResourceKind, Lock>> {
  const locks = useLocks(kinds.map(listQueryFor));
  const byKind: Partial<Record<ResourceKind, Lock>> = {};
  for (const kind of kinds) {
    const lock = locks.get(listQueryFor(kind));
    if (lock) byKind[kind] = lock;
  }
  return byKind;
}

/** Where a kind refused across the cluster can be listed instead, and where it was refused too, for a list page. */
export function useListableIn(query: ListQuery | null): Reach {
  const readable = useReadableIn(query?.namespaced ? [query] : []);
  return (query && readable.get(query)) ?? UNASKED;
}

/** Refused across the cluster and in every namespace asked: no namespace the app knows of may still answer. */
export const refusedEverywhereAsked = (reach: Reach) =>
  !reach.unasked && reach.readableIn.length === 0;

/** One lock for a row that stands for several kinds, each of them locked. */
export function oneLock(locks: readonly Lock[]): Lock {
  const wide = locks.flatMap((lock) =>
    lock.says === "clusterWide" ? [lock] : []
  );
  if (wide.length < locks.length) return { says: "refused" };
  return {
    says: "clusterWide",
    readableIn: [...new Set(wide.flatMap((lock) => lock.readableIn))],
    refusedIn:
      wide[0]?.refusedIn.filter((namespace) =>
        wide.every((lock) => lock.refusedIn.includes(namespace))
      ) ?? [],
    unasked: wide.some((lock) => lock.unasked),
  };
}
