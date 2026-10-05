import { StatusBadge } from "@/components/ui/status-badge";
import { CopyableAddresses } from "@/components/ui/copyable-value";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useBalancerEvidence } from "@/hooks/useBalancerEvidence";
import { useT } from "@/i18n/useT";
import { balancerAddressOf, balancerWords } from "@/lib/load-balancer";
import type { ServiceInfo } from "@/generated/types";

type Balanced = Pick<ServiceInfo, "type" | "loadBalancerIps" | "ports">;

/**
 * A LoadBalancer Service's address, or why it has none: the same reading on
 * the page, the peek and the list. `compact` puts the reason in a tooltip.
 */
export function BalancerAddress({
  service,
  compact = false,
}: {
  service: Balanced;
  compact?: boolean;
}) {
  const t = useT();
  const evidence = useBalancerEvidence(
    service.type === "LoadBalancer" && service.loadBalancerIps.length === 0
  );
  const address = balancerAddressOf(service, evidence);
  if (address.state === "notBalancer") return null;
  if (address.state === "assigned") {
    return (
      <CopyableAddresses
        values={address.addresses}
        label={t("columns", "loadBalancerAddress")}
      />
    );
  }
  const nodePorts = service.ports.flatMap((port) =>
    port.nodePort === null ? [] : [port.nodePort]
  );
  const words = balancerWords(address, nodePorts, t);
  const badge = (
    <StatusBadge status={address.state} roleOverride={words.role}>
      {words.label}
    </StatusBadge>
  );
  if (compact) {
    return (
      <Tooltip>
        <TooltipTrigger>{badge}</TooltipTrigger>
        <TooltipContent className="max-w-[44ch] text-xs">
          {words.reason}
        </TooltipContent>
      </Tooltip>
    );
  }
  return (
    <span className="flex flex-col items-start gap-0.5">
      {badge}
      <span className="max-w-[60ch] text-[11px] text-fg-mut">
        {words.reason}
      </span>
    </span>
  );
}
