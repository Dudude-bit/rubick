import { useQuery } from "@tanstack/react-query";

import type { Evidence, PodCause, Warned } from "@/generated/types";
import { useLiveQuery } from "@/hooks/useLiveQuery";
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
 * The cause with the evidence beyond the pod's own status, for a page or peek
 * that shows it: the last words of the run it names, asked of the node once
 * per exit, or the kubelet's warnings about a pod it has not set up, asked
 * again as they change. Lists do not call this, and the Overview's causes
 * arrive with the warnings it read.
 */
export function useCauseEvidence(
  pod: { name: string; namespace: string },
  cause: PodCause | null
): PodCause | null {
  const logged = useCauseLog(pod, cause);
  return useCauseWarnings(pod.namespace, logged);
}

function useCauseLog(
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

/** The kubelet's warnings about the pod a cause names, where nobody read them yet. */
export function useCauseWarnings(
  namespace: string,
  cause: PodCause | null
): PodCause | null {
  const creating =
    cause?.says === "creating" && cause.kubelet.says === "notRead"
      ? cause
      : null;
  const query = useLiveQuery({
    queryKey: queryKeys.setupWarnings(namespace, creating?.uid ?? ""),
    queryFn: () => commands.getPodSetupWarnings(namespace, creating!.uid),
    enabled: !!creating && !!namespace,
    refresh: "slow",
    retry: false,
  });
  if (!creating) return cause;
  return { ...creating, kubelet: warnedOf(query) };
}

function warnedOf(query: {
  isPending: boolean;
  error: unknown;
  data: Extract<Warned, { says: "read" }>["warnings"] | undefined;
}): Warned {
  if (query.data) return { says: "read", warnings: query.data };
  if (query.error)
    return isRefusal(query.error)
      ? { says: "refused" }
      : { says: "failed", said: errorToShow(query.error) };
  return { says: "reading" };
}

function evidenceOf(query: {
  isPending: boolean;
  error: unknown;
  data: { raw?: string | null; message: string }[] | undefined;
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
