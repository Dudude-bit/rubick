import { useMemo, type ReactNode } from "react";
import { EyeOff } from "lucide-react";

import { StatusBadge } from "@/components/ui/status-badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useConnections, type ConnectionsRead } from "@/hooks/useConnections";
import {
  useServiceAnswer,
  useServicePodsUnread,
} from "@/hooks/useServiceAnswer";
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
 * The Service named here, in its peek and on its Endpoints object. Its pods
 * and slices are followed live while it is on screen, and a read that cannot
 * speak for it is not drawn.
 */
export function ServiceHealthView({
  name,
  namespace,
  compact = false,
  follow = true,
}: {
  name: string;
  namespace: string | null;
  compact?: boolean;
  /** Unset where another reader on the surface, always mounted, follows it. */
  follow?: boolean;
}) {
  const query = useConnections(ResourceType.Service, name, namespace);
  return (
    <ServiceVerdict
      read={useServiceAnswer(name, namespace, query, follow).read}
      compact={compact}
    />
  );
}

/** A Service's verdict from the answer every other reader of it on that surface draws from. */
export function ServiceVerdict({
  read,
  compact = false,
}: {
  read: ConnectionsRead;
  compact?: boolean;
}) {
  const t = useT();
  const { data, error } = read;
  const health = useMemo(
    () => healthFromConnections(data, error),
    [data, error]
  );
  return (
    <VerdictBadge verdict={serviceHealthWords(health, t)} compact={compact} />
  );
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

/** Words or a count about addresses not ready: amber, or neutral with the not-read mark where the Service's pods were not read to say why. */
export function NotReadyMark({
  podsUnread,
  children,
}: {
  podsUnread: boolean;
  children: ReactNode;
}) {
  const t = useT();
  if (!podsUnread) return <span className="text-warn">{children}</span>;
  return (
    <span className="inline-flex items-center gap-1 text-fg-mut">
      <EyeOff
        className="h-3 w-3 flex-none"
        role="img"
        aria-label={t("empty", "podsNotRead")}
      />
      {children}
    </span>
  );
}

/** {@link NotReadyMark} for the Service named, as its verdict on the same surface reads it. */
export function ServiceNotReady({
  name,
  namespace,
  children,
}: {
  name: string;
  namespace: string | null;
  children: ReactNode;
}) {
  return (
    <NotReadyMark podsUnread={useServicePodsUnread(name, namespace)}>
      {children}
    </NotReadyMark>
  );
}
