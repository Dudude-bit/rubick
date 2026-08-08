import type {
  ContainerInfo,
  ContainerPhase,
  ContainerPortInfo,
} from "@/generated/types";
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
 * A pod, as far as anything asking about its containers is concerned.
 *
 * Every helper below takes *this*, never one of the two lists. That is
 * deliberate and it is the guard: `podReadiness(pod.containers)` does not
 * compile, because a `ContainerInfo[]` has no `.containers`. Reading
 * `.containers` alone is the whole bug class, and the only way to stop it
 * coming back is to make the wrong argument a type error rather than a
 * convention somebody has to remember.
 */
export interface PodContainerLists {
  initContainers?: ContainerInfo[];
  containers: ContainerInfo[];
}

/**
 * Every container the pod ran, in the order it ran them.
 *
 * The two lists are separate on the wire because they are separate in
 * the API object, and every consumer that wants "the pod's containers"
 * wants them concatenated in this order — a viewer handed only
 * `.containers` is the bug this whole piece exists to fix.
 */
export function podContainers(pod: PodContainerLists): ContainerInfo[] {
  return [...(pod.initContainers ?? []), ...pod.containers];
}

/**
 * App containers first, then sidecars, then the rest.
 *
 * Run order is right when the question is "what happened" — it is what
 * explains a container that never got a turn. It is wrong when the
 * question is "which one do you mean", because the answer a reader wants
 * offered first is their own container, not the mesh proxy that was
 * injected into their pod without them asking.
 */
const PHASE_ORDER: Record<ContainerPhase, number> = {
  app: 0,
  sidecar: 1,
  init: 2,
};

function byPhase(a: ContainerInfo, b: ContainerInfo): number {
  return PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase];
}

/**
 * The containers that are meant to be up for as long as the pod is.
 *
 * App containers and sidecars, and nothing else: a sidecar is an init
 * container with `restartPolicy: Always`, which means it starts during
 * init and then keeps running beside the app. An ordinary init container
 * has exited by the time anyone is looking, so counting it as part of the
 * pod, forwarding to a port it declared, or offering it as a debug target
 * all describe a process that is not there.
 *
 * This is the set kubectl means by a pod's containers in `READY`, and the
 * spine of every helper under it.
 */
export function lifetimeContainers(pod: PodContainerLists): ContainerInfo[] {
  return [
    ...pod.containers,
    ...(pod.initContainers ?? []).filter((c) => c.phase === "sidecar"),
  ];
}

export interface PodReadiness {
  ready: number;
  total: number;
  /** What decides whether the tally is worth a warning colour. */
  allReady: boolean;
}

/**
 * `2/2` — the number in kubectl's READY column, derived the way kubectl
 * derives it.
 *
 * Ported from `printPod` in `pkg/printers/internalversion/printers.go`,
 * which is also where `pod_display.rs` gets the status beside it. Two
 * rules that a naive tally gets backwards, and both bite on every pod in
 * a service mesh:
 *
 * - A restartable init container — a sidecar — counts in *both* halves.
 *   `sidecar-demo` is one app container plus one sidecar and kubectl
 *   reports it `2/2`, not `1/1` and not `2/3`.
 * - An ordinary init container counts in neither, and this is the trap:
 *   the kubelet leaves `ready: true` on an init container that exited 0,
 *   so `[...init, ...app].filter(c => c.ready)` reads `3/3` on a pod
 *   kubectl calls `2/2`.
 *
 * kubectl's own numerator test is `Ready && State.Running != nil` for app
 * containers and `Started && Ready` for sidecars. `ContainerInfo` carries
 * no `started` — the kubelet only clears it below `ready`, so `ready` and
 * a running state stand in for both, and one predicate covers the two.
 */
export function podReadiness(pod: PodContainerLists): PodReadiness {
  const lifetime = lifetimeContainers(pod);
  const ready = lifetime.filter(
    (c) => c.ready && c.state.type === "running"
  ).length;
  return { ready, total: lifetime.length, allReady: ready === lifetime.length };
}

export interface PodPort {
  container: ContainerInfo;
  port: ContainerPortInfo;
}

/**
 * Every port something in this pod could actually be listening on.
 *
 * A sidecar's port is not a footnote — on a meshed pod it is the proxy
 * port, which is the one a forward is usually aimed at. It sits beside
 * the app's rather than in a section of its own; what it does not do is
 * come first, because the default a dialog fills in should be the port
 * the reader's own container declared.
 */
export function podPorts(pod: PodContainerLists): PodPort[] {
  return lifetimeContainers(pod)
    .sort(byPhase)
    .flatMap((container) =>
      container.ports.map((port) => ({ container, port }))
    );
}

/** Waiting reasons that mean "not yet", rather than "no". */
const NOT_STARTED = new Set([
  "podinitializing",
  "containercreating",
  "creating",
]);

/**
 * Why a shell cannot attach to this container, or nothing if it can.
 *
 * The one judgement about attachability in the app. A shell needs a live
 * process on the other end, which is a fact about the container's state
 * and not about which list it arrived in: a running sidecar takes a shell
 * exactly like an app container does, and a finished init container takes
 * one from nobody.
 *
 * It returns a reason rather than a boolean because the Shell chooser
 * keeps unattachable containers on the list, struck out and carrying it —
 * a container that silently is not on the list makes the reader wonder
 * whether they misremembered its name, and the answer to "why can I not
 * shell into `prepare`" is a fact about `prepare`, not an absence.
 */
export function whyNoShell(container: ContainerInfo): string | null {
  const { state } = container;
  if (state.type === "running") return null;
  if (state.type === "terminated") {
    return state.termination.exitCode === 0
      ? "finished, nothing to attach to"
      : `exited ${state.termination.exitCode}, nothing to attach to`;
  }
  if (state.type === "waiting") {
    const reason = state.reason ?? "";
    if (NOT_STARTED.has(reason.toLowerCase())) return "has not started";
    if (container.lastTerminated) return "not running between restarts";
    return reason ? `not running · ${reason}` : "not running";
  }
  return "state unknown, nothing to attach to";
}

/**
 * The containers a shell could attach to right now, best first.
 *
 * Not `lifetimeContainers`: an init container that is running at this
 * instant genuinely can take a shell, and during a long migration that is
 * the only shell in the pod worth having. The set is about what is alive
 * now, which is why it is `whyNoShell` that decides it and not `phase`.
 */
export function shellTargets(pod: PodContainerLists): ContainerInfo[] {
  return podContainers(pod)
    .filter((c) => whyNoShell(c) === null)
    .sort(byPhase);
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
