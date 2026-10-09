import type { EndpointsInfo } from "@/generated/types";
import { T } from "@/i18n/T";
import { useT } from "@/i18n/useT";
import {
  serviceHealthOf,
  serviceHealthWords,
  type ServiceHealth,
} from "@/lib/service-health";
import { useBackingRead } from "../../-components/service-backing";
import { VerdictBadge } from "../../../-object/health-views";

/** Whether its own verdict stands in for "no endpoints": only the ones no fault explains. */
const WAITS: Record<ServiceHealth["state"], boolean> = {
  idle: true,
  comingUp: true,
  podsUnread: true,
  ready: false,
  partly: false,
  draining: false,
  noneReady: false,
  noEndpoints: false,
  externalName: false,
  selectorless: false,
  unknown: false,
};

/** None published: a fault, unless what runs behind it is scaled to zero, making its pods, or unread. */
export function NoEndpoints({ endpoints }: { endpoints: EndpointsInfo }) {
  const t = useT();
  const published = useBackingRead()?.published(
    endpoints.namespace,
    endpoints.name
  );
  const health = published
    ? serviceHealthOf({ type: "", selectorless: false }, published, null)
    : null;
  if (health && WAITS[health.state]) {
    return <VerdictBadge verdict={serviceHealthWords(health, t)} compact />;
  }
  return (
    <span className="text-err">
      <T section="readings" k="healthNoEndpoints" />
    </span>
  );
}
