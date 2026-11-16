import { useT } from "@/i18n/useT";
import type { Finding } from "@/lib/governance";
import type { ConnectionsRead } from "@/hooks/useConnections";
import { governanceRows } from "./governance";

/**
 * What the autoscalers and budgets say is wrong, for the page frame to put
 * under the header: they are about the object, so they are read once here and
 * not drawn again in the count block.
 */
export function useGovernanceFindings(governance?: ConnectionsRead): Finding[] {
  return governanceRows(governance?.data, useT()).findings;
}
