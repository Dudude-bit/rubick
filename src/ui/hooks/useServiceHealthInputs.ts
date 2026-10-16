import { useMemo } from "react";

import type { ServiceHealthInputs } from "@/generated/types";
import { useLiveQuery, type Freshness } from "@/hooks/useLiveQuery";
import { failedWhole, type Unread } from "@/lib/attention";
import { commands } from "@/lib/commands";
import { errorToShow } from "@/lib/error-utils";
import type { NamespaceBacking } from "@/lib/ingress-health";
import type { Known } from "@/lib/known";
import { queryKeys } from "@/lib/query-keys";
import type { RefreshRate } from "@/lib/refresh";

export interface ServiceHealthRead {
  /** One namespace's Services by name, or why they were not read. */
  in: (namespace: string) => Known<NamespaceBacking>;
  /** Every namespace of the scope that has Services, as it answered. */
  answered: ServiceHealthInputs[];
  /** The namespaces that did not answer, the whole read if its latest look failed, or "reading". */
  unread: Unread[] | "reading";
  freshness: Pick<Freshness, "dataUpdatedAt" | "everyMs" | "slowRead">;
}

const NONE: NamespaceBacking = new Map();

/**
 * What every Service in `scope` publishes, cut to what its verdict reads and
 * read once for the scope (`null` is the cluster), so a count kept on every
 * screen does not carry each Service whole.
 */
export function useServiceHealthInputs(
  scope: string[] | null,
  {
    enabled = true,
    refresh = "slow",
  }: { enabled?: boolean; refresh?: RefreshRate } = {}
): ServiceHealthRead {
  const { data, error, freshness } = useLiveQuery({
    queryKey: queryKeys.serviceHealthInputs(scope),
    queryFn: () => commands.listServiceHealthInputs(scope),
    enabled,
    refresh,
  });

  const { dataUpdatedAt, everyMs, slowRead } = freshness;
  return useMemo(() => {
    const byNamespace = new Map<string, NamespaceBacking>(
      (data?.rows ?? []).map(({ namespace, groups, networks }) => [
        namespace,
        new Map(
          groups.flatMap((group) => {
            const read = { ...group, networks };
            return group.names.map((name) => [name, read] as const);
          })
        ),
      ])
    );
    const covers = (namespace: string) =>
      scope === null || scope.includes(namespace);
    return {
      answered: data?.rows ?? [],
      unread: error ? failedWhole(scope, error) : (data?.unread ?? "reading"),
      freshness: { dataUpdatedAt, everyMs, slowRead },
      in: (namespace) => {
        if (!data || !covers(namespace)) {
          return { known: false, why: error ? errorToShow(error) : null };
        }
        const lost = data.unread.find((entry) => entry.namespace === namespace);
        if (lost) return { known: false, why: lost.message };
        return { known: true, value: byNamespace.get(namespace) ?? NONE };
      },
    };
  }, [data, error, scope, dataUpdatedAt, everyMs, slowRead]);
}
