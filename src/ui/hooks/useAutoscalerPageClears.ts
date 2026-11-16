import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import type { AutoscalerInfo, ConditionInfo, Scoped } from "@/generated/types";
import { autoscalerVerdict } from "@/lib/governance";
import { queryKeys } from "@/lib/query-keys";

const ASK_AGAIN_AFTER_MS = 10_000;

const conditionsOf = (object: unknown): ConditionInfo[] | null => {
  const found = (object as { status?: { conditions?: unknown } } | undefined)
    ?.status?.conditions;
  return Array.isArray(found) ? (found as ConditionInfo[]) : null;
};

/**
 * An autoscaler's page reads its own conditions every few seconds, while the
 * shell's count of what needs attention reads the scope's autoscalers once a
 * minute. When the page shows the finding gone and the shell's list still
 * holds it, ask that list again, so the count follows within a poll.
 */
export function useAutoscalerPageClears(
  object: unknown,
  readAt: number,
  name: string,
  namespace: string | null
) {
  const client = useQueryClient();
  const askedAt = useRef(0);
  useEffect(() => {
    const conditions = conditionsOf(object);
    if (!conditions || autoscalerVerdict({ conditions }) !== null) return;
    const held = client
      .getQueriesData<Scoped<AutoscalerInfo>>({
        queryKey: queryKeys.autoscalers().slice(0, 1),
      })
      .some(([, list]) =>
        list?.rows.some(
          ({ autoscaler }) =>
            autoscaler.name === name &&
            autoscaler.namespace === namespace &&
            autoscaler.facts?.kind === "autoscaler" &&
            autoscalerVerdict(autoscaler.facts) !== null
        )
      );
    if (!held || Date.now() - askedAt.current < ASK_AGAIN_AFTER_MS) return;
    askedAt.current = Date.now();
    void client.invalidateQueries({
      queryKey: queryKeys.autoscalers().slice(0, 1),
    });
  }, [client, object, readAt, name, namespace]);
}
