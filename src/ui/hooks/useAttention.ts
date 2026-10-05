import { useMemo } from "react";

import { useClusterOverview } from "@/hooks/useClusterOverview";
import { useIngressHealth } from "@/hooks/useIngressHealth";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { useNow } from "@/hooks/useNow";
import { useServiceBacking } from "@/hooks/useServiceBacking";
import { useT } from "@/i18n/useT";
import { attentionOf, type Attention } from "@/lib/attention";
import { commands } from "@/lib/commands";
import { scopeCacheKey, wireScope } from "@/lib/namespace-scope";
import { queryKeys } from "@/lib/query-keys";
import { ResourceType } from "@/lib/resource-registry";
import { useClusterStore } from "@/stores/clusterStore";

/**
 * What needs attention in `scope` (the window's own by default): `null`
 * until the overview has answered for this very scope, so no reader counts
 * the last scope's problems under this one's label.
 *
 * Beside the overview, four lists at the slow rate, one per namespace of the
 * scope: what the Services publish, the Ingresses, the autoscalers, the
 * claims. They share their cache entries with the pages that list the same
 * kinds, and the shell and the Overview share one answer.
 */
export function useAttention(scope?: readonly string[]): Attention | null {
  const t = useT();
  const windowScope = useClusterStore((s) => s.namespaceScope);
  const isConnected = useClusterStore((s) => s.isConnected);
  const asked = scope ?? windowScope;
  const wire = useMemo(() => wireScope(asked), [asked]);
  const cacheKey = scopeCacheKey(asked);

  const overview = useClusterOverview(asked);
  const services = useServiceBacking(wire, isConnected);
  const ingresses = useLiveQuery({
    queryKey: queryKeys.resources(ResourceType.Ingress, cacheKey),
    queryFn: () => commands.listIngressesIn(wire),
    enabled: isConnected,
    refresh: "slow",
  });
  const ingressHealth = useIngressHealth(
    ingresses.data?.rows,
    wire,
    isConnected
  );
  const autoscalers = useLiveQuery({
    queryKey: queryKeys.autoscalers(cacheKey),
    queryFn: () => commands.listAutoscalersIn(wire),
    enabled: isConnected,
    refresh: "slow",
  });
  const claims = useLiveQuery({
    queryKey: queryKeys.resources(ResourceType.PersistentVolumeClaim, cacheKey),
    queryFn: () => commands.listPersistentVolumeClaimsIn(wire),
    enabled: isConnected,
    refresh: "slow",
  });

  const answered =
    overview.data !== undefined && !overview.isPlaceholderData
      ? overview.data
      : null;
  // A clock that moves in steps, so the cached answer holds between them.
  const now = useNow();
  const ingressData = ingresses.data;
  const ingressError = ingresses.error;
  const autoscalerData = autoscalers.data;
  const autoscalerError = autoscalers.error;
  const claimData = claims.data;
  const claimError = claims.error;

  return useMemo(
    () =>
      answered &&
      attentionOf(
        {
          overview: answered,
          services,
          ingresses: { data: ingressData, error: ingressError },
          ingressHealth,
          autoscalers: { data: autoscalerData, error: autoscalerError },
          claims: { data: claimData, error: claimError },
          now,
        },
        t
      ),
    [
      answered,
      services,
      ingressData,
      ingressError,
      ingressHealth,
      autoscalerData,
      autoscalerError,
      claimData,
      claimError,
      now,
      t,
    ]
  );
}
