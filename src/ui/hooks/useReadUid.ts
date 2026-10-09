import { useCallback, useSyncExternalStore } from "react";
import { hashKey, notifyManager, useQueryClient } from "@tanstack/react-query";

import { queryKeys } from "@/lib/query-keys";

/**
 * The uid of the object its page or peek has read, from the entry they share,
 * without asking for it: undefined until one of them has.
 */
export function useReadUid(
  kind: string,
  namespace: string | null | undefined,
  name: string | null | undefined,
  enabled = true
): string | undefined {
  const client = useQueryClient();
  const hash = hashKey(queryKeys.detail(kind, namespace, name ?? undefined));
  // Batched with the query observers' own notifications: a render forced in
  // the middle of the cache's dispatch left the page's read a poll behind.
  const subscribe = useCallback(
    (notify: () => void) => {
      const later = notifyManager.batchCalls(notify);
      return client.getQueryCache().subscribe((event) => {
        if (event.query.queryHash === hash) later();
      });
    },
    [client, hash]
  );
  return useSyncExternalStore(subscribe, () => {
    if (!enabled) return undefined;
    const read = client.getQueryCache().get(hash)?.state.data;
    const uid =
      read && typeof read === "object" && "uid" in read ? read.uid : undefined;
    return typeof uid === "string" && uid !== "" ? uid : undefined;
  });
}
