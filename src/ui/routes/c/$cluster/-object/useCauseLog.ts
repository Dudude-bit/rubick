import { useQuery } from "@tanstack/react-query";

import type { Evidence, PodCause } from "@/generated/types";
import { commands } from "@/lib/commands";
import {
  ERROR_CODES,
  errorCode,
  errorToShow,
  isRefusal,
} from "@/lib/error-utils";
import { tellingLine } from "@/lib/pod-cause";
import { queryKeys } from "@/lib/query-keys";

const LINES = 20;

const DROPPED = new Set<string | null>([
  ERROR_CODES.LOG_NOT_KEPT,
  ERROR_CODES.NO_PREVIOUS_RUN,
]);

/**
 * The cause with the last words of the run it names, asked of the node once
 * per exit: a page or peek showing the cause reads 20 lines, keyed by when
 * the run ended, so a poll or a watch tick asks nothing again. Lists and the
 * Overview do not call this; they quote the termination message only.
 */
export function useCauseLog(
  pod: { name: string; namespace: string },
  cause: PodCause | null
): PodCause | null {
  const exits = cause?.says === "exits" ? cause : null;
  const run = exits?.run ?? null;
  const wanted = !!run && !run.said;
  const query = useQuery({
    queryKey: queryKeys.runTail(
      pod.namespace,
      pod.name,
      exits?.container ?? "",
      run?.previous ?? false,
      run?.ended ?? null
    ),
    queryFn: () =>
      commands.getPodLogs(
        pod.name,
        pod.namespace,
        exits!.container,
        LINES,
        null,
        run!.previous
      ),
    enabled: wanted,
    staleTime: Infinity,
    retry: false,
  });
  if (!exits || !run || !wanted) return cause;
  return { ...exits, run: { ...run, log: evidenceOf(query) } };
}

function evidenceOf(query: {
  isPending: boolean;
  error: unknown;
  data: { raw: string; message: string }[] | undefined;
}): Evidence {
  if (query.error) {
    if (DROPPED.has(errorCode(query.error))) return { says: "gone" };
    if (isRefusal(query.error)) return { says: "refused" };
    return { says: "failed", said: errorToShow(query.error) };
  }
  if (query.isPending || !query.data) return { says: "reading" };
  const line = tellingLine(
    query.data.map((each) => each.message || each.raw).join("\n")
  );
  return line ? { says: "line", ...line } : { says: "nothing" };
}
