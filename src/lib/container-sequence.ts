import type { ContainerInfo, ContainerPhase } from "@/generated/types";
import {
  containerStatus,
  terminationWhen,
  type ContainerStatus,
} from "@/lib/pod-status";

/**
 * A pod's containers as the sequence they actually are.
 *
 * `phase` alone is not the story. An init container that is waiting has
 * not failed and is not starting — it has not been given a turn, and the
 * only thing that says so is its *position*: the one before it in the
 * list has not finished. A flat list of three containers with three
 * states cannot express that, which is why this exists between the data
 * and the rows rather than inside them.
 */

/** The silhouette a step gets on the rail. */
export type StepMark = "done" | "failed" | "running" | "queued";

/**
 * The word beside a container's name, where it changes what the name means.
 * An app container gets none: it is what a reader assumes a container is.
 */
export const PHASE_LABEL: Partial<Record<ContainerPhase, string>> = {
  init: "init",
  sidecar: "sidecar",
};

export interface ContainerStep {
  container: ContainerInfo;
  mark: StepMark;
  status: ContainerStatus;
  /** The one sentence the state on its own cannot say, or nothing. */
  note: string | null;
}

export interface ContainerGroup {
  phase: ContainerPhase;
  title: string;
  /** What the group is, for readers who have never met an init container. */
  caption: string;
  /** In run order for `init`, in spec order for the rest. */
  steps: ContainerStep[];
}

/** Terminated cleanly — the only outcome that lets the sequence advance. */
export function containerSucceeded(container: ContainerInfo): boolean {
  const { state } = container;
  return (
    state.type === "terminated" &&
    state.termination.exitCode === 0 &&
    state.termination.signal === null
  );
}

export function containerFailed(container: ContainerInfo): boolean {
  const { state } = container;
  if (state.type === "terminated") return !containerSucceeded(container);
  // A crash loop is a *waiting* state; the death it is backing off from
  // is only in `lastTerminated`, which is also the whole reason the
  // Containers tab could show "Waiting" for a container that has died
  // nine times.
  return state.type === "waiting" && container.lastTerminated !== null;
}

function markOf(container: ContainerInfo): StepMark {
  if (containerSucceeded(container)) return "done";
  if (containerFailed(container)) return "failed";
  if (container.state.type === "running") return "running";
  return "queued";
}

/**
 * Every container the pod ran, in the order it ran them.
 *
 * The two lists are separate on the wire because they are separate in
 * the API object, and every consumer that wants "the pod's containers"
 * wants them concatenated in this order — a viewer handed only
 * `.containers` is the bug this whole piece exists to fix.
 */
export function podContainers(pod: {
  initContainers?: ContainerInfo[];
  containers: ContainerInfo[];
}): ContainerInfo[] {
  return [...(pod.initContainers ?? []), ...pod.containers];
}

/** "4s", from the two stamps the kubelet writes on a finished run. */
export function runDuration(
  started: string | null,
  finished: string | null
): string | null {
  if (!started || !finished) return null;
  const from = Date.parse(started);
  const to = Date.parse(finished);
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return null;
  const seconds = Math.round((to - from) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function noteFor(
  container: ContainerInfo,
  mark: StepMark,
  /** The init container the sequence is currently stuck on, if any. */
  blockedBy: string | null
): string | null {
  const phase = container.phase;

  if (mark === "failed") {
    const death = container.lastTerminated ?? null;
    const when = death ? terminationWhen(death) : null;
    if (container.restartCount > 0) {
      return `${container.restartCount} ${
        container.restartCount === 1 ? "attempt" : "attempts"
      }${when ? `, last ${when}` : ""} — what the run that failed printed is in Logs.`;
    }
    return "What it printed before it exited is in Logs.";
  }

  if (mark === "done" && phase !== "app") {
    const { state } = container;
    const termination =
      state.type === "terminated"
        ? state.termination
        : container.lastTerminated;
    const took = termination
      ? runDuration(termination.startedAt, termination.finishedAt)
      : null;
    const when = termination ? terminationWhen(termination) : null;
    // Said out loud because a finished container looks identical to a
    // silent one in a log pane, and Follow does nothing on either.
    return `Finished${took ? ` in ${took}` : ""}${
      when ? `, ${when}` : ""
    } — its log is complete.`;
  }

  if (mark === "queued") {
    if (phase === "app") {
      return blockedBy
        ? "No logs yet — init has not finished."
        : "No logs yet — it has not started.";
    }
    return blockedBy && blockedBy !== container.name
      ? `Never ran — the sequence is still on ${blockedBy}.`
      : "Never ran.";
  }

  if (mark === "running" && phase === "sidecar") {
    return "Started during init and does not finish — the sequence went on once it was ready.";
  }

  return null;
}

/**
 * Group and annotate a pod's containers.
 *
 * Callers hand it `[...pod.initContainers, ...pod.containers]`: init
 * order is the payload and the backend already ships it, so this never
 * sorts.
 */
export function containerSequence(
  containers: readonly ContainerInfo[]
): ContainerGroup[] {
  const init = containers.filter((c) => c.phase === "init");
  const sidecars = containers.filter((c) => c.phase === "sidecar");
  const app = containers.filter(
    (c) => c.phase !== "init" && c.phase !== "sidecar"
  );

  // The first init container that has not succeeded is what everything
  // after it is waiting on — including the app containers.
  const blockedBy = init.find((c) => !containerSucceeded(c))?.name ?? null;

  const step = (container: ContainerInfo): ContainerStep => {
    const mark = markOf(container);
    return {
      container,
      mark,
      status: containerStatus(container),
      note: noteFor(container, mark, blockedBy),
    };
  };

  const groups: ContainerGroup[] = [];
  if (init.length > 0) {
    groups.push({
      phase: "init",
      title: "Init",
      caption: "run in order before the pod starts, each waiting on the last",
      steps: init.map(step),
    });
  }
  if (sidecars.length > 0) {
    groups.push({
      phase: "sidecar",
      title: "Sidecars",
      // Neither group: sidecars start during init and never finish, so
      // filing them with the init sequence would imply they completed
      // and filing them with the app containers would imply they
      // started at the same time.
      caption: "started during init and still running",
      steps: sidecars.map(step),
    });
  }
  if (app.length > 0) {
    groups.push({
      phase: "app",
      title: "Containers",
      caption:
        blockedBy !== null
          ? "never started — the pod is still in init"
          : "run together for the life of the pod",
      steps: app.map(step),
    });
  }
  return groups;
}
