import { useMemo } from "react";

import { useClusterOverview } from "@/hooks/useClusterOverview";
import { useIngressHealth } from "@/hooks/useIngressHealth";
import { useLiveQuery, type Freshness } from "@/hooks/useLiveQuery";
import { useNow } from "@/hooks/useNow";
import { useServiceHealthInputs } from "@/hooks/useServiceHealthInputs";
import { useT } from "@/i18n/useT";
import { attentionOf, type Attention } from "@/lib/attention";
import { commands } from "@/lib/commands";
import { scopeCacheKey, wireScope } from "@/lib/namespace-scope";
import { queryKeys } from "@/lib/query-keys";
import { overdue, REFRESH_INTERVALS, type RefreshRate } from "@/lib/refresh";
import { ResourceType } from "@/lib/resource-registry";
import { useClusterStore } from "@/stores/clusterStore";

/** Older than the shell's own rate is older than any reader of this asks for. */
const late = (
  { dataUpdatedAt, everyMs }: Pick<Freshness, "dataUpdatedAt" | "everyMs">,
  now: number
) =>
  overdue(
    dataUpdatedAt,
    everyMs && Math.max(everyMs, REFRESH_INTERVALS.shell),
    now
  );

/**
 * What needs attention in `scope` (the window's own by default): `null`
 * until the overview has answered for this very scope, so no reader counts
 * the last scope's problems under this one's label.
 *
 * Beside the overview, four lists across the scope: the Services and the
 * Ingresses cut to what their verdicts read, the autoscalers and the claims
 * shared with their own pages. They are asked at `refresh`: the shell's
 * rate for the count it keeps on every screen, the Overview's own while the
 * page about them is open. Both ask under the same keys, so the Overview
 * opens on the shell's last answer.
 */
export function useAttention({
  scope,
  refresh = "shell",
  enabled = true,
}: {
  scope?: readonly string[];
  refresh?: RefreshRate;
  enabled?: boolean;
} = {}): Attention | null {
  const t = useT();
  const windowScope = useClusterStore((s) => s.namespaceScope);
  const isConnected = useClusterStore((s) => s.isConnected);
  const asked = scope ?? windowScope;
  const wire = useMemo(() => wireScope(asked), [asked]);
  const cacheKey = scopeCacheKey(asked);
  const reading = isConnected && enabled;

  const overview = useClusterOverview(asked, enabled);
  const services = useServiceHealthInputs(wire, {
    enabled: reading,
    refresh,
  });
  const ingresses = useLiveQuery({
    queryKey: queryKeys.ingressHealthInputs(cacheKey),
    queryFn: () => commands.listIngressHealthInputs(wire),
    enabled: reading,
    refresh,
  });
  const ingressHealth = useIngressHealth(
    ingresses.data?.rows,
    services,
    reading
  );
  const autoscalers = useLiveQuery({
    queryKey: queryKeys.autoscalers(cacheKey),
    queryFn: () => commands.listAutoscalersIn(wire),
    enabled: reading,
    refresh,
  });
  const claims = useLiveQuery({
    queryKey: queryKeys.resources(ResourceType.PersistentVolumeClaim, cacheKey),
    queryFn: () => commands.listPersistentVolumeClaimsIn(wire),
    enabled: reading,
    refresh,
  });

  const answered =
    enabled && overview.data !== undefined && !overview.isPlaceholderData
      ? overview.data
      : null;
  // A clock that moves in steps, so the cached answer holds between them.
  const now = useNow();
  const ingressData = ingresses.data;
  const ingressError = ingresses.error;
  const ingressLate = late(ingresses.freshness, now);
  const autoscalerData = autoscalers.data;
  const autoscalerError = autoscalers.error;
  const autoscalerLate = late(autoscalers.freshness, now);
  const claimData = claims.data;
  const claimError = claims.error;
  const claimLate = late(claims.freshness, now);
  const servicesLate = late(services.freshness, now);

  return useMemo(
    () =>
      answered &&
      attentionOf(
        {
          overview: answered,
          services: {
            answered: services.answered,
            unread: services.unread,
            overdue: servicesLate,
          },
          ingresses: {
            data: ingressData,
            error: ingressError,
            overdue: ingressLate,
          },
          ingressHealth,
          autoscalers: {
            data: autoscalerData,
            error: autoscalerError,
            overdue: autoscalerLate,
          },
          claims: { data: claimData, error: claimError, overdue: claimLate },
          now,
        },
        t
      ),
    [
      answered,
      services,
      servicesLate,
      ingressData,
      ingressError,
      ingressLate,
      ingressHealth,
      autoscalerData,
      autoscalerError,
      autoscalerLate,
      claimData,
      claimError,
      claimLate,
      now,
      t,
    ]
  );
}
