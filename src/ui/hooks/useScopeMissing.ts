import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useNamespaceList } from "@/hooks/useClusterSummary";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";
import { ResourceType } from "@/lib/resource-registry";
import { useClusterStore } from "@/stores/clusterStore";

export interface ScopeMissing {
  /** The scope's namespaces a list of namespaces read after it was chosen does not have. */
  missing: readonly string[];
  /** Every namespace of the scope is missing: nothing scoped to it has anything to show. */
  whole: boolean;
  /** Every name of the scope is one the cached list lacks, asked about again: neither there nor missing yet. */
  checking: boolean;
}

const NONE: readonly string[] = [];

/** What a part of the shell drawn on its own is told: nothing is missing. */
export const NOTHING_MISSING: ScopeMissing = {
  missing: NONE,
  whole: false,
  checking: false,
};

/**
 * The namespaces the window is scoped to that the cluster does not have.
 *
 * Only a list of namespaces can say so, and only one read after the name was
 * chosen: the cached list may predate a namespace made a minute ago. Where the
 * list was refused or failed, nothing is called missing; the reads of the
 * scope itself say what they could not see.
 */
export function useScopeMissing(): ScopeMissing {
  const scope = useClusterStore((s) => s.namespaceScope);
  const isConnected = useClusterStore((s) => s.isConnected);
  const client = useQueryClient();
  const list = useNamespaceList();
  const cached = list.state === "listed" ? list.data : undefined;
  const unlisted = useMemo(() => {
    if (!cached) return NONE;
    const names = new Set(cached.map((ns) => ns.name));
    const absent = scope.filter((name) => !names.has(name));
    return absent.length > 0 ? absent : NONE;
  }, [cached, scope]);

  const check = useLiveQuery({
    queryKey: queryKeys.namespacesAbsent(unlisted),
    queryFn: async () => {
      const names = new Set(
        (await commands.listNamespaces()).map((ns) => ns.name)
      );
      const absent = unlisted.filter((name) => !names.has(name));
      // One of them exists after all: the cached list is the stale one.
      if (absent.length < unlisted.length)
        void client.invalidateQueries({
          queryKey: queryKeys.resources(ResourceType.Namespace, null),
          exact: true,
        });
      return absent;
    },
    enabled: isConnected && unlisted.length > 0,
    refresh: "steady",
    retry: false,
  });

  return useMemo(() => {
    const missing =
      unlisted.length > 0 && check.data && check.data.length > 0
        ? check.data
        : NONE;
    return {
      missing,
      whole: missing.length > 0 && missing.length === scope.length,
      checking:
        unlisted.length === scope.length &&
        unlisted.length > 0 &&
        check.data === undefined &&
        !check.error,
    };
  }, [unlisted, check.data, check.error, scope.length]);
}
