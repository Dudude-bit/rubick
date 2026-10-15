import { createContext, useContext } from "react";

import type { ServiceInfo } from "@/generated/types";
import { useNamespaceScope } from "@/hooks/useNamespaceScope";
import {
  useServiceBacking,
  type ServiceBackingRead,
} from "@/hooks/useServiceBacking";
import type { T } from "@/i18n/useT";
import { serviceHealthOf, serviceHealthWords } from "@/lib/service-health";

/**
 * What every Service in the scope publishes, read once for the page and
 * handed to the cells, so the column costs one read and not one per row.
 */
export const Backing = createContext<ServiceBackingRead | null>(null);

export const useBackingRead = () => useContext(Backing);

export const useScopeBacking = () =>
  useServiceBacking(useNamespaceScope().wire);

/** A Service's verdict as its own page draws it, from the scope's read. */
export const serviceVerdictOf = (
  service: ServiceInfo,
  read: ServiceBackingRead,
  t: T
) =>
  serviceHealthWords(
    serviceHealthOf(
      {
        type: service.type,
        selectorless: Object.keys(service.selector).length === 0,
      },
      read.published(service.namespace, service.name),
      read.why(service.namespace)
    ),
    t
  );
