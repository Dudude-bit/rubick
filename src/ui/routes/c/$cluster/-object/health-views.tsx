import { useMemo } from "react";

import { StatusBadge } from "@/components/ui/status-badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useConnections } from "@/hooks/useConnections";
import { useServiceAnswer } from "@/hooks/useServiceAnswer";
import { ResourceType } from "@/lib/resource-registry";
import { useOneIngressHealth } from "@/hooks/useIngressHealth";
import { useT } from "@/i18n/useT";
import { ingressHealthWords, type IngressInputs } from "@/lib/ingress-health";
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
      glyph={verdict.glyph}
      wordOnHover={!tipped}
    >
      {verdict.label}
    </StatusBadge>
  );
  if (!verdict.reason) return badge;
  if (tipped) {
    // Not hoverable: the cause is read, not clicked, and a pointer that
    // jumps to the next row would otherwise keep it open over that row.
    return (
      <Tooltip disableHoverableContent>
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

/**
 * The Service named here: the page, its peek and its Endpoints object. Its
 * pods and slices are followed live while it is on screen unless the page
 * around it follows them, and a read that cannot speak for it is not drawn.
 */
export function ServiceHealthView({
  name,
  namespace,
  follow = true,
}: {
  name: string;
  namespace: string | null;
  follow?: boolean;
}) {
  const t = useT();
  const query = useConnections(ResourceType.Service, name, namespace);
  const { current, stale } = useServiceAnswer(name, namespace, query, follow);
  const { error } = query;
  const health = useMemo(
    () => healthFromConnections(current, stale ? null : error),
    [current, stale, error]
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
  const health = useOneIngressHealth(ingress);
  return health ? (
    <VerdictBadge verdict={ingressHealthWords(health, t)} />
  ) : null;
}
