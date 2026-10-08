import type { EndpointsInfo } from "@/generated/types";
import { T } from "@/i18n/T";
import { useT } from "@/i18n/useT";
import { serviceHealthWords } from "@/lib/service-health";
import { useBackingRead } from "../../-components/service-backing";
import { VerdictBadge } from "../../../-object/health-views";

/** None published: a fault, unless every workload behind it is scaled to zero. */
export function NoEndpoints({ endpoints }: { endpoints: EndpointsInfo }) {
  const t = useT();
  const stop = useBackingRead()?.published(
    endpoints.namespace,
    endpoints.name
  )?.stop;
  if (stop?.reason === "scaledToZero") {
    return (
      <VerdictBadge
        verdict={serviceHealthWords({ state: "idle", stop }, t)}
        compact
      />
    );
  }
  return (
    <span className="text-err">
      <T section="readings" k="healthNoEndpoints" />
    </span>
  );
}
