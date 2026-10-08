import type { T } from "@/i18n/useT";
import { podReadiness, type ReadinessLists } from "@/lib/container-sequence";
import { silenceNote, type NodeSilence } from "@/lib/node-reporting";
import type { ReportValue } from "@/lib/report";
import { statusRole, type StatusRole } from "@/lib/status-role";
import { loopingNow } from "@/lib/crash-loop";

export type PodBadgeInput = ReadinessLists & {
  status: { display: string; loopingExitAt?: string };
};

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
  const role = statusRole(pod.status.display);
  if (role === "ok" && loopingNow(pod.status)) return "err";
  return role === "ok" && !podReadiness(pod).allReady ? "warn" : role;
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
