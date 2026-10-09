import type { T } from "@/i18n/useT";
import { podReadiness, type ReadinessLists } from "@/lib/container-sequence";
import { silenceNote, type NodeSilence } from "@/lib/node-reporting";
import type { ReportValue } from "@/lib/report";
import { statusRole, type StatusRole } from "@/lib/status-role";
import { podStatusMeaning } from "@/lib/status-meaning";
import { loopingNow } from "@/lib/crash-loop";

export type PodBadgeInput = ReadinessLists & {
  status: { display: string; loopingExitAt?: string };
};

/** A word that would read healthy, said in the seconds a crash-looping container is up. */
export const upBetweenCrashes = (pod: {
  status: { display: string; loopingExitAt?: string | null };
}) => statusRole(pod.status.display) === "ok" && loopingNow(pod.status);

/**
 * The colour of a pod's word on every screen. kubectl prints `Running` for a
 * pod whose readiness probe fails, and no Service sends it traffic, so that
 * word is amber here, not green, and red for a pod caught up between the
 * crashes of a loop. On a node that stopped reporting it is the kubelet's
 * last word, and loses its colour.
 */
export function podRole(
  pod: PodBadgeInput,
  silence: NodeSilence | null
): StatusRole {
  if (silence) return "neutral";
  if (upBetweenCrashes(pod)) return "err";
  const role = statusRole(pod.status.display);
  return role === "ok" && !podReadiness(pod).allReady ? "warn" : role;
}

/** What a pod's word means on hover, the one sentence every screen that draws it gives. */
export function podStatusTitle(
  pod: PodBadgeInput & { status: { phase: string } },
  silence: NodeSilence | null,
  t: T
): string | undefined {
  if (silence) return silenceNote(silence, t);
  return (
    [
      podStatusMeaning(
        pod.status.display,
        pod.status.phase,
        t,
        podReadiness(pod)
      ),
      upBetweenCrashes(pod) && t("statusMeaning", "betweenCrashes"),
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
