import { StatusBadge } from "@/components/ui/status-badge";
import { useT } from "@/i18n/useT";
import { podReadiness } from "@/lib/container-sequence";
import { silenceNote, type NodeSilence } from "@/lib/node-reporting";
import {
  podRole,
  upBetweenCrashes,
  type PodBadgeInput,
} from "@/lib/share/pod-status";
import { podStatusMeaning } from "@/lib/status-meaning";

/** kubectl's word for the pod, in the colour and with the meaning every pod surface gives it. */
export function PodStatusBadge({
  pod,
  silence,
}: {
  pod: PodBadgeInput & { status: { phase: string } };
  silence: NodeSilence | null;
}) {
  const t = useT();
  return (
    <StatusBadge
      status={pod.status.display}
      roleOverride={podRole(pod, silence)}
      title={
        silence
          ? silenceNote(silence, t)
          : [
              podStatusMeaning(
                pod.status.display,
                pod.status.phase,
                t,
                podReadiness(pod)
              ),
              upBetweenCrashes(pod) && t("statusMeaning", "betweenCrashes"),
            ]
              .filter(Boolean)
              .join("\n")
      }
    />
  );
}
