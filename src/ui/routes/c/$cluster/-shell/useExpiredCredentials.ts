/**
 * Whether this window's session has been refused, as a React value.
 *
 * The state itself lives in `lib/credentials.ts` — outside React, because the
 * thing that notices is `lib/commands.ts`, which every Tauri call already
 * passes through. This is the subscription, and the one rule on top of it:
 * leaving a cluster clears it, because a refusal belongs to the session that
 * earned it and carrying it to the next one would lock a working cluster out.
 */

import { useEffect, useSyncExternalStore } from "react";

import {
  credentialsRestored,
  readExpiredCredentials,
  subscribeToCredentials,
  type ExpiredCredentials,
} from "@/lib/credentials";
import { useClusterStore } from "@/stores/clusterStore";

export function useExpiredCredentials(): ExpiredCredentials | null {
  const context = useClusterStore((state) => state.currentContext);
  const expired = useSyncExternalStore(
    subscribeToCredentials,
    readExpiredCredentials
  );

  useEffect(() => {
    // Switching clusters, or connecting again, is a new session. Anything the
    // old one was refused for says nothing about this one.
    credentialsRestored();
  }, [context]);

  return expired;
}
