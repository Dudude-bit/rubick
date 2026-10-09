import { StatusBadge } from "@/components/ui/status-badge";
import { useT } from "@/i18n/useT";
import type { NodeSilence } from "@/lib/node-reporting";
import {
  podRole,
  podStatusTitle,
  type PodBadgeInput,
} from "@/lib/share/pod-status";

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
      title={podStatusTitle(pod, silence, t)}
    />
  );
}
