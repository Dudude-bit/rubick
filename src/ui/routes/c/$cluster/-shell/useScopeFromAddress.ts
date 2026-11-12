import { useEffect, useRef } from "react";
import { useParams, useRouterState } from "@tanstack/react-router";

import { useAppSearch, useSetSearch } from "@/hooks/useSearchParam";
import { namespaceShownBy } from "@/lib/links";
import { sameScope, scopeShowing } from "@/lib/namespace-scope";
import { useClusterStore } from "@/stores/clusterStore";
import { useScopeTabStore } from "@/stores/scopeTabStore";

/**
 * An address naming a namespace scopes the window to it once this cluster is
 * the one connected, and leaves the address, so the scope is the reader's to
 * change from there. An address showing one object outside the scope moves
 * the scope to the object's namespace on arrival, the way a tab opened at an
 * object lands, so the tab and the breadcrumb name the same namespace.
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

  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const activeId = useScopeTabStore((s) => s.activeId);
  const settled = useScopeTabStore((s) => s.pendingHref === null);
  const arrived = useRef<string | null>(null);
  useEffect(() => {
    if (!here || !settled) return;
    const at = `${activeId}\n${pathname}`;
    if (arrived.current === at) return;
    arrived.current = at;
    const { namespaceScope, setNamespaceScope } = useClusterStore.getState();
    const scope = scopeShowing(namespaceScope, namespaceShownBy(pathname));
    if (!sameScope(scope, namespaceScope)) void setNamespaceScope(scope);
  }, [here, settled, activeId, pathname]);
}
