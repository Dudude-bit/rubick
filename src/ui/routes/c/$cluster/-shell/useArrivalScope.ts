import { useEffect, useRef } from "react";
import { useRouterState } from "@tanstack/react-router";

import { useClusterStore } from "@/stores/clusterStore";
import type { Arrival } from "@/stores/deepLinkStore";

/** A link to an object outside the scope moves the scope to its namespace, as a tab opened at an object does. */
export function useArrivalScope(arrival: Arrival | null, landed: boolean) {
  const namespace = useRouterState({
    select: (s) =>
      (s.matches.at(-1)?.params as { namespace?: string } | undefined)
        ?.namespace ?? null,
  });
  const applied = useRef<Arrival | null>(null);
  useEffect(() => {
    if (arrival?.status !== "live" || !landed || !namespace) return;
    if (applied.current === arrival) return;
    applied.current = arrival;
    const { namespaceScope, setNamespaceScope } = useClusterStore.getState();
    if (namespaceScope.length > 0 && !namespaceScope.includes(namespace))
      void setNamespaceScope([namespace]);
  }, [arrival, landed, namespace]);
}
