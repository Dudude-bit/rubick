import { useEffect, useRef } from "react";

import { useNamespaceList } from "@/hooks/useClusterSummary";
import { seedScope } from "@/lib/namespace-scope";
import { openNamespacePicker } from "@/lib/read-deadline";
import { useClusterStore } from "@/stores/clusterStore";
import { useNamespaceRecencyStore } from "@/stores/namespaceRecencyStore";

/**
 * A token refused the namespace list is almost always refused the whole
 * cluster too, so "All namespaces" is a wall of 403s for it. Once per
 * connection, a window arriving there is moved to the namespace it can name
 * (the kubeconfig's, else the last one used), or asked to type one.
 */
export function useRefusedScope(): void {
  const { state } = useNamespaceList();
  const attempt = useClusterStore((s) => s.connectionAttemptId);
  const handled = useRef<number | null>(null);

  useEffect(() => {
    if (state !== "refused" || handled.current === attempt) return;
    handled.current = attempt;
    const cluster = useClusterStore.getState();
    const context = cluster.currentContext;
    if (!context || cluster.namespaceScope.length > 0) return;
    const named = cluster.contexts.find((c) => c.name === context)?.namespace;
    const [fallback] = [
      ...seedScope(named),
      ...(useNamespaceRecencyStore.getState().recent[context] ?? []),
    ];
    if (fallback) void cluster.setNamespaceScope([fallback]);
    else openNamespacePicker();
  }, [state, attempt]);
}
