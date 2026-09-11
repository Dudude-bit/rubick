/**
 * Whether anything is keeping this context's credentials alive, and the
 * moment they are replaced.
 *
 * `useRenewals` is the counter every long-running read watches so it can
 * start again on the new client. `useRenewal` is what a surface shows.
 */

import { useEffect, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";

import { commands } from "@/lib/commands";
import {
  credentialsRenewed,
  credentialsRestored,
  readRenewals,
  subscribeToRenewals,
} from "@/lib/credentials";
import { useClusterStore } from "@/stores/clusterStore";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import type { Renewal } from "@/generated/types";

/** Installed once, by the shell. Everything else only reads the count. */
export function useWatchForRenewals(): void {
  useEffect(() => {
    const pending = listen<{ context: string }>(
      "credentials-renewed",
      (event) => {
        credentialsRenewed();
        // The same proof of a live session a connect is, and the refusal
        // screen is a takeover only a connect used to lift: a laptop wakes,
        // the first read takes a `401`, the renewal lands a second later.
        if (
          event.payload.context === useClusterStore.getState().currentContext
        ) {
          credentialsRestored();
        }
      }
    );
    return () => {
      void pending.then((off) => off());
    };
  }, []);
}

export function useRenewals(): number {
  return useSyncExternalStore(subscribeToRenewals, readRenewals);
}

export function useRenewal(): Renewal {
  const { isConnected, currentContext } = useClusterStore();
  // Re-asked after every renewal: that is when the answer moves.
  const renewals = useRenewals();

  const { data } = useLiveQuery({
    queryKey: ["credential-renewal", currentContext, renewals],
    queryFn: async () => {
      if (!currentContext) return "unknown";
      return await commands.credentialRenewal(currentContext);
    },
    enabled: isConnected && !!currentContext,
    // A renewal that needed a person moves this with no event to hang it on.
    refresh: "steady",
  });

  return data ?? "unknown";
}
