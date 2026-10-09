import { useCallback, useEffect, useMemo, useState } from "react";
import {
  skipToken,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";

import { useResourceWatch } from "@/hooks/useResourceWatch";
import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";
import { useSurfaceVisible } from "@/lib/surface-visibility";
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
 * A page's object watched by its name for as long as the page is on screen,
 * there or gone: each change the watch sees, a deletion included, reads the
 * object and its manifest again, and a watch that lists the object while the
 * page has it gone, or lists nothing while the page holds it, reads it again
 * at once. A page backs off while nothing changes and stops at NotFound, so
 * a deleted Service stayed on its page for 25 s, and one created after its
 * page was opened stayed gone. Answers whether the watch is feeding the page.
 */
export function useObjectWatch(
  kind: string,
  namespace: string | null | undefined,
  name: string | undefined,
  gone: boolean
): boolean {
  const connected = useClusterStore((s) => s.isConnected);
  const visible = useSurfaceVisible();
  const client = useQueryClient();
  const enabled = connected && visible && !!name && WATCHED_BY_NAME.has(kind);
  const queryKey = useMemo(
    () => queryKeys.objectWatch(kind, namespace, name),
    [kind, namespace, name]
  );
  const subscribe = useCallback(
    () => commands.subscribeObjectWatch(kind, namespace ?? null, name ?? ""),
    [kind, namespace, name]
  );
  const [failedFor, setFailedFor] = useState<QueryKey | null>(null);
  const { resyncing } = useResourceWatch({
    enabled,
    subscribe,
    queryKey,
    detail: queryKeys.rowDetail(kind),
    onError: () => setFailedFor(queryKey),
    onRecovered: () => setFailedFor(null),
    recount: false,
    behind: true,
  });
  const listed = useQuery<Scoped<unknown>>({ queryKey, queryFn: skipToken })
    .data?.rows.length;
  useEffect(() => {
    if (enabled && listed !== undefined && (gone ? listed > 0 : listed === 0))
      void client.invalidateQueries({
        queryKey: queryKeys.detail(kind, namespace, name),
      });
  }, [enabled, listed, gone, client, kind, namespace, name]);
  return (
    enabled && failedFor !== queryKey && !resyncing && listed !== undefined
  );
}
