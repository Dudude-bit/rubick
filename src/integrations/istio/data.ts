/**
 * What the Istio page reads.
 *
 * Three custom-resource lists and the two shared ones every routing page
 * uses. Nothing here is fetched until the reader opens the page or the
 * Integrations pane asks for the row's facts.
 */

import { useQuery } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import type { CustomResourceInfo } from "@/generated/types";
import { ROUTING_STALE, useBackingLists, type BackingLists } from "../ingress";
import { hostGroups, type IstioSources } from "./model";

export const GROUP = "networking.istio.io";

export const KINDS = {
  gateways: `gateways.${GROUP}`,
  virtualServices: `virtualservices.${GROUP}`,
  destinationRules: `destinationrules.${GROUP}`,
} as const;

function list(kind: string): Promise<CustomResourceInfo[]> {
  return commands.listCustomResources(kind, null, null, null);
}

export interface MeshSources {
  gateways: CustomResourceInfo[];
  virtualServices: CustomResourceInfo[];
  destinationRules: CustomResourceInfo[];
}

export async function fetchMesh(): Promise<MeshSources> {
  const [gateways, virtualServices, destinationRules] = await Promise.all([
    list(KINDS.gateways),
    list(KINDS.virtualServices),
    list(KINDS.destinationRules),
  ]);
  return { gateways, virtualServices, destinationRules };
}

/**
 * How many hosts this mesh routes — the sidebar's number.
 *
 * Hosts rather than VirtualServices, the same rule the other routing pages
 * follow: one VirtualService declaring four hosts is four answers to "what
 * serves this hostname", and a row reading `1` over a page with four rows
 * would be the rail contradicting the screen it opens.
 */
export function countHosts(mesh: MeshSources): number {
  return hostGroups({ ...mesh, services: [], published: [] }).length;
}

export const MESH_KEY = ["istio", "mesh"] as const;

export function useMesh() {
  return useQuery({
    queryKey: MESH_KEY,
    queryFn: fetchMesh,
    staleTime: ROUTING_STALE,
  });
}

export const useBacking = useBackingLists;

export function sourcesFrom(
  mesh: MeshSources,
  backing: BackingLists | undefined
): IstioSources {
  return {
    ...mesh,
    services: backing?.services ?? [],
    published: backing?.published ?? [],
    backingKnown: backing !== undefined,
  };
}
