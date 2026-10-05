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
import { useClusterStore } from "@/stores/clusterStore";
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
  const byPlural = useResourceAccess(kinds.map(listQueryFor));
  const marks: ListAccessMap = {};
  for (const kind of kinds) {
    const allowed = byPlural.get(listQueryFor(kind).resource);
    if (allowed !== undefined) marks[kind] = allowed;
  }
  return marks;
}

/**
 * The same question for kinds the registry does not hold, asked in the
 * terms the API server matches. Keyed by plural, as the answer comes home.
 */
export function useResourceAccess(queries: ListQuery[]): Map<string, boolean> {
  const currentContext = useClusterStore((s) => s.currentContext);
  const isConnected = useClusterStore((s) => s.isConnected);
  const scope = useClusterStore((s) => s.namespaceScope);

  // Sorted into the key, not passed as it comes: the same selection made in
  // a different order is the same question, and keying on the order would
  // ask it again and hold two copies of one answer.
  const namespaces = [...scope].sort();

  // The asked kinds are part of the question: the nav asks about its own
  // rows, the Gateway rows ask about theirs, and one key for both would
  // hand the second asker the first one's answers.
  const asked = queries.map((query) => query.resource).sort();

  const { data } = useQuery({
    queryKey: ["list-access", currentContext, namespaces, asked],
    queryFn: () => commands.checkListAccess(queries, namespaces),
    enabled: isConnected && Boolean(currentContext),
    staleTime: REVIEW_FRESH_MS,
    // A cluster that cannot answer leaves every row unmarked, which is the
    // state the app has always been in. Retrying that is spending requests
    // to be told the same thing.
    retry: false,
  });

  // `null` is "could not ask", and has to stay out: a row drawn as refused
  // because the review failed says something untrue about the reader.
  return new Map(
    (data ?? []).flatMap((entry) =>
      entry.allowed === null ? [] : [[entry.resource, entry.allowed]]
    )
  );
}
