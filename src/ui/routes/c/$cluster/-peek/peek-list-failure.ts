import { useCallback, useSyncExternalStore } from "react";
import { hashKey, useQueryClient, type QueryKey } from "@tanstack/react-query";

import { useRefusedAt } from "@/lib/refusals";
import type { ResourceKind } from "@/lib/resource-registry";
import { useOverviewUnreadOf } from "../-list/overview-unread";

export interface ListFailure {
  error: unknown;
  /** When the list said it, a refusal by when the cluster refused. */
  at: number;
  /** The peek's own read has answered since. */
  answeredSince: boolean;
}

/**
 * The failure of the list a peek was opened from: its own re-read, or the
 * fresh list the overview could not make while its watch streams. The peek
 * that list holds is then not followed live, whatever the watch does.
 */
export function useListFailure(
  listKey: QueryKey | null,
  kind: ResourceKind | null | undefined,
  namespace: string | null,
  answeredAt: number
): ListFailure | null {
  const client = useQueryClient();
  const hash = listKey ? hashKey(listKey) : null;
  const subscribe = useCallback(
    (onChange: () => void) =>
      client.getQueryCache().subscribe(({ query }) => {
        if (query.queryHash === hash) onChange();
      }),
    [client, hash]
  );
  const state = useSyncExternalStore(subscribe, () =>
    hash ? (client.getQueryCache().get(hash)?.state ?? null) : null
  );
  const listError = state?.status === "error" ? state.error : null;
  const refusedAt = useRefusedAt(listError);
  const overview = useOverviewUnreadOf(kind);
  const unread =
    overview.unread &&
    (overview.unread.namespace === null ||
      overview.unread.namespace === namespace)
      ? overview.unread
      : null;
  const failure =
    listError !== null && state
      ? { error: listError, at: refusedAt ?? state.errorUpdatedAt }
      : unread
        ? { error: unread, at: overview.since }
        : null;
  return failure && { ...failure, answeredSince: answeredAt > failure.at };
}
