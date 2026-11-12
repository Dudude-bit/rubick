import type { ServiceInfo } from "@/generated/types";
import { useT } from "@/i18n/useT";
import {
  serviceVerdictOf,
  useBackingRead,
} from "../../-components/service-backing";
import { VerdictBesideReason } from "../../../-object/health-views";

export { BackingAround } from "../../-components/ServiceBacking";

/** The verdict the Service's own page shows, from the same function. */
export function HealthCell({ service }: { service: ServiceInfo }) {
  const t = useT();
  const read = useBackingRead();
  if (!read) return null;
  return <VerdictBesideReason verdict={serviceVerdictOf(service, read, t)} />;
}
