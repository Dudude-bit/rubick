import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { listenEvent } from "@/lib/events";
import { queryKeys } from "@/lib/query-keys";
import { useClusterStore } from "@/stores/clusterStore";

/**
 * Installed once, by the shell. The backend looks at the kubeconfig while
 * the app runs and says which contexts' entries changed; a connected one
 * was built from the old entry and goes on dialling a cluster that may be
 * gone, so it is connected again from the new one.
 */
export function useWatchForKubeconfig(): void {
  const client = useQueryClient();
  useEffect(() => {
    const pending = listenEvent("kubeconfig-changed", (event) => {
      void client.invalidateQueries({ queryKey: queryKeys.contexts() });
      void client.invalidateQueries({ queryKey: ["kubeconfig-source"] });
      void useClusterStore.getState().entriesChanged(event.payload.changed);
    });
    return () => {
      void pending.then((off) => off());
    };
  }, [client]);
}
