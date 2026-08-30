import type { T } from "@/i18n/useT";
import type {
  ContainerInfo,
  ContainerPhase,
  ContainerPortInfo,
  DeploymentContainerInfo,
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

/** The heading a phase gets, the same word for a run and a declaration. */
const GROUP_TITLE: Record<ContainerPhase, string> = {
  init: "Init",
  sidecar: "Sidecars",
  app: "Containers",
};

/** A container, or a declaration of one — anything that knows when it runs. */
interface Phased {
  phase: ContainerPhase;
}

/**
 * The two lists a pod object and a workload template both carry.
 *
 * Generic because the split is the same fact in both: `initContainers` is
 * a separate field in the API object, and everything already reading
 * `containers` means app containers by it. Taking *this* rather than an
 * array is what makes `podReadiness(pod.containers)` — and every other
 * form of the bug — a type error instead of a convention.
 */
export interface ContainerLists<T extends Phased> {
  initContainers?: T[];
  containers: T[];
}

export type PodContainerLists = ContainerLists<ContainerInfo>;
/** A Deployment, StatefulSet, DaemonSet, Job or CronJob's pod template. */
export type TemplateContainerLists = ContainerLists<DeploymentContainerInfo>;

/**
 * Both lists, in the order the kubelet runs them.
 *
 * The two are separate on the wire because they are separate in the API
 * object, and every consumer that wants "the containers of this thing"
 * wants them concatenated in this order — a caller handed only
 * `.containers` is the bug this whole piece exists to fix, on a pod and
 * on the five kinds that share one template type alike.
 */
export function declaredContainers<T extends Phased>(
  lists: ContainerLists<T>
): T[] {
  return [...(lists.initContainers ?? []), ...lists.containers];
}

function splitByPhase<T extends Phased>(containers: readonly T[]) {
  return {
    init: containers.filter((c) => c.phase === "init"),
    sidecars: containers.filter((c) => c.phase === "sidecar"),
    app: containers.filter((c) => c.phase === "app"),
  };
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

/** Every container the pod ran, in the order it ran them. */
export function podContainers(pod: PodContainerLists): ContainerInfo[] {
  return declaredContainers(pod);
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
 * The two halves are counted by different predicates because kubectl
 * counts them by different predicates: an app container is `Ready &&
 * State.Running`, a sidecar is `Started && Ready`. `started` is the
 * kubelet's startup-probe verdict and is its own field, which is why the
 * walk below reads it rather than standing a running state in for it.
 */
export function podReadiness(pod: PodContainerLists): PodReadiness {
  const total = lifetimeContainers(pod).length;
  const ready =
    pod.containers.filter((c) => c.ready && c.state.type === "running").length +
    startedSidecars(pod).length;
  return { ready, total, allReady: ready === total };
}

/**
 * The sidecars kubectl reaches before it gives up on the init sequence.
 *
 * `printPod` walks `initContainerStatuses` from the front and stops at
 * the first entry that neither exited 0 nor is a started sidecar — so a
 * sidecar declared *after* an init container that is still going has not
 * been reached, and does not count however ready it looks. Nothing on the
 * container itself says that; it is the position, exactly as it is in the
 * sequence UI.
 */
function startedSidecars(pod: PodContainerLists): ContainerInfo[] {
  const reached: ContainerInfo[] = [];
  for (const container of pod.initContainers ?? []) {
    if (containerSucceeded(container)) continue;
    if (container.phase !== "sidecar" || !container.started) break;
    if (container.ready) reached.push(container);
  }
  return reached;
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
export function whyNoShell(container: ContainerInfo, t: T): string | null {
  const { state } = container;
  if (state.type === "running") return null;
  if (state.type === "terminated") {
    return state.termination.exitCode === 0
      ? t("readings", "shellFinished")
      : t("readings", "shellExited", { code: state.termination.exitCode });
  }
  if (state.type === "waiting") {
    const reason = state.reason ?? "";
    if (NOT_STARTED.has(reason.toLowerCase()))
      return t("readings", "shellNotStarted");
    if (container.lastTerminated) return t("readings", "shellBetweenRestarts");
    return reason
      ? t("readings", "shellNotRunningWhy", { reason })
      : t("readings", "shellNotRunning");
  }
  return t("readings", "shellStateUnknown");
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
  // The reason is discarded — only its absence decides membership — so this
  // asks in no language rather than making every caller supply one.
  const noWords: T = () => "";
  return podContainers(pod)
    .filter((c) => whyNoShell(c, noWords) === null)
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
  blockedBy: string | null,
  t: T
): string | null {
  const phase = container.phase;

  if (mark === "failed") {
    const death = container.lastTerminated ?? null;
    const when = death ? terminationWhen(death, t) : null;
    if (container.restartCount > 0) {
      return t("readings", "logsAttemptsLast", {
        attempts: t("count", "attemptsCount", { n: container.restartCount }),
        when: when ? t("readings", "logsLastWhen", { when }) : "",
      });
    }
    return t("readings", "logsPrintedBeforeExit");
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
    const when = termination ? terminationWhen(termination, t) : null;
    // Said out loud because a finished container looks identical to a
    // silent one in a log pane, and Follow does nothing on either.
    return t("readings", "logsFinishedComplete", {
      took: took ? t("readings", "logsTook", { took }) : "",
      when: when ? t("readings", "logsWhen", { when }) : "",
    });
  }

  if (mark === "queued") {
    if (phase === "app") {
      return blockedBy
        ? t("readings", "logsNoneInitUnfinished")
        : t("readings", "logsNoneNotStarted");
    }
    return blockedBy && blockedBy !== container.name
      ? t("readings", "logsNeverRanBlocked", { on: blockedBy })
      : t("readings", "logsNeverRan");
  }

  if (mark === "running" && phase === "sidecar") {
    return t("readings", "logsSidecarRunning");
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
  containers: readonly ContainerInfo[],
  t: T
): ContainerGroup[] {
  const { init, sidecars, app } = splitByPhase(containers);

  // The first init container that has not succeeded is what everything
  // after it is waiting on — including the app containers.
  const blockedBy = init.find((c) => !containerSucceeded(c))?.name ?? null;

  const step = (container: ContainerInfo): ContainerStep => {
    const mark = markOf(container);
    return {
      container,
      mark,
      status: containerStatus(container),
      note: noteFor(container, mark, blockedBy, t),
    };
  };

  const groups: ContainerGroup[] = [];
  if (init.length > 0) {
    groups.push({
      phase: "init",
      title: GROUP_TITLE.init,
      caption: t("readings", "groupInitCaption"),
      steps: init.map(step),
    });
  }
  if (sidecars.length > 0) {
    groups.push({
      phase: "sidecar",
      title: GROUP_TITLE.sidecar,
      // Neither group: sidecars start during init and never finish, so
      // filing them with the init sequence would imply they completed
      // and filing them with the app containers would imply they
      // started at the same time.
      caption: t("readings", "groupSidecarCaption"),
      steps: sidecars.map(step),
    });
  }
  if (app.length > 0) {
    groups.push({
      phase: "app",
      title: GROUP_TITLE.app,
      caption:
        blockedBy !== null
          ? t("readings", "groupAppBlocked")
          : t("readings", "groupAppCaption"),
      steps: app.map(step),
    });
  }
  return groups;
}

export interface TemplateGroup {
  phase: ContainerPhase;
  title: string;
  caption: string;
  /** In the order the template declares them, which is the order they run. */
  containers: DeploymentContainerInfo[];
}

/**
 * The same three groups for a template, said in the tense a template
 * deserves.
 *
 * A declaration has no run to report, so there is no `ContainerStep`
 * here: no mark, no state badge, no "finished 3s ago". Position still
 * means something — the kubelet runs init containers in the order they
 * are written — and that is the one live-looking thing kept, because it
 * is a fact about the spec rather than about any pod made from it.
 *
 * The captions carry the whole difference between the two views. "started
 * during init and still running" is a claim about a process; the template
 * can only say what will happen when a pod is made, and saying more would
 * be the same class of lie as calling a queued container "never started".
 */
export function templateSequence(
  template: TemplateContainerLists,
  t: T
): TemplateGroup[] {
  const { init, sidecars, app } = splitByPhase(declaredContainers(template));

  const groups: TemplateGroup[] = [];
  if (init.length > 0) {
    groups.push({
      phase: "init",
      title: GROUP_TITLE.init,
      caption: t("readings", "groupInitCaptionEach"),
      containers: init,
    });
  }
  if (sidecars.length > 0) {
    groups.push({
      phase: "sidecar",
      title: GROUP_TITLE.sidecar,
      caption: t("readings", "groupSidecarCaptionEach"),
      containers: sidecars,
    });
  }
  if (app.length > 0) {
    groups.push({
      phase: "app",
      title: GROUP_TITLE.app,
      caption: t("readings", "groupAppCaptionEach"),
      containers: app,
    });
  }
  return groups;
}
