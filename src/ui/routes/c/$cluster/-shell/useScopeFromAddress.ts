import { useEffect } from "react";
import { useParams } from "@tanstack/react-router";

import { useAppSearch, useSetSearch } from "@/hooks/useSearchParam";
import { useClusterStore } from "@/stores/clusterStore";

/**
 * An address naming a namespace scopes the window to it once this cluster is
 * the one connected, and leaves the address, so the scope is the reader's to
 * change from there.
 */
export function useScopeFromAddress(): void {
  const { namespace } = useAppSearch();
  const { cluster } = useParams({ strict: false });
  const here = useClusterStore(
    (s) => s.isConnected && s.currentContext === cluster
  );
  const setSearch = useSetSearch();
  useEffect(() => {
    if (!namespace || !here) return;
    void useClusterStore.getState().setNamespaceScope([namespace]);
    setSearch({ namespace: undefined });
  }, [namespace, here, setSearch]);
}
