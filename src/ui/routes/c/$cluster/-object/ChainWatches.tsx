import type { QueryKey } from "@tanstack/react-query";

import type { ChainService } from "@/hooks/useChainAnswer";
import { useServiceWatch } from "@/hooks/usePodWatch";

/**
 * The pods and slices of every Service a traffic chain reaches, watched while
 * it is on screen, each change reading `reads` again: the watches a Service's
 * own page keeps, under a Deployment, a pod, an Ingress or a route.
 */
export function ChainWatches({
  services,
  reads,
}: {
  services: readonly ChainService[];
  reads: readonly QueryKey[];
}) {
  return services.map((service) => (
    <ServiceWatches
      key={`${service.namespace}/${service.name}`}
      service={service}
      reads={reads}
    />
  ));
}

function ServiceWatches({
  service,
  reads,
}: {
  service: ChainService;
  reads: readonly QueryKey[];
}) {
  useServiceWatch(
    service.namespace,
    service.name,
    { uid: undefined, selector: service.selector },
    reads,
    true
  );
  return null;
}
