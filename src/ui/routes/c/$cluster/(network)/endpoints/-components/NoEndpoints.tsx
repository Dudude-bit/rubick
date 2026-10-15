import type { EndpointsInfo } from "@/generated/types";
import { T } from "@/i18n/T";
import { useT } from "@/i18n/useT";
import { useBackingRead } from "../../-components/service-backing";
import { VerdictBesideReason } from "../../../-object/health-views";
import { WAITS, emptyEndpointsVerdict } from "./pods-unread";

/** None published: a fault, unless what runs behind it is scaled to zero, making its pods, or unread; the fault with its Service's reason beside it. */
export function NoEndpoints({ endpoints }: { endpoints: EndpointsInfo }) {
  const t = useT();
  const verdict = emptyEndpointsVerdict(useBackingRead(), endpoints, t);
  if (verdict && WAITS[verdict.state])
    return <VerdictBesideReason verdict={verdict.words} />;
  const reason = verdict?.words.reason;
  return (
    <span className="inline-flex min-w-0 max-w-full items-baseline gap-1.5">
      <span className="flex-none text-err">
        <T section="readings" k="healthNoEndpoints" />
      </span>
      {reason && (
        <span
          className="min-w-0 truncate text-xs text-fg-mut"
          title={reason}
          data-testid="verdict-reason"
        >
          {reason}
        </span>
      )}
    </span>
  );
}
