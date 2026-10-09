import type { ServiceInfo } from "@/generated/types";
import { useT } from "@/i18n/useT";
import { serviceHealthOf, serviceHealthWords } from "@/lib/service-health";
import { useBackingRead } from "../../-components/service-backing";
import { VerdictBadge } from "../../../-object/health-views";

export { BackingAround } from "../../-components/ServiceBacking";

/** The verdict the Service's own page shows, from the same function. */
export function HealthCell({ service }: { service: ServiceInfo }) {
  const t = useT();
  const read = useBackingRead();
  if (!read) return null;
  const health = serviceHealthOf(
    {
      type: service.type,
      selectorless: Object.keys(service.selector).length === 0,
    },
    read.published(service.namespace, service.name),
    read.why(service.namespace)
  );
  return <VerdictBadge verdict={serviceHealthWords(health, t)} compact />;
}
