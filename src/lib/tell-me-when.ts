import { sayWords, type Saying } from "@/i18n/say";
import type { T } from "@/i18n/useT";
import type {
  CustomResourceInfo,
  DaemonSetInfo,
  DeploymentInfo,
  JobInfo,
  PodInfo,
  StatefulSetInfo,
} from "@/generated/types";

/**
 * "Tell me when": one object, one question, one answer.
 *
 * Not alerting. Nothing here scans a cluster; a watch exists because a
 * person pointed at one thing and asked, and it ends the moment it has an
 * answer. What it can answer is fixed by the kind, so the ask is implied by
 * the click and never configured.
 */

/** How many can be open on one cluster before adding asks which to drop. */
export const MAX_WATCHES_PER_CLUSTER = 12;
/** A question nobody has answered in a day is no longer being waited on. */
export const WATCH_TTL_MS = 24 * 60 * 60 * 1000;
/** Answers arriving this close together go out as one notification. */
export const COALESCE_MS = 10_000;
/** A stream down this long is a fact worth reporting, not a hiccup. */
export const LOST_SIGHT_MS = 2 * 60 * 1000;

export type Ask =
  "rollout" | "podReady" | "jobOutcome" | "drain" | "renewed" | "forwardAlive";

export type WatchKind =
  | "Deployment"
  | "StatefulSet"
  | "DaemonSet"
  | "Pod"
  | "Job"
  | "Node"
  | "Certificate"
  | "PortForward";

/** Every kind answers exactly one question. */
export const ASK_OF: Record<WatchKind, Ask> = {
  Deployment: "rollout",
  StatefulSet: "rollout",
  DaemonSet: "rollout",
  Pod: "podReady",
  Job: "jobOutcome",
  Node: "drain",
  Certificate: "renewed",
  PortForward: "forwardAlive",
};

export type Says =
  | "rolledOut"
  | "rolloutFailed"
  | "ready"
  | "crashedAgain"
  | "succeeded"
  | "failed"
  | "drained"
  | "drainStopped"
  | "drainCancelled"
  | "drainFailed"
  | "renewed"
  | "issuanceFailed"
  | "forwardDied"
  | "gone"
  | "lostSight"
  | "timedOut";

export interface Verdict {
  says: Says;
  /**
   * What the answer carries under it: the cluster's own words as a string,
   * kept whole and never translated, or a sentence of ours as a `Saying`,
   * which becomes words in the reader's language at render. The two are
   * told apart by their type, because they are not the same kind of thing
   * and one of them was going out in English to every reader.
   */
  detail: string | Saying | null;
}

/**
 * The tone each verdict is shown in, total over `Says` so a new answer cannot
 * fall through to a default. Success is `bg-ok`, a real failure `bg-err`; an
 * ending that is neither — a drain the reader stopped, an object that merely
 * went away, a lost stream — is neutral or a caution, never red. This is the
 * honesty classification the third-state rule turns on; the tokens match
 * `status-role.ts`.
 */
export const SAYS_TONE: Record<Says, string> = {
  rolledOut: "bg-ok",
  rolloutFailed: "bg-err",
  ready: "bg-ok",
  crashedAgain: "bg-err",
  succeeded: "bg-ok",
  failed: "bg-err",
  drained: "bg-ok",
  drainStopped: "bg-warn",
  drainCancelled: "bg-fg-fnt",
  drainFailed: "bg-err",
  renewed: "bg-ok",
  issuanceFailed: "bg-err",
  forwardDied: "bg-err",
  gone: "bg-fg-fnt",
  lostSight: "bg-warn",
  // Out of time is not a failure: the action may have worked and the app
  // stopped being able to say. Red would call it broken.
  timedOut: "bg-warn",
};

/**
 * What the last look established, so the next one can tell movement from
 * standing still. A rollout already finished when asked about is not the
 * answer; the next one is.
 */
export interface Baseline {
  /** The ask has seen the object in motion, so settling now is an answer. */
  armed: boolean;
  restarts?: number;
  notAfter?: string | null;
  revision?: number;
  /** The spec generation at the first look, for a watch that follows an action. */
  generation?: number | null;
  /** The object was seen mid-rollout at least once. */
  unsettledSeen?: boolean;
  /** The last look, for a verdict that has to say what it saw. */
  seen?: Saying | null;
}

/**
 * The action a watch follows. "Did it work" is only ever answered after the
 * object confirmed the action reached it: a generation past the one before
 * the click, or the replica count the click asked for.
 */
export interface After {
  action: "restart" | "scale" | "apply" | "image";
  replicas: number | null;
  /** `metadata.generation` as the page saw it before the action; `null` when it did not know. */
  generationBefore: number | null;
  /**
   * When the reader asked, so a condition older than the question can be
   * told from one the question caused. Optional only because the callers
   * that cannot know the generation cannot always know this either.
   */
  askedAt?: number;
}

/** How long an action is given before "no answer" is the answer. */
export const OUTCOME_DEADLINE_MS = 2 * 60 * 1000;

/**
 * What a watch that ran out of time has to say. Both deadlines are two
 * minutes, so a watch whose stream went down races its own timeout, and
 * "no answer within two minutes" would be said about a window nobody
 * watched. A watch that lost sight knows why it has nothing, and says that.
 */
export function outOfTimeVerdict(watch: Watch): Verdict {
  return watch.status.state === "lost"
    ? { says: "lostSight", detail: null }
    : { says: "timedOut", detail: watch.baseline?.seen ?? null };
}

export type WatchStatus =
  | { state: "watching" }
  | { state: "lost"; since: number; told: boolean }
  | { state: "done"; verdict: Verdict; at: number }
  | { state: "expired" };

export interface Watch {
  id: string;
  context: string;
  kind: WatchKind;
  namespace: string | null;
  name: string;
  ask: Ask;
  startedAt: number;
  status: WatchStatus;
  baseline: Baseline | null;
  /** PortForward only: the session the question is about. */
  sessionId?: string;
  /** Certificate only: where the CRD is served. */
  crd?: { group: string; version: string; plural: string };
  after?: After | null;
  /** When "no answer" becomes the answer; `null` for a watch with the day-long default. */
  deadline?: number | null;
}

/**
 * A verdict's detail in words. The cluster's own string is handed back as
 * it was written; ours is a key and becomes the reader's language here.
 */
export function detailWords(
  detail: string | Saying | null | undefined,
  t: T
): string | null {
  if (detail === null || detail === undefined) return null;
  return typeof detail === "string" ? detail : sayWords(detail, t);
}

export function isOpen(watch: Watch): boolean {
  return watch.status.state === "watching" || watch.status.state === "lost";
}

export function watchKey(
  kind: string,
  namespace: string | null,
  name: string
): string {
  return `${kind}/${namespace ?? ""}/${name}`;
}

/** The kinds a peek row can ask about; the rest are asked from their own controls. */
export function askableKind(kind: string): WatchKind | null {
  switch (kind) {
    case "Deployment":
    case "StatefulSet":
    case "DaemonSet":
    case "Pod":
    case "Job":
      return kind;
    default:
      return null;
  }
}

export interface Judgement {
  verdict: Verdict | null;
  baseline: Baseline;
}

/**
 * What one look at the object says, given what the last look established.
 * Pure: the hook feeds it watch events and stores whatever comes back.
 */
export function judge(
  watch: Watch,
  op: "applied" | "deleted",
  resource: unknown
): Judgement {
  const was = watch.baseline ?? { armed: false };
  if (op === "deleted") {
    return { verdict: { says: "gone", detail: null }, baseline: was };
  }
  switch (watch.ask) {
    case "rollout":
      return watch.after
        ? judgeOutcome(watch.kind, resource, was, watch.after)
        : judgeRollout(watch.kind, resource, was);
    case "podReady":
      return judgePod(resource as PodInfo, was);
    case "jobOutcome":
      return judgeJob(resource as JobInfo);
    case "renewed":
      return judgeCertificate(resource as CustomResourceInfo, was);
    case "drain":
    case "forwardAlive":
      return { verdict: null, baseline: was };
  }
}

interface Rollout {
  settled: boolean;
  failed: string | null;
  /** When the failing condition last changed, as the cluster stamped it. */
  failedAt: number | null;
  desired: number;
  ready: number;
  generation: number | null;
  observedGeneration: number | null;
  /** The Deployment's revision counter, where the object carries one. */
  revision: string | null;
}

function rolloutOf(kind: WatchKind, resource: unknown): Rollout {
  if (kind === "Deployment") {
    const d = resource as DeploymentInfo;
    const r = d.replicas;
    const progressing = d.conditions.find((c) => c.type === "Progressing");
    const failed =
      progressing?.status === "False"
        ? (progressing.message ?? progressing.reason ?? "Progressing=False")
        : null;
    const failedAt =
      failed !== null && progressing?.lastTransitionTime
        ? (Date.parse(progressing.lastTransitionTime) ?? null)
        : null;
    return {
      settled:
        r.updated === r.desired &&
        r.available === r.desired &&
        r.ready === r.desired &&
        (progressing === undefined ||
          progressing.reason === "NewReplicaSetAvailable"),
      failed,
      failedAt: Number.isNaN(failedAt) ? null : failedAt,
      desired: r.desired,
      ready: r.ready,
      generation: d.generation ?? null,
      observedGeneration: d.observedGeneration ?? null,
      revision: d.annotations?.["deployment.kubernetes.io/revision"] ?? null,
    };
  }
  if (kind === "StatefulSet") {
    const s = resource as StatefulSetInfo;
    const r = s.replicas;
    return {
      // `updated` is what tells a finished rollout from one that has not
      // started: every other count is already at `desired` the instant the
      // template changes, and under `OnDelete` they stay there forever
      // while nothing rolls. The Deployment arm has always asked this.
      settled:
        r.ready === r.desired &&
        r.current === r.desired &&
        r.updated === r.desired,
      failed: null,
      failedAt: null,
      desired: r.desired,
      ready: r.ready,
      generation: s.generation ?? null,
      observedGeneration: s.observedGeneration ?? null,
      revision: null,
    };
  }
  const d = resource as DaemonSetInfo;
  return {
    settled:
      d.current === d.desired &&
      d.ready === d.desired &&
      d.updated === d.desired,
    failedAt: null,
    failed: null,
    desired: d.desired,
    ready: d.ready,
    generation: d.generation ?? null,
    observedGeneration: d.observedGeneration ?? null,
    revision: null,
  };
}

/** "3 of 3 ready, revision 8": what the last look said, for a verdict to carry. */
function seenWords(now: Rollout): Saying {
  return now.revision === null
    ? { key: "rolloutSeen", values: { ready: now.ready, desired: now.desired } }
    : {
        key: "rolloutSeenRevision",
        values: {
          ready: now.ready,
          desired: now.desired,
          revision: now.revision,
        },
      };
}

/**
 * Whether the object has acknowledged the action at all. Nothing is said
 * about the outcome before this is true, however settled the object looks:
 * a Deployment that was fine before the click looks fine for a second after
 * it too.
 */
function acknowledged(now: Rollout, was: Baseline, after: After): boolean {
  if (after.action === "scale") return now.desired === after.replicas;
  if (after.generationBefore !== null && now.generation !== null) {
    return now.generation > after.generationBefore;
  }
  const first = was.generation ?? null;
  if (first !== null && now.generation !== null && now.generation > first) {
    return true;
  }
  return was.unsettledSeen === true;
}

function judgeOutcome(
  kind: WatchKind,
  resource: unknown,
  was: Baseline,
  after: After
): Judgement {
  const now = rolloutOf(kind, resource);
  const baseline: Baseline = {
    ...was,
    armed: true,
    generation: was.generation === undefined ? now.generation : was.generation,
    unsettledSeen: (was.unsettledSeen ?? false) || !now.settled,
    seen: seenWords(now),
  };
  if (!acknowledged(now, baseline, after)) return { verdict: null, baseline };
  const caughtUp =
    now.generation === null ||
    now.observedGeneration === null ||
    now.observedGeneration >= now.generation;
  if (now.failed !== null) {
    // The same suspicion the success arm applies, and for the same reason.
    // The apiserver bumps `generation` the moment the action lands, while
    // the status still describes the rollout before it — so a Deployment
    // already stuck with `Progressing=False` answered "failed" within a
    // second of the click, with the *previous* revision's message, and the
    // watch closed before the fix it was following could succeed.
    //
    // A stamp settles it where the cluster wrote one: a condition that last
    // changed before the reader asked is about something they did not do.
    // Without a stamp, falling back to "has the controller looked yet" is
    // still better than believing whatever was there.
    const ours =
      now.failedAt !== null && after.askedAt !== undefined
        ? now.failedAt >= after.askedAt
        : caughtUp;
    if (ours) {
      return {
        verdict: { says: "rolloutFailed", detail: now.failed },
        baseline,
      };
    }
    return { verdict: null, baseline };
  }
  if (now.settled && caughtUp) {
    return {
      verdict: { says: "rolledOut", detail: seenWords(now) },
      baseline,
    };
  }
  return { verdict: null, baseline };
}

function judgeRollout(
  kind: WatchKind,
  resource: unknown,
  was: Baseline
): Judgement {
  const now = rolloutOf(kind, resource);
  if (!was.armed) {
    // Already there when asked: the answer is the next arrival, not this one.
    return { verdict: null, baseline: { armed: !now.settled } };
  }
  if (now.failed !== null) {
    return {
      verdict: { says: "rolloutFailed", detail: now.failed },
      baseline: was,
    };
  }
  if (now.settled) {
    return { verdict: { says: "rolledOut", detail: null }, baseline: was };
  }
  return { verdict: null, baseline: was };
}

const CRASHED = new Set(["CrashLoopBackOff", "Error", "OOMKilled"]);

function judgePod(pod: PodInfo, was: Baseline): Judgement {
  const restarts = pod.restartCount;
  if (was.restarts === undefined) {
    // A pod already Ready is asked about because it might fall over; one
    // that is not is asked about because it might come up. Either way the
    // first look only remembers.
    return { verdict: null, baseline: { armed: !pod.status.ready, restarts } };
  }
  if (restarts > was.restarts || CRASHED.has(pod.status.display)) {
    return {
      verdict: {
        says: "crashedAgain",
        detail: pod.status.message ?? pod.status.reason ?? pod.status.display,
      },
      baseline: was,
    };
  }
  if (was.armed && pod.status.ready) {
    return { verdict: { says: "ready", detail: null }, baseline: was };
  }
  if (!pod.status.ready) {
    return { verdict: null, baseline: { ...was, armed: true } };
  }
  return { verdict: null, baseline: was };
}

function judgeJob(job: JobInfo): Judgement {
  // A job never goes back to running, so a finished one is its own answer.
  if (job.status === "Complete") {
    return {
      verdict: { says: "succeeded", detail: null },
      baseline: { armed: true },
    };
  }
  if (job.status === "Failed") {
    return {
      verdict: { says: "failed", detail: null },
      baseline: { armed: true },
    };
  }
  return { verdict: null, baseline: { armed: true } };
}

function text(value: unknown, path: string): string | null {
  let cursor: unknown = value;
  for (const key of path.split(".")) {
    if (cursor === null || typeof cursor !== "object") return null;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === "string" ? cursor : null;
}

function judgeCertificate(cert: CustomResourceInfo, was: Baseline): Judgement {
  const notAfter = text(cert.status, "notAfter");
  const revision = Number(
    cert.annotations["cert-manager.io/certificate-revision"] ?? "0"
  );
  const conditions = (
    cert.status as { conditions?: Array<Record<string, unknown>> } | null
  )?.conditions;
  const ready = conditions?.find((c) => c.type === "Ready");
  const issuing = conditions?.find((c) => c.type === "Issuing");
  if (was.notAfter === undefined) {
    return { verdict: null, baseline: { armed: true, notAfter, revision } };
  }
  const moved =
    (was.revision !== undefined && revision > was.revision) ||
    (notAfter !== null && was.notAfter !== null && notAfter > was.notAfter);
  if (moved && ready?.status === "True") {
    return { verdict: { says: "renewed", detail: notAfter }, baseline: was };
  }
  if (issuing?.status === "False" && typeof issuing.message === "string") {
    return {
      verdict: { says: "issuanceFailed", detail: issuing.message },
      baseline: was,
    };
  }
  return { verdict: null, baseline: was };
}

/** Answers that landed inside one `COALESCE_MS` window go out together. */
export class Coalescer<A> {
  private pending: A[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly flush: (answers: A[]) => void,
    private readonly windowMs: number = COALESCE_MS
  ) {}

  push(answer: A): void {
    this.pending.push(answer);
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const batch = this.pending;
      this.pending = [];
      this.flush(batch);
    }, this.windowMs);
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending = [];
  }
}
