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
  | "drainFailed"
  | "renewed"
  | "issuanceFailed"
  | "forwardDied"
  | "gone"
  | "lostSight";

export interface Verdict {
  says: Says;
  /** The cluster's own words where it had any, kept whole. */
  detail: string | null;
}

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
      return judgeRollout(watch.kind, resource, was);
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
    return {
      settled:
        r.updated === r.desired &&
        r.available === r.desired &&
        r.ready === r.desired &&
        (progressing === undefined ||
          progressing.reason === "NewReplicaSetAvailable"),
      failed,
    };
  }
  if (kind === "StatefulSet") {
    const r = (resource as StatefulSetInfo).replicas;
    return {
      settled: r.ready === r.desired && r.current === r.desired,
      failed: null,
    };
  }
  const d = resource as DaemonSetInfo;
  return {
    settled: d.current === d.desired && d.ready === d.desired,
    failed: null,
  };
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
