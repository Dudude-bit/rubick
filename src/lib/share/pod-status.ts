import type { PodInfo } from "@/generated/types";
import type { T } from "@/i18n/useT";
import { silenceNote, type NodeSilence } from "@/lib/node-reporting";
import type { ReportValue } from "@/lib/report";
import { statusRole } from "@/lib/status-role";

/**
 * A pod's status as every screen draws it: on a node that stopped reporting
 * it is the kubelet's last word, so it loses its colour and says why.
 */
export function podStatusValue(
  pod: Pick<PodInfo, "status"> | { status: { display: string } },
  silence: NodeSilence | null,
  t: T,
  /** The moment the file speaks from; a list has none and reads the clock. */
  capturedAt?: string
): ReportValue {
  const display = pod.status.display;
  const now = capturedAt ? new Date(capturedAt) : undefined;
  return silence
    ? { text: `${display} · ${silenceNote(silence, t, now)}`, role: "neutral" }
    : { text: display, role: statusRole(display) };
}
