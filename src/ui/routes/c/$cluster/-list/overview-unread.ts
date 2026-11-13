import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { ClusterOverview, OverviewUnread } from "@/generated/types";
import { readOverview } from "@/hooks/useClusterOverview";
import { useNamespaceScope } from "@/hooks/useNamespaceScope";
import { queryKeys } from "@/lib/query-keys";
import type { ResourceKind } from "@/lib/resource-registry";
import { useClusterStore } from "@/stores/clusterStore";

/** The overview's read of this kind that failed in this scope, from the answer the shell keeps; never asked for here, and `retry` asks it once. */
export function useOverviewUnreadOf(kind: ResourceKind | null | undefined) {
  const queryClient = useQueryClient();
  const context = useClusterStore((s) => s.currentContext);
  const selection = useClusterStore((s) => s.namespaceScope);
  const scope = useNamespaceScope();
  const queryKey = queryKeys.clusterOverview(context, selection);
  const { data } = useQuery({
    queryKey,
    queryFn: () => readOverview(selection),
    enabled: false,
    select: (overview: ClusterOverview) => overview.unread,
  });
  const unread = useMemo<OverviewUnread | null>(
    () =>
      (kind &&
        data?.find(
          (entry) =>
            entry.kind === kind &&
            (entry.namespace === null || scope.matches(entry.namespace))
        )) ||
      null,
    [data, kind, scope]
  );
  const retry = () =>
    queryClient.fetchQuery({
      queryKey,
      queryFn: () => readOverview(selection),
      staleTime: 0,
    });
  return { unread, retry };
}
