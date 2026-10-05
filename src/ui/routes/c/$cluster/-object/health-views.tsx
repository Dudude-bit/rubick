import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { StatusBadge } from "@/components/ui/status-badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useConnections } from "@/hooks/useConnections";
import { useServiceHealthInputs } from "@/hooks/useServiceHealthInputs";
import { useTlsCertificates } from "@/hooks/useTlsCertificates";
import { useT } from "@/i18n/useT";
import { commands } from "@/lib/commands";
import {
  ingressHealthOf,
  ingressHealthWords,
  secretNamesOf,
  type IngressInputs,
} from "@/lib/ingress-health";
import { knownOf } from "@/lib/known";
import { queryKeys } from "@/lib/query-keys";
import {
  healthFromConnections,
  serviceHealthWords,
  type Verdict,
} from "@/lib/service-health";

/** A verdict as a badge, with its reason beside it or, in a row, on hover. */
export function VerdictBadge({
  verdict,
  compact = false,
}: {
  verdict: Verdict;
  compact?: boolean;
}) {
  const tipped = compact && Boolean(verdict.reason);
  const badge = (
    <StatusBadge
      status={verdict.code}
      roleOverride={verdict.role}
      wordOnHover={!tipped}
    >
      {verdict.label}
    </StatusBadge>
  );
  if (!verdict.reason) return badge;
  if (tipped) {
    return (
      <Tooltip>
        <TooltipTrigger className="max-w-full text-left align-middle">
          {badge}
        </TooltipTrigger>
        <TooltipContent className="max-w-[44ch] text-xs">
          <span className="block font-mono">{verdict.label}</span>
          {verdict.reason}
        </TooltipContent>
      </Tooltip>
    );
  }
  return (
    <span className="flex flex-col items-start gap-0.5">
      {badge}
      <span className="max-w-[60ch] text-[11px] text-fg-mut">
        {verdict.reason}
      </span>
    </span>
  );
}

/** The Service named here: the page, its peek and its Endpoints object. */
export function ServiceHealthView({
  name,
  namespace,
}: {
  name: string;
  namespace: string | null;
}) {
  const t = useT();
  const { data, error } = useConnections("Service", name, namespace);
  // The last object's answer stands in while this one is read.
  const mine = data?.subject.name === name ? data : undefined;
  const health = useMemo(
    () => healthFromConnections(mine, error),
    [mine, error]
  );
  return <VerdictBadge verdict={serviceHealthWords(health, t)} />;
}

/** One Ingress, on its page and in its peek: the same reads as the list. */
export function IngressHealthView({
  ingress,
}: {
  ingress: IngressInputs["ingress"];
}) {
  const t = useT();
  const binding = useQuery({
    queryKey: queryKeys.ingressClass(ingress.className),
    queryFn: () => commands.resolveIngressClass(ingress.className ?? null),
  });
  const backing = useServiceHealthInputs([ingress.namespace]);
  const certificates = useTlsCertificates(
    ingress.namespace,
    secretNamesOf(ingress)
  );
  const health = ingressHealthOf({
    ingress,
    binding: knownOf(binding),
    backing: backing.in(ingress.namespace),
    certificates,
  });
  return <VerdictBadge verdict={ingressHealthWords(health, t)} />;
}
