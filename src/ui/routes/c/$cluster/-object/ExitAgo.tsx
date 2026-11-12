import type { TerminationInfo } from "@/generated/types";
import { useRealtimeAge } from "@/hooks/useRealtimeAge";
import { useT } from "@/i18n/useT";
import {
  describeRestarts,
  describeTermination,
  terminationAt,
  type RestartsOf,
} from "@/lib/pod-status";

/**
 * How long ago a container last exited, "4m ago", moving with the clock:
 * the one reader of that age on every screen, and nothing where the kubelet
 * did not stamp it. A string formatted when the pod was read stayed "2s ago"
 * for minutes beside a Restarts row that ticked.
 */
export function ExitAgo({ termination }: { termination: TerminationInfo }) {
  const t = useT();
  const age = useRealtimeAge(termination.finishedAt);
  if (!termination.finishedAt) return null;
  return (
    <span title={terminationAt(termination)}>
      {t("action", "agoSuffix", { age })}
    </span>
  );
}

/** "Error · exit 1", then `between` and its age where it has one. */
export function ExitWords({
  termination,
  between,
}: {
  termination: TerminationInfo;
  between: string;
}) {
  return (
    <>
      {describeTermination(termination)}
      {termination.finishedAt && (
        <>
          {between}
          <ExitAgo termination={termination} />
        </>
      )}
    </>
  );
}

/** "72 restarts, last 1m ago", its age on the same clock as every exit's. */
export function RestartsWords({ pod }: { pod: RestartsOf }) {
  const t = useT();
  return <>{describeRestarts(pod, t, useRealtimeAge(pod.lastRestartAt))}</>;
}
