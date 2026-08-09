/**
 * One request for a whole neighbourhood, shared by the two surfaces that
 * read it.
 *
 * The chain sits on the Overview and the groups sit behind a tab, and both
 * want the same answer. One query key means the page asks once whichever the
 * reader opens first, and switching tabs costs nothing.
 */

import { useQuery, keepPreviousData } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import { REFRESH_INTERVALS, STALE_TIMES } from "@/lib/refresh";
import type { ResourceConnections } from "@/generated/types";

export type ConnectionsQuery = ReturnType<typeof useConnections>;

export function useConnections(
  kind: string,
  name: string | undefined,
  namespace: string | null | undefined
) {
  return useQuery<ResourceConnections>({
    queryKey: ["connections", kind, namespace ?? null, name],
    queryFn: () =>
      commands.getResourceConnections(kind, name!, namespace ?? null),
    enabled: !!name,
    // A pod going ready is the fact this view exists to show, so it follows
    // the list pages rather than sitting on a stale answer.
    placeholderData: keepPreviousData,
    staleTime: STALE_TIMES.resourceDetail,
    refetchInterval: REFRESH_INTERVALS.slow,
    retry: false,
  });
}
