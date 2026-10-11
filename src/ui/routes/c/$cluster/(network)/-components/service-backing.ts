import { createContext, useContext } from "react";

import { useNamespaceScope } from "@/hooks/useNamespaceScope";
import {
  useServiceBacking,
  type ServiceBackingRead,
} from "@/hooks/useServiceBacking";

/**
 * What every Service in the scope publishes, read once for the page and
 * handed to the cells, so the column costs one read and not one per row.
 */
export const Backing = createContext<ServiceBackingRead | null>(null);

export const useBackingRead = () => useContext(Backing);

export const useScopeBacking = () =>
  useServiceBacking(useNamespaceScope().wire);
