import type { QueryClient } from "@tanstack/react-query";

import type { PeekTarget } from "@/hooks/usePeek";
import { STALE_TIMES } from "@/lib/refresh";
import { useClusterStore } from "@/stores/clusterStore";

interface ObjectParams {
  cluster: string;
  resource?: string;
  namespace?: string;
  name: string;
}

/**
 * Reads an object into the entry its page and its peek read. A route's loader
 * starts it on hover and does not await it, so a navigation never waits on
 * the cluster. Only in the cluster the window is connected to: a query key
 * does not carry the cluster, so a link into another one would cache this
 * cluster's answer under that object's name.
 */
export async function prefetchObject(
  queryClient: QueryClient,
  params: ObjectParams,
  kind?: string
): Promise<void> {
  const cluster = useClusterStore.getState();
  if (!cluster.isConnected || cluster.currentContext !== params.cluster) return;
  const { peekQueryKey, resolveSource } = await import("../-peek/peek-sources");
  const namespace = params.namespace ?? null;
  const target: PeekTarget = {
    kind: kind ?? params.resource ?? "",
    name: params.name,
    namespace,
    crd: !kind && params.resource?.includes(".") ? params.resource : undefined,
  };
  const queryKey = peekQueryKey(target);
  if (queryKey[0] === "peek") return;
  await queryClient
    .query({
      queryKey,
      queryFn: () => resolveSource(target).fetch(target.name, namespace),
      staleTime: STALE_TIMES.resourceDetail,
    })
    .catch(() => undefined);
}
