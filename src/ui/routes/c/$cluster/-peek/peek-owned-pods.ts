import { useCallback } from "react";
import { keepPreviousData } from "@tanstack/react-query";

import type {
  DaemonSetDetailInfo,
  DeploymentPods,
  PodInfo,
} from "@/generated/types";
import { useHeldOwner, useReadBehind } from "@/hooks/useHeldRead";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import type { PeekTarget } from "@/hooks/usePeek";
import { useOwnedPodsWatch } from "@/hooks/usePodWatch";
import { commands } from "@/lib/commands";
import { controlledBy } from "@/lib/controlled-by";
import { queryKeys } from "@/lib/query-keys";
import { STALE_TIMES } from "@/lib/refresh";
import { toKind } from "@/lib/resource-registry";

const NO_POD_FILTERS = {
  labelSelector: null,
  fieldSelector: null,
  limit: null,
  statusFilter: null,
  selector: null,
  nodeName: null,
};

/**
 * The pods a controller owns. Each kind links to its pods differently and the
 * detail pages already worked out how; this is the same resolution in one
 * place rather than five.
 */
function fetchOwnedPods(
  target: PeekTarget,
  namespace: string,
  detail: unknown
): Promise<PodInfo[] | DeploymentPods> {
  switch (toKind(target.kind)) {
    case "Deployment":
      return commands.getDeploymentPods(target.name, namespace);
    case "Job":
      return commands.listPods({
        ...NO_POD_FILTERS,
        namespace,
        labelSelector: `job-name=${target.name}`,
      });
    case "DaemonSet":
      return commands.listPods({
        ...NO_POD_FILTERS,
        namespace,
        labelSelector:
          (detail as DaemonSetDetailInfo | undefined)?.selector || null,
      });
    default:
      // StatefulSet: the API does not expose its match labels, but it does
      // guarantee the pod names — `<set>-0`, `<set>-1`, and so on.
      return commands
        .listPods({ ...NO_POD_FILTERS, namespace })
        .then((pods) =>
          pods.filter(
            (pod) =>
              pod.name.startsWith(`${target.name}-`) &&
              /^\d+$/.test(pod.name.slice(target.name.length + 1))
          )
        );
  }
}

/** How many pods the peek's own read of a workload counts ready. */
function readyOf(kind: string | null, detail: unknown) {
  if (kind === "DaemonSet")
    return (detail as DaemonSetDetailInfo | undefined)?.ready;
  if (kind === "Deployment" || kind === "StatefulSet")
    return (detail as { replicas?: { ready: number } } | undefined)?.replicas
      ?.ready;
  return undefined;
}

/**
 * The pods a workload's peek reads, held to the workload they were read for:
 * its Pods tab lists them and its lead tells the cause they share.
 */
export function usePeekOwnedPods(
  target: PeekTarget,
  detail: unknown,
  enabled = true
) {
  const namespace = target.namespace ?? null;
  const kind = toKind(target.kind);
  const selector =
    kind === "DaemonSet"
      ? (detail as DaemonSetDetailInfo | undefined)?.selector
      : undefined;

  const podsKey = queryKeys.ownedPods(
    kind ?? target.kind,
    namespace,
    target.name,
    selector
  );
  // A DaemonSet's selector arrives with the Overview fetch; asking before it
  // lands would list the whole namespace.
  const ready = enabled && !!namespace && (kind !== "DaemonSet" || !!selector);
  // A Deployment's own are its ReplicaSets', which the backend matches.
  const uid =
    kind === "Deployment" ? undefined : (detail as { uid?: string })?.uid;
  const {
    data: read,
    dataUpdatedAt,
    error,
    isPending,
    isFetching,
    refetch,
  } = useLiveQuery({
    queryKey: podsKey,
    queryFn: () => fetchOwnedPods(target, namespace!, detail),
    enabled: ready,
    staleTime: STALE_TIMES.resourceList,
    refresh: "resourceList",
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
    retry: false,
    select: useCallback(
      (read: PodInfo[] | DeploymentPods) =>
        Array.isArray(read) ? controlledBy(read, uid) : read,
      [uid]
    ),
  });
  const other = useHeldOwner(
    kind ?? target.kind,
    namespace,
    target.name,
    {
      answeredFor: Array.isArray(read) ? undefined : read?.uid,
      at: dataUpdatedAt,
    },
    podsKey
  );
  const listed = other ? undefined : Array.isArray(read) ? read : read?.pods;
  const behind = useReadBehind(
    kind ?? target.kind,
    namespace,
    target.name,
    {
      at: dataUpdatedAt,
      contradicted: listed?.length === 0 && (readyOf(kind, detail) ?? 0) > 0,
    },
    podsKey
  );
  useOwnedPodsWatch(
    kind ?? target.kind,
    namespace,
    target.name,
    [podsKey],
    ready
  );
  return {
    data: behind ? undefined : listed,
    error,
    isPending,
    isFetching,
    refetch,
  };
}
