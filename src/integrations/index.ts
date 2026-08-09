/**
 * The capability registry — the only door into `src/integrations/`.
 *
 * A surface asks for a capability and gets an implementation or nothing. It
 * never learns which extension answered, or whether one did.
 */

import { useQuery } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import certManager from "./cert-manager";
import type { CapabilityKey, Capabilities, Integration } from "./registry";

export type { CapabilityKey, Capabilities, Integration };

/**
 * Every extension that ships in the binary.
 *
 * A list, not a plugin API: third parties loading code into the app is a
 * different product with a different threat model.
 */
const INTEGRATIONS: Integration[] = [certManager];

/**
 * What is installed in the connected cluster.
 *
 * One CRD list per cluster, and it does not change while the app is open
 * often enough to be worth polling — an install is a deliberate act, and a
 * reader who has just done one can switch context or reopen.
 */
function useDetected() {
  return useQuery({
    queryKey: ["in-cluster-extensions"],
    queryFn: commands.detectInClusterExtensions,
    staleTime: 5 * 60_000,
  });
}

/**
 * The implementation of a capability, or `null`.
 *
 * `null` is not an error state and the caller must not draw it as one: it
 * is the answer for the majority of clusters, and every surface that asks
 * owes a whole page without it.
 */
export function useCapability<K extends CapabilityKey>(
  key: K
): Capabilities[K] | null {
  const { data } = useDetected();
  if (!data) return null;
  const installed = new Set(
    data.filter((entry) => entry.installed).map((entry) => entry.id)
  );
  const found = INTEGRATIONS.find(
    (integration) =>
      installed.has(integration.id) && key in integration.provides
  );
  return (found?.provides[key] as Capabilities[K] | undefined) ?? null;
}

export interface IntegrationStatus {
  integration: Integration;
  installed: boolean;
  version: string | null;
}

/**
 * Every extension and whether this cluster has it — for the one screen that
 * is allowed to name them.
 */
export function useIntegrations(): {
  statuses: IntegrationStatus[];
  isPending: boolean;
  error: Error | null;
} {
  const { data, isPending, error } = useDetected();
  return {
    statuses: INTEGRATIONS.map((integration) => {
      const detected = data?.find((entry) => entry.id === integration.id);
      return {
        integration,
        installed: detected?.installed ?? false,
        version: detected?.version ?? null,
      };
    }),
    isPending,
    error,
  };
}
