import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import type { RouteInfo } from "@/generated/types";
import { useDoorAsk } from "@/hooks/useDoorAsk";
import { useGatewayApi } from "@/hooks/useGatewayApi";
import { ROUTING_STALE } from "@/integrations";
import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";
import type { TraceSources } from "@/lib/route-trace";
import { useRouteBacking } from "./useRouteBacking";

/**
 * What a route is judged against, for every part of its page.
 *
 * Unscoped on purpose, twice over: routes attach to Gateways in other
 * namespaces, and the class claim is cluster-scoped. Same keys as the
 * routes list's map, so table → detail reuses one cache entry.
 */
export function useTraceSources(route: RouteInfo): TraceSources {
  const detection = useGatewayApi().data;
  const served = useMemo(
    () => new Set(detection?.kinds.map((kind) => kind.kind) ?? []),
    [detection]
  );
  const gateways = useQuery({
    queryKey: queryKeys.gateways(),
    queryFn: () => commands.listGateways(null),
    staleTime: ROUTING_STALE,
    enabled: served.has("Gateway"),
  });
  const classes = useQuery({
    queryKey: queryKeys.gatewayClasses(),
    queryFn: commands.listGatewayClasses,
    staleTime: ROUTING_STALE,
    enabled: served.has("GatewayClass"),
  });
  const backing = useRouteBacking(route, false).sources;
  const door = useDoorAsk();
  return useMemo(
    () => ({
      gateways: gateways.data ?? [],
      classes: classes.data ?? [],
      topologyKnown:
        gateways.data !== undefined &&
        (classes.data !== undefined || !served.has("GatewayClass")),
      backing,
      door,
    }),
    [gateways.data, classes.data, served, backing, door]
  );
}
