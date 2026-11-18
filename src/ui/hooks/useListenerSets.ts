import { useMemo } from "react";

import type { ListenerSetInfo } from "@/generated/types";
import { useGatewayApi } from "@/hooks/useGatewayApi";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { ROUTING_STALE } from "@/integrations";
import { commands } from "@/lib/commands";
import { errorToShow } from "@/lib/error-utils";
import { queryKeys } from "@/lib/query-keys";
import type { RefreshRate } from "@/lib/refresh";

export interface ListenerSetsRead {
  /** `null` until they answer, and where they were refused or failed. */
  sets: ListenerSetInfo[] | null;
  /** The cluster's words where they were refused or failed. */
  said: string | null;
}

/**
 * Every `ListenerSet`, for a route that names one: the set's own parentRef
 * says which Gateway it belongs to. A cluster that does not serve the kind
 * has none, and is not asked.
 */
export function useListenerSets(
  enabled: boolean,
  refresh: RefreshRate | false = false
): ListenerSetsRead {
  const detection = useGatewayApi().data;
  const served =
    detection?.kinds.some((kind) => kind.kind === "ListenerSet") ?? false;
  const query = useLiveQuery({
    queryKey: queryKeys.listenerSets(),
    queryFn: commands.listListenerSets,
    staleTime: ROUTING_STALE,
    refresh,
    enabled: enabled && served,
  });
  const { data, error } = query;
  return useMemo(() => {
    if (detection !== undefined && !served) return { sets: [], said: null };
    // A read failed since the last answer: what that answer held is not
    // what is there now.
    return error
      ? { sets: null, said: errorToShow(error) }
      : { sets: data ?? null, said: null };
  }, [detection, served, data, error]);
}
