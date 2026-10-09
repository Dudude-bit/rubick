/**
 * Which namespaces this user may actually use, asked before the picker offers
 * them: the wall {@link useListAccess} spares the nav, spared the picker. An
 * offer is only ever removed on a firm answer that nothing there may be
 * listed: a namespace the authorizer could not be asked about is absent, never
 * refused, so "could not check" is never drawn as "turned away", and one that
 * refuses pods but serves other lists stays offered, saying what it refuses.
 */

import { useQuery } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import { useRightsAsked } from "@/lib/refusals";
import { useClusterStore } from "@/stores/clusterStore";

/** Rights change rarely, never within an open picker; matches useListAccess. */
const REVIEW_FRESH_MS = 5 * 60 * 1000;

export interface NamespaceAccessMap {
  /** Namespace name to whether its pods may be listed; absent means unknown. */
  pods: Map<string, boolean>;
  /** The namespaces where nothing at all may be listed: the only ones hidden. */
  shut: Set<string>;
}

export function useNamespaceAccess(names: string[]): NamespaceAccessMap {
  const currentContext = useClusterStore((s) => s.currentContext);
  const isConnected = useClusterStore((s) => s.isConnected);

  // Sorted into the key: the same namespaces in a different order are one
  // question, and keying on the order would ask it twice.
  const sorted = [...names].sort();
  const rights = useRightsAsked();

  const { data } = useQuery({
    queryKey: ["namespace-access", currentContext, sorted, rights],
    queryFn: () => commands.checkNamespaceAccess(sorted),
    enabled: isConnected && Boolean(currentContext) && names.length > 0,
    staleTime: REVIEW_FRESH_MS,
    retry: false,
    // A name added to the question keeps the answers about the others, on
    // the same cluster and under the same rights.
    placeholderData: (previous, query) =>
      query?.queryKey[1] === currentContext && query.queryKey[3] === rights
        ? previous
        : undefined,
  });

  const access: NamespaceAccessMap = { pods: new Map(), shut: new Set() };
  for (const answer of data ?? []) {
    // `null`/`undefined` are both "could not ask", and both stay out.
    if (answer.allowed !== null && answer.allowed !== undefined) {
      access.pods.set(answer.namespace, answer.allowed);
    }
    if (answer.allowed === false && answer.otherLists === false) {
      access.shut.add(answer.namespace);
    }
  }
  return access;
}
