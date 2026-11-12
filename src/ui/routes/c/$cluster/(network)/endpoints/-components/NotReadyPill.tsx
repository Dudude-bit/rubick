import { EyeOff } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { EndpointsInfo } from "@/generated/types";
import { T } from "@/i18n/T";
import { useT } from "@/i18n/useT";
import { useEndpointsPodsUnread } from "./pods-unread";

/** The not-read mark beside words about addresses not ready. */
export function PodsUnreadMark() {
  const t = useT();
  return (
    <EyeOff
      className="h-2.5 w-2.5 flex-none"
      role="img"
      aria-label={t("empty", "podsNotRead")}
    />
  );
}

/**
 * Addresses not ready, as the Service's verdict on this list reads them:
 * amber, or neutral with the not-read mark where its pods were not read to
 * say why. Marco's ledger was amber here while its page and peek were grey.
 */
export function NotReadyPill({
  endpoints,
  n,
}: {
  endpoints: EndpointsInfo;
  n: number;
}) {
  const podsUnread = useEndpointsPodsUnread(endpoints);
  return (
    <Badge variant={podsUnread ? "secondary" : "warning"}>
      {podsUnread && <PodsUnreadMark />}
      <T section="count" k="nNotReady" values={{ n }} />
    </Badge>
  );
}
