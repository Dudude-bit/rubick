/**
 * What the Cilium row reads: the two policy kinds, and nothing else.
 *
 * Endpoints and identities are one per pod and one per label set, so a
 * cluster of any size has thousands of them; the row is glanced at, and a
 * count of those would cost more than it says. The CRD pages read them.
 */

import { commands } from "@/lib/commands";
import type { CustomResourceInfo } from "@/generated/types";

export const GROUP = "cilium.io";

export const KINDS = {
  policies: `ciliumnetworkpolicies.${GROUP}`,
  clusterwide: `ciliumclusterwidenetworkpolicies.${GROUP}`,
} as const;

export interface PolicySources {
  policies: CustomResourceInfo[];
  clusterwide: CustomResourceInfo[];
}

function list(kind: string): Promise<CustomResourceInfo[]> {
  return commands.listCustomResources(kind, null, null, null);
}

export async function fetchPolicies(): Promise<PolicySources> {
  const [policies, clusterwide] = await Promise.all([
    list(KINDS.policies),
    list(KINDS.clusterwide),
  ]);
  return { policies, clusterwide };
}

export const POLICY_KEY = ["cilium", "policies"] as const;
