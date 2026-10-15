import { StatusBadge } from "@/components/ui/status-badge";
import { useLastPassed } from "@/hooks/useNow";
import { useT } from "@/i18n/useT";
import type { NodeSilence } from "@/lib/node-reporting";
import {
  podDeadlines,
  podRole,
  podStatusTitle,
  warnedRole,
  type PodBadgeInput,
} from "@/lib/share/pod-status";

/** kubectl's word for the pod, in the colour and with the meaning every pod surface gives it. */
export function PodStatusBadge({
  pod,
  silence,
  warned = false,
}: {
  pod: PodBadgeInput & { status: { phase: string } };
  silence: NodeSilence | null;
  /** Its kubelet's warnings were read and say it is not coming. */
  warned?: boolean;
}) {
  const t = useT();
  // Read through the clock so a pod turns the moment its wait runs out.
  const role = warnedRole(
    podRole(pod, silence, useLastPassed(podDeadlines(pod))),
    warned
  );
  return (
    <StatusBadge
      status={pod.status.display}
      roleOverride={role}
      title={podStatusTitle(pod, silence, t)}
    />
  );
}
