import { isProductionContext } from "@/lib/cluster-identity";
import type { ClusterMark } from "@/stores/clusterIdentityStore";

/**
 * Whether a cluster is critical infrastructure, and whether that is the
 * person's word or only what its name suggests.
 *
 * Only the person's word arms the guard: a guess from the name paints the
 * row and asks, and nothing else. Acting on the wrong cluster is the
 * expensive mistake; so is a guard that fires on a cluster called
 * `product-catalog-dev` until someone finds the setting that turns it off.
 */
export interface Criticality {
  /** Every change asks for the context name. */
  critical: boolean;
  /** The name looks like production and nobody has said either way. */
  guessed: boolean;
}

export function criticalityOf(
  context: string | null | undefined,
  mark: ClusterMark | undefined
): Criticality {
  if (!context) return { critical: false, guessed: false };
  if (mark?.critical !== undefined) {
    return { critical: mark.critical, guessed: false };
  }
  return { critical: false, guessed: isProductionContext(context) };
}
