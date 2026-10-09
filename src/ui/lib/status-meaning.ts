import type { en } from "@/i18n/catalogue";
import type { T } from "@/i18n/useT";
import type { PodReadiness } from "@/lib/container-sequence";
import { toKind } from "@/lib/resource-registry";
import { ownStatusWord, rolloutWord } from "@/lib/status-words";
import type { WorkloadStatus } from "@/lib/workload-status";

/**
 * A badge's tooltip says what its code means; it used to say "Phase Pending"
 * under a badge reading Pending. Phases and workload words are closed sets,
 * so a new one does not compile without a meaning; the kubelet's reasons are
 * open, and an unlisted one falls back to the phase.
 */
type Meaning = keyof typeof en.statusMeaning;

export type PodPhase =
  | "Pending"
  | "Running"
  | "Succeeded"
  | "Failed"
  | "Unknown";

const POD_PHASE: Record<PodPhase, Meaning> = {
  Pending: "phasePending",
  Running: "phaseRunning",
  Succeeded: "phaseSucceeded",
  Failed: "phaseFailed",
  Unknown: "phaseUnknown",
};

const POD_REASON: Record<string, Meaning> = {
  ContainerCreating: "containerCreating",
  PodInitializing: "podInitializing",
  CrashLoopBackOff: "crashLoopBackOff",
  ImagePullBackOff: "imagePullBackOff",
  ErrImagePull: "errImagePull",
  CreateContainerConfigError: "createContainerConfigError",
  CreateContainerError: "createContainerError",
  InvalidImageName: "invalidImageName",
  RunContainerError: "runContainerError",
  OOMKilled: "oomKilled",
  Error: "error",
  Completed: "completed",
  Terminating: "terminating",
  Evicted: "evicted",
  NodeLost: "nodeLost",
  SchedulingGated: "schedulingGated",
  NotReady: "notReady",
  ContainerStatusUnknown: "containerStatusUnknown",
  DeadlineExceeded: "deadlineExceeded",
};

const WORKLOAD: Record<WorkloadStatus, Meaning> = {
  Ready: "workloadReady",
  Progressing: "workloadProgressing",
  Idle: "workloadIdle",
  Stalled: "workloadStalled",
  Unavailable: "workloadUnavailable",
  Paused: "workloadPaused",
  Waiting: "workloadWaiting",
  Degraded: "workloadDegraded",
};

/** What a Job's badge prints, held to the backend by `src/contracts/job-codes.json`. */
export type JobStatus =
  | "Complete"
  | "Failed"
  | "Suspended"
  | "Retrying"
  | "Running"
  | "Pending";

export const JOB: Record<JobStatus, Meaning> = {
  Complete: "jobComplete",
  Failed: "jobFailed",
  Suspended: "jobSuspended",
  Retrying: "jobRetrying",
  Running: "jobRunning",
  Pending: "jobPending",
};

const WORKLOAD_KINDS = new Set(["Deployment", "StatefulSet", "DaemonSet"]);

const INIT_PROGRESS = /^(\d+)\/(\d+)$/;
const EXIT = /^ExitCode:(-?\d+)$/;
const SIGNAL = /^Signal:(\d+)$/;

const isPhase = (code: string): code is PodPhase =>
  Object.hasOwn(POD_PHASE, code);

const line = (code: string, meaning: string) => `${code}: ${meaning}`;

function reasonMeaning(code: string, t: T): string | null {
  if (isPhase(code)) return t("statusMeaning", POD_PHASE[code]);
  if (Object.hasOwn(POD_REASON, code))
    return t("statusMeaning", POD_REASON[code]);
  const exit = EXIT.exec(code);
  if (exit) return t("statusMeaning", "exitCode", { code: exit[1] });
  const signal = SIGNAL.exec(code);
  if (signal) return t("statusMeaning", "signal", { signal: signal[1] });
  return null;
}

/**
 * A pod's badge reads kubectl's word; its phase is the fallback. With its
 * readiness, a `Running` pod short of ready says what that costs it.
 */
export function podStatusMeaning(
  display: string,
  phase: string | null | undefined,
  t: T,
  readiness?: PodReadiness
): string | undefined {
  const meaning = wordMeaning(display, phase, t);
  if (!readiness || readiness.allReady || display !== "Running") return meaning;
  const short = line(
    `${t("columns", "ready")} ${readiness.ready}/${readiness.total}`,
    t("statusMeaning", "notReady")
  );
  return meaning ? `${meaning}\n${short}` : short;
}

function wordMeaning(
  display: string,
  phase: string | null | undefined,
  t: T
): string | undefined {
  if (display.startsWith("Init:")) {
    const rest = display.slice(5);
    const progress = INIT_PROGRESS.exec(rest);
    if (progress)
      return line(
        display,
        t("statusMeaning", "initProgress", {
          done: progress[1],
          total: progress[2],
        })
      );
    const inner = reasonMeaning(rest, t);
    if (inner)
      return line(display, `${inner} ${t("statusMeaning", "initNote")}`);
  } else {
    const meaning = reasonMeaning(display, t);
    if (meaning) return line(display, meaning);
  }
  if (phase && isPhase(phase))
    return line(
      `${t("columns", "phase")} ${phase}`,
      t("statusMeaning", POD_PHASE[phase])
    );
  return undefined;
}

export function workloadStatusMeaning(
  status: string,
  t: T
): string | undefined {
  if (!Object.hasOwn(WORKLOAD, status)) return undefined;
  return line(
    rolloutWord(status as WorkloadStatus, t),
    t("statusMeaning", WORKLOAD[status as WorkloadStatus])
  );
}

/** For a surface that draws any kind's badge: the peek's header. */
export function statusMeaning(
  kind: string,
  status: string,
  t: T
): string | undefined {
  const resolved = toKind(kind);
  if (resolved === "Pod") return podStatusMeaning(status, null, t);
  if (resolved && WORKLOAD_KINDS.has(resolved))
    return workloadStatusMeaning(status, t);
  if (resolved === "Job" && Object.hasOwn(JOB, status))
    return line(
      ownStatusWord(status, t) ?? status,
      t("statusMeaning", JOB[status as JobStatus])
    );
  return undefined;
}
