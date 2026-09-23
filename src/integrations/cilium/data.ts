/**
 * What the Cilium row reads: the two policy kinds, and nothing else.
 *
 * Endpoints and identities are one per pod and one per label set, so a
 * cluster of any size has thousands of them; the row is glanced at, and a
 * count of those would cost more than it says. The CRD pages read them.
 */

import { useQuery } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import { useClusterStore } from "@/stores/clusterStore";
import { ROUTING_STALE } from "../ingress";
import { coverageOf } from "./coverage";
import type { CustomResourceInfo } from "@/generated/types";

export const GROUP = "cilium.io";

export const KINDS = {
  policies: `ciliumnetworkpolicies.${GROUP}`,
  clusterwide: `ciliumclusterwidenetworkpolicies.${GROUP}`,
  endpoints: `ciliumendpoints.${GROUP}`,
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

/** The page's read: the two policy kinds and the endpoints to match them to. */
export interface Picture extends PolicySources {
  endpoints: CustomResourceInfo[];
}

export async function fetchPicture(): Promise<Picture> {
  const [policies, clusterwide, endpoints] = await Promise.all([
    list(KINDS.policies),
    list(KINDS.clusterwide),
    list(KINDS.endpoints),
  ]);
  return { policies, clusterwide, endpoints };
}

export const PICTURE_KEY = ["cilium", "picture"] as const;

/**
 * How many endpoints no enforcing policy selects — the sidebar's number, and
 * the one thing on this page a reader would want to see without opening it.
 */
export function countUnrestricted(picture: Picture): number {
  return coverageOf(
    picture.endpoints,
    picture.policies,
    picture.clusterwide
  ).filter(
    (one) => one.verdict === "unrestricted" || one.verdict === "onlyRejected"
  ).length;
}

export function usePicture() {
  const context = useClusterStore((state) => state.currentContext);
  return useQuery({
    queryKey: [context, ...PICTURE_KEY],
    queryFn: fetchPicture,
    staleTime: ROUTING_STALE,
  });
}
