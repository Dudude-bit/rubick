import type { T } from "@/i18n/useT";
import { podReadiness, type ReadinessLists } from "@/lib/container-sequence";
import { silenceNote, type NodeSilence } from "@/lib/node-reporting";
import type { ReportValue } from "@/lib/report";
import { statusRole, type StatusRole } from "@/lib/status-role";
import { podStatusMeaning } from "@/lib/status-meaning";
import { loopState } from "@/lib/crash-loop";
import {
  causeText,
  countsAt,
  currentCause,
  sharedCause,
} from "@/lib/pod-cause";
import type { PodCause, PodStart, SharedCause } from "@/generated/types";

type LoopStatus = {
  display: string;
  loopingUntil?: string | null;
  exitUnreported?: boolean;
  /** The kubelet's words for a pod it turned away on arrival, which never ran. */
  rejected?: string;
  /** Why it is red or amber, as every surface reads it. */
  cause?: PodCause;
};

export type PodBadgeInput = ReadinessLists & {
  status: LoopStatus & { phase?: string; kubectlStatus?: string };
  start?: PodStart;
};

/**
 * A Pending pod still inside the wait `pending_grace` gives it, a minute
 * unplaced and ten once placed: whatever the scheduler has said of it so
 * far, it is coming, not failing, and every reader paints it so.
 */
export const insideWait = (
  pod: Pick<PodBadgeInput, "status" | "start">,
  now: number = Date.now()
) =>
  pod.status.phase === "Pending" &&
  pod.start?.state === "starting" &&
  Date.parse(pod.start.until) > now;

/**
 * A Pending pod past that wait: the instant the Overview stops counting it
 * as starting and counts it Pending in amber.
 */
export const pendingTooLong = (
  pod: Pick<PodBadgeInput, "status" | "start">,
  now: number = Date.now()
) =>
  pod.status.phase === "Pending" &&
  pod.start !== undefined &&
  pod.start.state !== "settled" &&
  !insideWait(pod, now);

/** The moments a pod's colour can turn on the clock alone: its wait running out, its loop lapsing. */
export function podDeadlines(
  pod: Pick<PodBadgeInput, "status" | "start">
): number[] {
  return [
    pod.start?.state === "starting" ? Date.parse(pod.start.until) : NaN,
    Date.parse(pod.status.loopingUntil ?? ""),
  ].filter(Number.isFinite);
}

/** A word that would read healthy, said in the seconds a crash-looping container is up. */
export const upBetweenCrashes = (pod: { status: LoopStatus }) =>
  statusRole(pod.status.display) === "ok" &&
  loopState(pod.status) === "looping";

/** A word that would read healthy, said of a pod that restarted with no exit reported. */
export const exitUnreported = (pod: { status: LoopStatus }) =>
  statusRole(pod.status.display) === "ok" &&
  loopState(pod.status) === "unreported";

/**
 * The colour of a pod's word on every screen. kubectl prints `Running` for a
 * pod whose readiness probe fails, and no Service sends it traffic, so that
 * word is amber here, not green; red for a pod caught up between the
 * crashes of a loop or one that has failed, whatever word it has, and amber
 * for one that restarted while the kubelet reports no exit to tell. On a node
 * that stopped reporting it is the kubelet's last word, and loses its colour.
 */
export function podRole(
  pod: PodBadgeInput,
  silence: NodeSilence | null,
  now: number = Date.now()
): StatusRole {
  if (silence) return "neutral";
  if (upBetweenCrashes(pod) || pod.status.phase === "Failed") return "err";
  const role = statusRole(pod.status.display);
  if (role === "pending" && pendingTooLong(pod, now)) return "warn";
  return role === "ok" && (!podReadiness(pod).allReady || exitUnreported(pod))
    ? "warn"
    : role;
}

/** The cause a pod's red or amber word leads with, where it has one now. */
export function troubleCause(
  pod: PodBadgeInput,
  now: number = Date.now()
): PodCause | null {
  const role = podRole(pod, null, now);
  return role === "err" || role === "warn"
    ? currentCause(pod.status.cause, now)
    : null;
}

/** A pod its kubelet is setting up inside its wait: no trouble yet, unless the kubelet's warnings say so. */
export function settingUp(
  pod: PodBadgeInput,
  now: number = Date.now()
): Extract<PodCause, { says: "creating" }> | null {
  const cause = pod.status.cause;
  return cause?.says === "creating" && insideWait(pod, now) ? cause : null;
}

/** The moments a pod's cause starts or stops counting on the clock alone. */
export function causeDeadlines(pod: PodBadgeInput): number[] {
  const cause = pod.status.cause;
  const turns =
    cause?.says === "exits"
      ? cause.until
      : cause?.says === "notReady"
        ? cause.countsFrom
        : null;
  return [...podDeadlines(pod), Date.parse(turns ?? "")].filter(
    Number.isFinite
  );
}

/**
 * What a workload's pods share as trouble at `now`, or else what the pods it
 * is setting up share, which only their kubelet's warnings make trouble:
 * what every pod shows on its way up is no workload's cause.
 */
export function workloadCause(
  pods: readonly (PodBadgeInput & { status: { deleting?: boolean } })[],
  now: number
): { shared: SharedCause; warnedOnly: boolean } | null {
  const trouble = sharedCause(
    pods.map((pod) => ({
      deleting: pod.status.deleting,
      cause: countsAt(troubleCause(pod, now), now),
    }))
  );
  if (trouble) return { shared: trouble, warnedOnly: false };
  const setup = sharedCause(
    pods.map((pod) => ({
      deleting: pod.status.deleting,
      cause: settingUp(pod, now),
    }))
  );
  return setup && { shared: setup, warnedOnly: true };
}

/** What a pod's word means on hover, the one sentence every screen that draws it gives: its cause first. */
export function podStatusTitle(
  pod: PodBadgeInput & { status: { phase: string } },
  silence: NodeSilence | null,
  t: T,
  /** The cause with what this surface read beside it. */
  cause: PodCause | null = troubleCause(pod)
): string | undefined {
  if (silence) return silenceNote(silence, t);
  return (
    [
      cause && causeText(cause, t),
      pod.status.rejected
        ? `${pod.status.display}: ${t("statusMeaning", "rejectedOnArrival", {
            said: pod.status.rejected,
          })}`
        : podStatusMeaning(
            pod.status.display,
            pod.status.phase,
            t,
            podReadiness(pod)
          ),
      upBetweenCrashes(pod) && t("statusMeaning", "betweenCrashes"),
      exitUnreported(pod) && t("statusMeaning", "exitUnreported"),
      statusRole(pod.status.display) === "pending" &&
        pendingTooLong(pod) &&
        t("statusMeaning", "pendingTooLong"),
      insideWait(pod) && t("statusMeaning", "pendingStarting"),
      pod.status.kubectlStatus &&
        t("statusMeaning", "kubectlPrints", {
          status: pod.status.kubectlStatus,
        }),
    ]
      .filter(Boolean)
      .join("\n") || undefined
  );
}

/** A pod's status as every screen draws it, coloured by {@link podRole}. */
export function podStatusValue(
  pod: PodBadgeInput,
  silence: NodeSilence | null,
  t: T,
  /** The moment the file speaks from; a list has none and reads the clock. */
  capturedAt?: string
): ReportValue {
  const display = pod.status.display;
  const now = capturedAt ? new Date(capturedAt) : undefined;
  return silence
    ? { text: `${display} · ${silenceNote(silence, t, now)}`, role: "neutral" }
    : { text: display, role: podRole(pod, null) };
}
