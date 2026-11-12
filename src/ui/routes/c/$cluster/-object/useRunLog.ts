import { useQuery } from "@tanstack/react-query";

import type { ContainerInfo } from "@/generated/types";
import { commands } from "@/lib/commands";
import { readsPreviousRun } from "@/lib/container-sequence";
import { ERROR_CODES, errorCode } from "@/lib/error-utils";
import { lastTermination } from "@/lib/pod-status";
import { queryKeys } from "@/lib/query-keys";

/** What the node holds of the run that ended a container's last attempt. */
export type RunLog = "asking" | "kept" | "empty" | "gone" | "unread";

const DROPPED = new Set<string | null>([
  ERROR_CODES.LOG_NOT_KEPT,
  ERROR_CODES.NO_PREVIOUS_RUN,
]);

/** One line of that run's log, asked of the node: the answer the Logs tab will get. */
export function useRunLog(
  pod: string,
  namespace: string,
  container: ContainerInfo
): RunLog {
  const previous = readsPreviousRun(container);
  const query = useQuery({
    queryKey: queryKeys.runLog(
      namespace,
      pod,
      container.name,
      previous,
      lastTermination(container)?.finishedAt ?? null
    ),
    queryFn: () =>
      commands.getPodLogs(pod, namespace, container.name, 1, null, previous),
    staleTime: 60_000,
    retry: false,
  });
  if (query.isPending) return "asking";
  if (query.isError)
    return DROPPED.has(errorCode(query.error)) ? "gone" : "unread";
  return query.data.length > 0 ? "kept" : "empty";
}
