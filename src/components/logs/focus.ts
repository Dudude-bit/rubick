import type { ContainerInfo } from "@/generated/types";
import { containerFailed } from "@/lib/container-sequence";

/**
 * Which container the viewer opens on, and which run of it.
 *
 * The pane used to open on every container's current run, which is the
 * right answer for a healthy pod and no answer at all for the one case
 * anybody opens Logs for. A pod in `Init:CrashLoopBackOff` has an app
 * container that has never started, so "show everything" showed an empty
 * pane while the log that says why sat one container and one run away.
 *
 * Two narrowings, and both of them are announced. A filter the reader
 * did not set and cannot see is a lie about how much log there is — the
 * pane says which one it applied and offers the way back.
 */

export type FocusReason =
  /** The pod is held in init and this is the step holding it. */
  | { kind: "failing-init"; container: string; previous: boolean }
  /** Opened here by name, on a run that is not the current one. */
  | { kind: "previous-run"; container: string }
  /** Finished init logs kept out of a live pod's stream. */
  | { kind: "phase-split"; containers: string[] };

export interface LogFocus {
  /** Containers held out of the initial view. Their streams still run. */
  hidden: ReadonlySet<string>;
  /** Whether to open on the run before the current one. */
  previous: boolean;
  reason: FocusReason | null;
}

const NOTHING_HIDDEN: LogFocus = {
  hidden: new Set(),
  previous: false,
  reason: null,
};

/**
 * A container that is *waiting* is backing off from a death whose output
 * belongs to the run before this one: the current run has printed
 * nothing yet and may not have started at all. A container that is
 * terminated is still sitting on the output that killed it.
 */
function readsPreviousRun(container: ContainerInfo): boolean {
  return (
    container.lastTerminated !== null && container.state.type !== "terminated"
  );
}

function only(
  containers: readonly ContainerInfo[],
  name: string
): ReadonlySet<string> {
  return new Set(containers.filter((c) => c.name !== name).map((c) => c.name));
}

export function initialFocus(
  containers: readonly ContainerInfo[],
  /** A container the reader asked for by name, from the Containers tab. */
  requested?: string | null
): LogFocus {
  const asked = requested
    ? containers.find((c) => c.name === requested)
    : undefined;
  if (asked) {
    const previous = readsPreviousRun(asked);
    return {
      hidden: only(containers, asked.name),
      previous,
      // Which containers are shown is visible in the legend, which is
      // the control the reader just used by proxy. Which *run* is
      // visible nowhere, so only that gets a sentence.
      reason: previous ? { kind: "previous-run", container: asked.name } : null,
    };
  }

  const init = containers.filter((c) => c.phase === "init");

  // The first init container that is failing is the whole story: nothing
  // after it has run, so every other container in the pod is either
  // finished or empty.
  const blocking = init.find(containerFailed);
  if (blocking) {
    const previous = readsPreviousRun(blocking);
    return {
      hidden: only(containers, blocking.name),
      previous,
      reason: { kind: "failing-init", container: blocking.name, previous },
    };
  }

  // Init containers that finished wrote their lines minutes before
  // anything else in the buffer. Interleaved they sit at the very top
  // and never move, and the newest thing they say is older than the
  // oldest app line — a timeline that teaches the wrong thing.
  const finished = init.filter((c) => c.state.type === "terminated");
  const live = containers.filter((c) => c.phase !== "init");
  if (finished.length > 0 && live.length > 0) {
    return {
      hidden: new Set(finished.map((c) => c.name)),
      previous: false,
      reason: { kind: "phase-split", containers: finished.map((c) => c.name) },
    };
  }

  return NOTHING_HIDDEN;
}
