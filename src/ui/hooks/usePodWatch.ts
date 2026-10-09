import { useCallback, useMemo } from "react";
import type { QueryKey } from "@tanstack/react-query";

import { useResourceWatch } from "@/hooks/useResourceWatch";
import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";
import { ResourceType } from "@/lib/resource-registry";
import { useSurfaceVisible } from "@/lib/surface-visibility";
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

/**
 * The pods a workload's page or peek, or a node's page, lists, watched as
 * the API server narrows them: each change reads `reads` again, so a row
 * there turns when the Pods list's row does rather than on a poll.
 */
export function useOwnedPodsWatch(
  kind: string,
  namespace: string | null | undefined,
  name: string | undefined,
  reads: readonly QueryKey[],
  enabled: boolean
): void {
  const connected = useClusterStore((s) => s.isConnected);
  const visible = useSurfaceVisible();
  const node = kind === ResourceType.Node;
  const queryKey = useMemo(
    () => queryKeys.ownedPodWatch(kind, node ? null : namespace, name),
    [kind, node, namespace, name]
  );
  const subscribe = useCallback(
    () =>
      commands.subscribeOwnedPodWatch(
        kind,
        node ? null : (namespace ?? null),
        name ?? ""
      ),
    [kind, node, namespace, name]
  );
  useResourceWatch({
    enabled: enabled && visible && connected && !!name && (node || !!namespace),
    subscribe,
    queryKey,
    detail: () => reads,
    recount: false,
  });
}
