import { useCallback, useMemo } from "react";
import {
  skipToken,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";

import type { Scoped } from "@/generated/types";
import { useReadUid } from "@/hooks/useReadUid";
import { useResourceWatch } from "@/hooks/useResourceWatch";
import { commands } from "@/lib/commands";
import { ERROR_CODES } from "@/lib/error-utils";
import { queryKeys } from "@/lib/query-keys";
import type { ServiceSeen } from "@/lib/service-health";
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
    behind: true,
  });
}

/**
 * The pods a workload's page or peek, or a node's page, lists, watched as
 * the API server narrows them: each change reads `reads` again, so a row
 * there turns when the Pods list's row does rather than on a poll, and a
 * workload's own object with them, whose counts its controller rewrites on
 * the same change. Watched per object read, as the backend reads its
 * selector once, at subscribe, and refuses one not there: a page opened on
 * a deleted Deployment watched nothing once it was made again.
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
  const read = useReadUid(kind, namespace, name, !node);
  const queryKey = useMemo(
    () => queryKeys.ownedPodWatch(kind, node ? null : namespace, name, read),
    [kind, node, namespace, name, read]
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
    enabled:
      enabled &&
      visible &&
      connected &&
      !!name &&
      (node || (!!namespace && !!read)),
    subscribe,
    queryKey,
    detail: () =>
      node ? reads : [...reads, queryKeys.detail(kind, namespace, name)],
    recount: false,
    behind: true,
  });
}

/**
 * The pods a Service's selector picks and the slices it publishes, watched as
 * the API server narrows them while its verdict is on screen: each change
 * reads `reads` again, so a pod turning Ready shows when its slice says so,
 * not seven seconds later on a poll. The pods are watched per Service object,
 * because the backend reads its selector once, at subscribe, and refuses a
 * Service that is not there: a page opened on a deleted Service watched
 * nothing once it was made again. Answers what the pod watch can vouch for,
 * to every reader of the Service alike; only one that `follow`s subscribes.
 */
export function useServiceWatch(
  namespace: string | null | undefined,
  name: string | undefined,
  service: { uid: string | undefined; selector: string | null | undefined },
  reads: readonly QueryKey[],
  follow: boolean
): ServiceSeen {
  const client = useQueryClient();
  const connected = useClusterStore((s) => s.isConnected);
  const visible = useSurfaceVisible();
  const on = connected && visible && !!namespace && !!name;
  const { uid, selector } = service;
  const podsKey = useMemo(
    () => queryKeys.serviceWatch("pods", namespace, name, selector, uid),
    [namespace, name, selector, uid]
  );
  const slicesKey = useMemo(
    () => queryKeys.serviceWatch("slices", namespace, name),
    [namespace, name]
  );
  const changedKey = useMemo(
    () => queryKeys.serviceWatch("changed", namespace, name),
    [namespace, name]
  );
  const subscribePods = useCallback(
    () =>
      commands.subscribeOwnedPodWatch(
        ResourceType.Service,
        namespace ?? null,
        name ?? ""
      ),
    [namespace, name]
  );
  const subscribeSlices = useCallback(
    () => commands.subscribeServiceSliceWatch(namespace ?? "", name ?? ""),
    [namespace, name]
  );
  const detail = () => reads;
  const podsOn = on && !!selector;
  // A watch that fails before it lists would leave every reader of the
  // Service, the peek's trace beside its status row included, waiting on it.
  const unlisted = (message: string) =>
    client.setQueryData<Scoped<unknown>>(
      podsKey,
      (prev) =>
        prev ?? {
          rows: [],
          unread: [
            {
              namespace: namespace ?? "",
              code: ERROR_CODES.LIST_UNREAD,
              message,
            },
          ],
        }
    );
  useResourceWatch({
    enabled: follow && podsOn,
    subscribe: subscribePods,
    queryKey: podsKey,
    detail,
    onError: unlisted,
    recount: false,
    behind: true,
  });
  useResourceWatch({
    enabled: follow && on,
    subscribe: subscribeSlices,
    queryKey: slicesKey,
    detail,
    recount: false,
    behind: true,
    onChange: () => client.setQueryData(changedKey, Date.now()),
  });
  const pods = useQuery<Scoped<unknown>>({
    queryKey: podsKey,
    queryFn: skipToken,
  });
  const changed = useQuery<number>({
    queryKey: changedKey,
    queryFn: skipToken,
  });
  const listed = pods.data?.rows.length;
  const at = pods.dataUpdatedAt;
  return useMemo(
    () => ({
      pods: !podsOn
        ? undefined
        : listed === undefined
          ? "listing"
          : { pods: listed, at },
      changed: changed.data ?? 0,
    }),
    [podsOn, listed, at, changed.data]
  );
}
