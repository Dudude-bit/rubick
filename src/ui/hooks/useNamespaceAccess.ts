/**
 * Which namespaces this user may actually use, asked before the picker offers
 * them — the wall {@link useListAccess} spares the nav, spared the picker. The
 * map only ever removes an offer, and only on a firm refusal: a namespace the
 * authorizer could not be asked about is absent, never `false`, so "could not
 * check" is never drawn as "turned away".
 */

import { useQuery } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import { useClusterStore } from "@/stores/clusterStore";

/** Rights change rarely, never within an open picker; matches useListAccess. */
const REVIEW_FRESH_MS = 5 * 60 * 1000;

/** Namespace name to whether the reader may use it; absent means unknown. */
export type NamespaceAccessMap = Map<string, boolean>;

export function useNamespaceAccess(names: string[]): NamespaceAccessMap {
  const currentContext = useClusterStore((s) => s.currentContext);
  const isConnected = useClusterStore((s) => s.isConnected);

  // Sorted into the key: the same namespaces in a different order are one
  // question, and keying on the order would ask it twice.
  const sorted = [...names].sort();

  const { data } = useQuery({
    queryKey: ["namespace-access", currentContext, sorted],
    queryFn: () => commands.checkNamespaceAccess(sorted),
    enabled: isConnected && Boolean(currentContext) && names.length > 0,
    staleTime: REVIEW_FRESH_MS,
    retry: false,
  });

  const map: NamespaceAccessMap = new Map();
  for (const answer of data ?? []) {
    // `null`/`undefined` are both "could not ask", and both stay out.
    if (answer.allowed !== null && answer.allowed !== undefined) {
      map.set(answer.namespace, answer.allowed);
    }
  }
  return map;
}
