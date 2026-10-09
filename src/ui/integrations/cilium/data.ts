/**
 * What the Cilium row reads: the policy kinds, and nothing else.
 *
 * Endpoints and identities are one per pod and one per label set, so a
 * cluster of any size has thousands of them; the row is glanced at, and a
 * count of those would cost more than it says. The CRD pages read them.
 */

import { useQuery } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import { errorToShow } from "@/lib/error-utils";
import { useClusterStore } from "@/stores/clusterStore";
import { ROUTING_STALE } from "../ingress";
import { coverageOf, type KubernetesPolicies } from "./coverage";
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

/**
 * The standard NetworkPolicies, settled: a refused read is carried as the
 * reason, so the page can say "cannot say" rather than fail whole or, worse,
 * read on as if there were none.
 */
async function kubernetesPolicies(): Promise<KubernetesPolicies> {
  try {
    const read = await commands.listNetworkPoliciesIn(null);
    return { read: true, policies: read.rows, unread: read.unread };
  } catch (error) {
    return { read: false, why: errorToShow(error) };
  }
}

/** The page's read: every policy kind Cilium enforces, and the endpoints. */
export interface Picture extends PolicySources {
  endpoints: CustomResourceInfo[];
  kubernetes: KubernetesPolicies;
}

export async function fetchPicture(): Promise<Picture> {
  const [policies, clusterwide, endpoints, kubernetes] = await Promise.all([
    list(KINDS.policies),
    list(KINDS.clusterwide),
    list(KINDS.endpoints),
    kubernetesPolicies(),
  ]);
  return { policies, clusterwide, endpoints, kubernetes };
}

export function pictureCoverage(picture: Picture) {
  return coverageOf(
    picture.endpoints,
    picture.policies,
    picture.clusterwide,
    picture.kubernetes
  );
}

export const PICTURE_KEY = ["cilium", "picture"] as const;

/**
 * How many endpoints no enforcing policy selects — the sidebar's number, and
 * the one thing on this page a reader would want to see without opening it.
 */
export function countUnrestricted(picture: Picture): number {
  return pictureCoverage(picture).filter(
    (one) => one.verdict === "unrestricted" || one.verdict === "onlyRejected"
  ).length;
}

/**
 * The dot beside that number. An endpoint a policy might select, and whose
 * rules could not be read, is left out of the count — which is only honest
 * if something beside it says so.
 */
export function coverageTone(picture: Picture): "unchecked" | null {
  return pictureCoverage(picture).some((one) => one.verdict === "cannotSay")
    ? "unchecked"
    : null;
}

export function usePicture() {
  const context = useClusterStore((state) => state.currentContext);
  return useQuery({
    queryKey: [context, ...PICTURE_KEY],
    queryFn: fetchPicture,
    staleTime: ROUTING_STALE,
  });
}
