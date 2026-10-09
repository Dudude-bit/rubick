import { useCallback, useSyncExternalStore } from "react";
import {
  hashKey,
  notifyManager,
  useQueryClient,
  type QueryState,
} from "@tanstack/react-query";

import { queryKeys } from "@/lib/query-keys";

/** One field of the object's read on its page or peek, from the entry they share, without asking for it. */
function useReadOf<T extends string | number | null | undefined>(
  kind: string,
  namespace: string | null | undefined,
  name: string | null | undefined,
  pick: (state: QueryState | undefined) => T
): T {
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
  return useSyncExternalStore(subscribe, () =>
    pick(client.getQueryCache().get(hash)?.state)
  );
}

/** The uid of the object its page or peek has read: undefined until one of them has. */
export function useReadUid(
  kind: string,
  namespace: string | null | undefined,
  name: string | null | undefined,
  enabled = true
): string | undefined {
  return useReadOf(kind, namespace, name, (state) => {
    if (!enabled) return undefined;
    const read = state?.data;
    const uid =
      read && typeof read === "object" && "uid" in read ? read.uid : undefined;
    return typeof uid === "string" && uid !== "" ? uid : undefined;
  });
}

/**
 * The label selector its page or peek has read, written as the API server's
 * query text: undefined until one of them has, `null` for none.
 */
export function useReadSelector(
  kind: string,
  namespace: string | null | undefined,
  name: string | null | undefined
): string | null | undefined {
  return useReadOf(kind, namespace, name, (state) => {
    const read = state?.data;
    if (!read || typeof read !== "object" || !("selector" in read))
      return undefined;
    const selector = read.selector;
    if (!selector || typeof selector !== "object") return undefined;
    const text = Object.entries(selector as Record<string, string>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => `${key}=${value}`)
      .join(",");
    return text || null;
  });
}

/** When its page or peek last read the object there, or 0 where the last read of it failed or none has answered. */
export function useReadThereAt(
  kind: string,
  namespace: string | null | undefined,
  name: string | null | undefined
): number {
  return useReadOf(kind, namespace, name, (state) =>
    state?.status === "success" && state.data !== undefined
      ? state.dataUpdatedAt
      : 0
  );
}
