import { createContext, useContext, type ReactNode } from "react";

import type { ServiceInfo } from "@/generated/types";
import { useNamespaceScope } from "@/hooks/useNamespaceScope";
import {
  useServiceBacking,
  type ServiceBackingRead,
} from "@/hooks/useServiceBacking";
import { useT } from "@/i18n/useT";
import { serviceHealthOf, serviceHealthWords } from "@/lib/service-health";
import { VerdictBadge } from "../../../-object/health-views";

/**
 * What every Service in the scope publishes, read once for the page and
 * handed to the cells, so the column costs one read and not one per row.
 */
const Backing = createContext<ServiceBackingRead | null>(null);

export function BackingAround({ children }: { children: ReactNode }) {
  const scope = useNamespaceScope();
  const read = useServiceBacking(scope.wire);
  return <Backing.Provider value={read}>{children}</Backing.Provider>;
}

/** The verdict the Service's own page shows, from the same function. */
export function HealthCell({ service }: { service: ServiceInfo }) {
  const t = useT();
  const read = useContext(Backing);
  if (!read) return null;
  const home = read.in(service.namespace);
  const health = serviceHealthOf(
    {
      type: service.type,
      selectorless: Object.keys(service.selector).length === 0,
    },
    read.published(service.namespace, service.name),
    home.known ? null : home.why
  );
  return <VerdictBadge verdict={serviceHealthWords(health, t)} compact />;
}
