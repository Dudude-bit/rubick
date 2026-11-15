import type { QueryClient } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import { absenceOf } from "@/lib/metrics-absence";
import { queryKeys } from "@/lib/query-keys";
import type { MetricsStatus } from "@/generated/types";

export function recheck(queryClient: QueryClient) {
  return commands
    .recheckMetrics()
    .finally(
      () =>
        void queryClient.refetchQueries({ queryKey: queryKeys.metrics.all() })
    );
}

export function metricsAbsent(queryClient: QueryClient): boolean {
  return queryClient
    .getQueryCache()
    .findAll({ queryKey: queryKeys.metrics.all() })
    .some(
      (query) =>
        absenceOf(
          (query.state.data as { status?: MetricsStatus } | undefined)?.status
        ) !== null
    );
}
