import { useMemo } from "react";

import type { ServiceHealthInputs } from "@/generated/types";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import type { Unread } from "@/lib/attention";
import { commands } from "@/lib/commands";
import { errorCode, errorToShow } from "@/lib/error-utils";
import type { NamespaceBacking } from "@/lib/ingress-health";
import type { Known } from "@/lib/known";
import { queryKeys } from "@/lib/query-keys";
import type { RefreshRate } from "@/lib/refresh";

export interface ServiceHealthRead {
  /** One namespace's Services by name, or why they were not read. */
  in: (namespace: string) => Known<NamespaceBacking>;
  /** Every namespace of the scope that has Services, as it answered. */
  answered: ServiceHealthInputs[];
  /** The namespaces that did not answer, or the whole read while it has not. */
  unread: Unread[] | "reading";
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
  const { data, error } = useLiveQuery({
    queryKey: queryKeys.serviceHealthInputs(scope),
    queryFn: () => commands.listServiceHealthInputs(scope),
    enabled,
    refresh,
  });

  return useMemo(() => {
    const byNamespace = new Map<string, NamespaceBacking>(
      (data?.rows ?? []).map(({ namespace, groups }) => [
        namespace,
        new Map(
          groups.flatMap((group) =>
            group.names.map((name) => [name, group] as const)
          )
        ),
      ])
    );
    const covers = (namespace: string) =>
      scope === null || scope.includes(namespace);
    return {
      answered: data?.rows ?? [],
      unread: data
        ? data.unread
        : error
          ? [
              {
                namespace: null,
                code: errorCode(error),
                message: errorToShow(error),
              },
            ]
          : "reading",
      in: (namespace) => {
        if (!data || !covers(namespace)) {
          return { known: false, why: error ? errorToShow(error) : null };
        }
        const lost = data.unread.find((entry) => entry.namespace === namespace);
        if (lost) return { known: false, why: lost.message };
        return { known: true, value: byNamespace.get(namespace) ?? NONE };
      },
    };
  }, [data, error, scope]);
}
