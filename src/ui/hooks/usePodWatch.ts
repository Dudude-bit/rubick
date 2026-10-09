import { useCallback, useMemo } from "react";

import { useResourceWatch } from "@/hooks/useResourceWatch";
import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";
import { ResourceType } from "@/lib/resource-registry";
import { useClusterStore } from "@/stores/clusterStore";

const POD_DETAIL = queryKeys.rowDetail(ResourceType.Pod);

/**
 * The pod's own watch under its page or peek, which no list's watch carries
 * there: each change it sees reads the pod and its manifest again, as the
 * Pods list's watch does, so four seconds up between crashes are not missed
 * by a poll that backed off.
 */
export function usePodWatch(
  namespace: string | null | undefined,
  name: string | undefined,
  enabled: boolean
): void {
  const connected = useClusterStore((s) => s.isConnected);
  const queryKey = useMemo(
    () => queryKeys.podWatch(namespace, name),
    [namespace, name]
  );
  const subscribe = useCallback(
    () =>
      commands.subscribeObjectWatch(
        ResourceType.Pod,
        namespace ?? null,
        name ?? ""
      ),
    [namespace, name]
  );
  useResourceWatch({
    enabled: enabled && connected && !!namespace && !!name,
    subscribe,
    queryKey,
    detail: POD_DETAIL,
    recount: false,
  });
}
