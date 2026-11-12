import { useMemo } from "react";

import type { EventInfo } from "@/generated/types";
import { useLiveQueries, useLiveQuery } from "@/hooks/useLiveQuery";
import { commands } from "@/lib/commands";
import { createRefusal } from "@/lib/create-refusal";
import { queryKeys } from "@/lib/query-keys";
import { useClusterStore } from "@/stores/clusterStore";

/** The newest refusals read, which keeps one answer under the IPC budget on a cluster where many controllers fail. */
const REFUSALS_READ = 200;

const refusalsRead = (namespace: string | null, enabled: boolean) => ({
  queryKey: [...queryKeys.events(namespace), "refusals"],
  queryFn: () =>
    commands.listEvents({
      namespace,
      involved_object_name: null,
      involved_object_kind: null,
      event_type: "Warning",
      field_selector: "reason=FailedCreate",
      limit: REFUSALS_READ,
    }),
  enabled,
  retry: false,
});

/**
 * The pods the API server refused to create in `namespace`, every namespace
 * where it is null, under one key every list, page and peek shares; `null`
 * while they are read or where they could not be.
 */
export function useRefusals(
  namespace: string | null,
  enabled = true
): readonly EventInfo[] | null {
  const isConnected = useClusterStore((s) => s.isConnected);
  const read = useLiveQuery({
    ...refusalsRead(namespace, enabled && isConnected),
    refresh: "slow",
  });
  return read.data ?? null;
}

/** The refusals read in one namespace of a list's scope; `null` while they are read or where they could not be. */
export type ScopeRefusals = (namespace: string) => readonly EventInfo[] | null;

/**
 * The same refusals for a list's scope, as `wireScope` gives it. Several
 * namespaces are asked one apiece, as their rows' pages ask: a reader bound
 * to namespaces is refused the cluster-wide read, and one namespace's
 * refusal is not the others'.
 */
export function useScopeRefusals(
  scope: readonly string[] | null,
  enabled = true
): ScopeRefusals {
  const isConnected = useClusterStore((s) => s.isConnected);
  const { data } = useLiveQueries<EventInfo[]>({
    queries: (scope ?? [null]).map((namespace) =>
      refusalsRead(namespace, enabled && isConnected)
    ),
    refresh: "slow",
  });
  return useMemo<ScopeRefusals>(() => {
    if (!scope) return () => data[0] ?? null;
    const read = new Map(
      scope.map((namespace, index) => [namespace, data[index]])
    );
    return (namespace) => read.get(namespace) ?? null;
  }, [scope, data]);
}

/**
 * The API server's refusal of the pods the controller `uid` asks for, read
 * beside the pods it has; `null` where none holds or either is unread.
 */
export function useRefusal(
  namespace: string | null | undefined,
  uid: string | null | undefined,
  pods: readonly { createdAt: string | null }[] | null | undefined,
  enabled = true
): string | null {
  const refusals = useRefusals(namespace ?? null, enabled && !!uid);
  return useMemo(
    () =>
      uid && pods && refusals
        ? createRefusal(
            uid,
            refusals,
            pods.map((pod) => pod.createdAt)
          )
        : null,
    [uid, pods, refusals]
  );
}
