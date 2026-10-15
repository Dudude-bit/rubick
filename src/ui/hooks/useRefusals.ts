import { useMemo } from "react";

import type { EventInfo } from "@/generated/types";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { commands } from "@/lib/commands";
import { createRefusal } from "@/lib/create-refusal";
import { queryKeys } from "@/lib/query-keys";
import { useClusterStore } from "@/stores/clusterStore";

/** The newest refusals read, which keeps one answer under the IPC budget on a cluster where many controllers fail. */
const REFUSALS_READ = 200;

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
    enabled: enabled && isConnected,
    refresh: "slow",
    retry: false,
  });
  return read.data ?? null;
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
