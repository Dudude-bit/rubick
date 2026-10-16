import { useCallback, useEffect, useRef, useState } from "react";
import type { QueryKey } from "@tanstack/react-query";
import { create } from "zustand";

import { useToast } from "@/components/ui/use-toast";
import { useResourceWatch } from "@/hooks/useResourceWatch";
import { useT } from "@/i18n/useT";
import { isRefusal } from "@/lib/error-utils";
import {
  currentConnection,
  noteRefusal,
  readOf,
  useRefusedOn,
} from "@/lib/refusals";
import { useClusterStore } from "@/stores/clusterStore";

export interface WatchedList {
  /** The watch is running and feeding the cache. */
  live: boolean;
  /** What the list query polls at: nothing while live, the list rate otherwise. */
  refresh: false | "resourceList";
  resyncing: boolean;
  watchFailed: boolean;
}

/** How many live watches that recount the overview feed each list, by its key. */
const useRecounting = create<Record<string, number>>(() => ({}));
/** How many live watches feed each list, recounting or not, by its key. */
const useFeeding = create<Record<string, number>>(() => ({}));

/** Whether a live watch feeds the list under `queryKey` and has the overview's counts read again whenever it grows or shrinks. */
export function useListFollowed(queryKey: QueryKey | null): boolean {
  const id = queryKey && JSON.stringify(queryKey);
  return useRecounting((counts) => !!id && (counts[id] ?? 0) > 0);
}

/** Whether a live watch feeds the list under `queryKey`, whatever it does to the overview. */
export function useListLive(queryKey: QueryKey | null): boolean {
  const id = queryKey && JSON.stringify(queryKey);
  return useFeeding((counts) => !!id && (counts[id] ?? 0) > 0);
}

/** Holds `subscription` in `store` while `on`. */
function useRegistered(
  store: typeof useRecounting,
  subscription: string,
  on: boolean
) {
  useEffect(() => {
    if (!on) return;
    const add = (by: number) =>
      store.setState((counts) => ({
        [subscription]: (counts[subscription] ?? 0) + by,
      }));
    add(1);
    return () => add(-1);
  }, [store, on, subscription]);
}

/**
 * A list kept current by a watch, and polled whenever it is not.
 *
 * A refused or broken watch falls back to polling; a broken one says so
 * once, in the app's words. A recovered one stops the polling again. `enabled` is whether a watch can
 * run at all. Several namespaces are one stream, which fails when any of
 * them does.
 *
 * `reportFailure` is the name the toast gives the list, or a function for a
 * caller that reports several watches as one.
 */
export function useWatchedList<
  T extends { name: string; namespace?: string | null },
>({
  enabled,
  subscribe,
  queryKey,
  detail,
  reportFailure,
  order,
  recount,
  onChange,
}: {
  enabled: boolean;
  subscribe: () => Promise<string>;
  queryKey: QueryKey;
  /** Where a row's own object is cached; see `useResourceWatch`. */
  detail: (row: T) => readonly QueryKey[];
  reportFailure: string | ((message: string) => void);
  order?: (a: T, b: T) => boolean;
  recount?: boolean;
  onChange?: () => void;
}): WatchedList {
  const t = useT();
  const { toast } = useToast();
  // Which subscription failed, not whether one did: a new scope is a new
  // stream, and a failure held over from the last one kept a healthy list
  // polling with nothing left to clear it.
  const subscription = JSON.stringify(queryKey);
  const connection = useClusterStore((s) => s.connectionAttemptId);
  // Refused once, not subscribed again until a reconnect: each try is two
  // warnings in the log and a 403 in the cluster's audit.
  const refusedBefore = useRefusedOn(connection, "watch", [subscription]);
  const [failedFor, setFailedFor] = useState<string | null>(null);
  // Read synchronously, so a burst of failures reports once.
  const failed = useRef<string | null>(null);

  const onError = useCallback(
    (message: string) => {
      if (failed.current === subscription) return;
      failed.current = subscription;
      setFailedFor(subscription);
      const refused = isRefusal(message);
      if (refused) {
        const read = readOf("watch", [subscription]);
        if (read !== null) noteRefusal(read, message, currentConnection());
      }
      if (typeof reportFailure === "function") {
        reportFailure(message);
        return;
      }
      // A refused watch is the list's own refusal, which the page states.
      if (refused) return;
      toast({
        title: t("action", "realtimeUnavailable"),
        description: t("action", "fallingBackToPolling", {
          title: reportFailure,
        }),
      });
    },
    [reportFailure, subscription, t, toast]
  );
  const onRecovered = useCallback(() => {
    failed.current = null;
    setFailedFor(null);
  }, []);

  const { resyncing } = useResourceWatch<T>({
    enabled: enabled && !refusedBefore,
    subscribe,
    queryKey,
    detail,
    onError,
    onRecovered,
    order,
    recount,
    onChange,
  });

  const watchFailed = refusedBefore || failedFor === subscription;
  const live = enabled && !watchFailed;
  useRegistered(useRecounting, subscription, live && recount !== false);
  useRegistered(useFeeding, subscription, live);
  return {
    live,
    refresh: live ? false : "resourceList",
    resyncing,
    watchFailed,
  };
}
