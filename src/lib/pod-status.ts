import type { T } from "@/i18n/useT";
import type {
  ContainerPhase,
  ContainerState,
  PodInfo,
  TerminationInfo,
} from "@/generated/types";
import { statusRole, type StatusRole } from "@/lib/status-role";
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

export interface ContainerStatus {
  /** The word, in the vocabulary the pod's own status column uses. */
  text: string;
  role: StatusRole;
}

/**
 * One container's state as a status, on the same terms the pod above it got
 * in `pod_display`.
 *
 * The Containers tab used to print the discriminant — `Running`, `Waiting ·
 * CrashLoopBackOff` — as an ordinary metadata value, so the most-read state
 * in the app was the only one with no glyph and no role, while readiness sat
 * apart from it as the word "ready" beside the heading. They are one fact:
 * a container that is running and failing its readiness probe is not
 * "Running", it is not ready, and that is what keeps the Service from
 * sending it traffic.
 */
export function containerStatus(container: {
  ready: boolean;
  state: ContainerState;
  /** When it runs. Absent for a spec template, which has no runtime at all. */
  phase?: ContainerPhase;
  lastTerminated?: TerminationInfo | null;
}): ContainerStatus {
  const { state } = container;
  switch (state.type) {
    case "running":
      return container.ready
        ? { text: "Running", role: "ok" }
        : { text: "Not ready", role: "warn" };
    case "waiting": {
      // `PodInitializing` on an init container that has never run is the
      // kubelet saying "not your turn", and printing its word for it
      // reads as though the container were coming up. It is queued
      // behind an earlier step, which may never finish.
      if (
        container.phase !== undefined &&
        container.phase !== "app" &&
        !container.lastTerminated &&
        state.reason === "PodInitializing"
      ) {
        return { text: "Never started", role: "pending" };
      }
      if (!state.reason) return { text: "Waiting", role: "pending" };
      const role = statusRole(state.reason);
      // Waiting is inherently a pending state, so a reason the role table
      // has never heard of — an operator's, a runtime's — falls back to
      // pending rather than to the neutral grey the table returns for it.
      return {
        text: state.reason,
        role: role === "neutral" ? "pending" : role,
      };
    }
    case "terminated": {
      const { termination } = state;
      if (termination.exitCode === 0 && termination.signal === null)
        return { text: termination.reason ?? "Completed", role: "neutral" };
      return { text: termination.reason ?? "Error", role: "err" };
    }
    default:
      return { text: "Unknown", role: "warn" };
  }
}

/** "653 restarts, last 4m ago" — the count on its own does not date itself. */
export function describeRestarts(
  pod: {
    restartCount: number;
    lastRestartAt: string | null;
  },
  t: T
): string {
  if (pod.restartCount === 0 || !pod.lastRestartAt) {
    return t("count", "restartsPlain", { n: pod.restartCount });
  }
  return t("count", "restartsWithLast", {
    n: pod.restartCount,
    ago: formatAge(pod.lastRestartAt),
  });
}
