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
  const currentContext = useClusterStore((s) => s.currentContext);
  const isConnected = useClusterStore((s) => s.isConnected);
  const scope = useClusterStore((s) => s.namespaceScope);

  // Sorted into the key, not passed as it comes: the same selection made in
  // a different order is the same question, and keying on the order would
  // ask it again and hold two copies of one answer.
  const namespaces = [...scope].sort();

  const { data } = useQuery({
    queryKey: ["list-access", currentContext, namespaces],
    queryFn: () =>
      commands.checkListAccess(kinds.map(listQueryFor), namespaces),
    enabled: isConnected && Boolean(currentContext),
    staleTime: REVIEW_FRESH_MS,
    // A cluster that cannot answer leaves every row unmarked, which is the
    // state the app has always been in. Retrying that is spending requests
    // to be told the same thing.
    retry: false,
  });

  // Keyed back by kind: the answer comes home addressed by plural, which is
  // what the API server matched, and the nav thinks in kinds.
  const byPlural = new Map((data ?? []).map((e) => [e.resource, e.allowed]));
  const marks: ListAccessMap = {};
  for (const kind of kinds) {
    const allowed = byPlural.get(listQueryFor(kind).resource);
    // `null` and `undefined` are both "could not ask", and both have to stay
    // out: a row drawn as refused because the review failed says something
    // untrue about the reader.
    if (allowed !== null && allowed !== undefined) marks[kind] = allowed;
  }
  return marks;
}
