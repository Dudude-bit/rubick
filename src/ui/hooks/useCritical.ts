import { criticalityOf } from "@/lib/critical";
import type { Criticality } from "@/lib/critical";
import { useClusterMark } from "@/stores/clusterIdentityStore";
import { useClusterStore } from "@/stores/clusterStore";

/** The current cluster's criticality, with its name for the dialogs that ask for it. */
export function useCritical(): Criticality & { context: string | null } {
  const context = useClusterStore((s) => s.currentContext);
  const mark = useClusterMark(context);
  return { context, ...criticalityOf(context, mark) };
}
