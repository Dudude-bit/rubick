import { useCallback, useRef, useState } from "react";
import type { QueryKey } from "@tanstack/react-query";

import { useToast } from "@/components/ui/use-toast";
import { useResourceWatch } from "@/hooks/useResourceWatch";
import { useT } from "@/i18n/useT";

export interface WatchedList {
  /** The watch is running and feeding the cache. */
  live: boolean;
  /** What the list query polls at: nothing while live, the list rate otherwise. */
  refresh: false | "resourceList";
  resyncing: boolean;
  watchFailed: boolean;
}

/**
 * A list kept current by a watch, and polled whenever it is not.
 *
 * A refused or broken watch falls back to polling and says so once; a
 * recovered one stops the polling again. `enabled` is whether a watch can
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
  reportFailure,
}: {
  enabled: boolean;
  subscribe: () => Promise<string>;
  queryKey: QueryKey;
  reportFailure: string | ((message: string) => void);
}): WatchedList {
  const t = useT();
  const { toast } = useToast();
  // Which subscription failed, not whether one did: a new scope is a new
  // stream, and a failure held over from the last one kept a healthy list
  // polling with nothing left to clear it.
  const subscription = JSON.stringify(queryKey);
  const [failedFor, setFailedFor] = useState<string | null>(null);
  // Read synchronously, so a burst of failures reports once.
  const failed = useRef<string | null>(null);

  const onError = useCallback(
    (message: string) => {
      if (failed.current === subscription) return;
      failed.current = subscription;
      setFailedFor(subscription);
      if (typeof reportFailure === "function") {
        reportFailure(message);
        return;
      }
      toast({
        title: t("action", "realtimeUnavailable"),
        description: t("action", "fallingBackToPolling", {
          title: reportFailure,
          error: message,
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
    enabled,
    subscribe,
    queryKey,
    onError,
    onRecovered,
  });

  const watchFailed = failedFor === subscription;
  const live = enabled && !watchFailed;
  return {
    live,
    refresh: live ? false : "resourceList",
    resyncing,
    watchFailed,
  };
}
