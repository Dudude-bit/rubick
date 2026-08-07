import type { PodInfo, TerminationInfo } from "@/generated/types";
import { formatAge, formatDate } from "@/lib/utils";

/**
 * What the app says about a pod, and about a container that has died.
 *
 * The status itself is derived in Rust — see `resources::types::pod_display`,
 * which is a port of kubectl's `printPod`. What is left for the frontend is
 * phrasing: the same termination has to read the same way in the Containers
 * tab, in the log pane's stream-ended notice and beside a restart count, and
 * three hand-written versions of "exit 1 · Error" is how they drift apart.
 */

/** "Error · exit 1", "OOMKilled · signal 9", "exit 137". */
export function describeTermination(termination: TerminationInfo): string {
  const how =
    termination.signal !== null
      ? `signal ${termination.signal}`
      : `exit ${termination.exitCode}`;
  return termination.reason ? `${termination.reason} · ${how}` : how;
}

/** "4m ago", or nothing when the API did not stamp the termination. */
export function terminationWhen(termination: TerminationInfo): string | null {
  if (!termination.finishedAt) return null;
  return `${formatAge(termination.finishedAt)} ago`;
}

/** The wall-clock stamp, for a `title` beside the relative age. */
export function terminationAt(
  termination: TerminationInfo
): string | undefined {
  return formatDate(termination.finishedAt) ?? undefined;
}

/**
 * A container's last death, whether it is the one it is in now or the one
 * it is backing off from. A crash-looping container is *waiting*; its exit
 * code only exists in `lastTerminated`.
 */
export function lastTermination(container: {
  state: PodInfo["containers"][number]["state"];
  lastTerminated: TerminationInfo | null;
}): TerminationInfo | null {
  if (container.state.type === "terminated") return container.state.termination;
  return container.lastTerminated;
}

/** "653 restarts, last 4m ago" — the count on its own does not date itself. */
export function describeRestarts(pod: {
  restartCount: number;
  lastRestartAt: string | null;
}): string {
  const label = `${pod.restartCount} ${pod.restartCount === 1 ? "restart" : "restarts"}`;
  if (pod.restartCount === 0 || !pod.lastRestartAt) return label;
  return `${label}, last ${formatAge(pod.lastRestartAt)} ago`;
}
