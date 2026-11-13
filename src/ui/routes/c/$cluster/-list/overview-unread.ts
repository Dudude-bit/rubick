import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { ClusterOverview, OverviewUnread } from "@/generated/types";
import { readOverview } from "@/hooks/useClusterOverview";
import { useNamespaceScope } from "@/hooks/useNamespaceScope";
import { queryKeys } from "@/lib/query-keys";
import { ResourceType, type ResourceKind } from "@/lib/resource-registry";
import { useClusterStore } from "@/stores/clusterStore";

/** Every read the overview could not do, events included: it keeps a failed events list with the cut ones, not with the other kinds. */
const unreadOf = (overview: ClusterOverview): OverviewUnread[] => [
  ...overview.unread,
  ...overview.warningsShort.flatMap((short) =>
    short.why === "failed"
      ? [
          {
            kind: ResourceType.Event,
            namespace: short.namespace,
            code: short.code,
            message: short.message,
          },
        ]
      : []
  ),
];

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
    select: unreadOf,
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
