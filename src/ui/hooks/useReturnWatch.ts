import { useCallback, useEffect, useMemo } from "react";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";

import { useResourceWatch } from "@/hooks/useResourceWatch";
import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";
import type { Scoped } from "@/generated/types";
import { useClusterStore } from "@/stores/clusterStore";

/** The kinds `subscribe_object_watch` in `commands/watch.rs` follows by name. */
const WATCHED_BY_NAME: ReadonlySet<string> = new Set([
  "Pod",
  "Deployment",
  "StatefulSet",
  "DaemonSet",
  "Job",
  "Service",
  "Node",
]);

/**
 * While a page's object is gone, its name is watched, and the page reads it
 * again the moment the watch holds an object under that name. A page stops
 * polling at NotFound, so a Service created a few seconds after its page was
 * opened stayed "gone" for as long as the page did.
 */
export function useReturnWatch(
  kind: string,
  namespace: string | null | undefined,
  name: string | undefined,
  gone: boolean
): void {
  const connected = useClusterStore((s) => s.isConnected);
  const client = useQueryClient();
  const enabled = gone && connected && !!name && WATCHED_BY_NAME.has(kind);
  const queryKey = useMemo(
    () => queryKeys.returnWatch(kind, namespace, name),
    [kind, namespace, name]
  );
  const subscribe = useCallback(
    () => commands.subscribeObjectWatch(kind, namespace ?? null, name ?? ""),
    [kind, namespace, name]
  );
  useResourceWatch({ enabled, subscribe, queryKey, recount: false });
  const back = !!useQuery<Scoped<unknown>>({ queryKey, queryFn: skipToken })
    .data?.rows.length;
  useEffect(() => {
    if (enabled && back)
      void client.invalidateQueries({
        queryKey: queryKeys.detail(kind, namespace, name),
      });
  }, [enabled, back, client, kind, namespace, name]);
}
