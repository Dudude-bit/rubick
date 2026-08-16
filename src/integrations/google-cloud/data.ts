/**
 * What the GKE Ingress page reads.
 *
 * Four cluster-wide lists and the two the every routing page already shares.
 * The three custom resources are listed rather than fetched per Ingress on
 * purpose: a page with twenty hosts on it would otherwise make sixty `get`
 * calls to resolve annotations that name at most a handful of objects, and
 * the lists are the same three requests whatever the page holds.
 *
 * Each of the three is caught separately. A cluster with `BackendConfig`
 * installed and `ManagedCertificate` not is a real GKE cluster — the CRDs
 * come from two different controllers, and one being absent must cost the
 * page that column rather than the whole page.
 */

import { useQuery } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import type { CustomResourceInfo, IngressInfo } from "@/generated/types";
import { ROUTING_STALE, useBackingLists } from "../ingress";
import {
  BACKEND_CONFIG_CRD,
  FRONTEND_CONFIG_CRD,
  MANAGED_CERTIFICATE_CRD,
} from "./model";

export interface IngressSources {
  ingresses: IngressInfo[];
  backendConfigs: CustomResourceInfo[];
  frontendConfigs: CustomResourceInfo[];
  managedCertificates: CustomResourceInfo[];
  /**
   * The kinds that could not be listed, and why.
   *
   * Not an empty list quietly: a token that cannot read `ManagedCertificate`
   * would otherwise produce a page stating that no Ingress carries one,
   * which is the same class of lie this whole tier keeps being fixed for.
   */
  unread: Array<{ crd: string; reason: string }>;
}

const listKind = async (
  crd: string,
  unread: IngressSources["unread"]
): Promise<CustomResourceInfo[]> => {
  try {
    return await commands.listCustomResources(crd, null, null, null);
  } catch (error) {
    unread.push({
      crd,
      reason: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
};

export async function fetchIngressSources(): Promise<IngressSources> {
  const unread: IngressSources["unread"] = [];
  const [ingresses, backendConfigs, frontendConfigs, managedCertificates] =
    await Promise.all([
      commands.listIngresses(null),
      listKind(BACKEND_CONFIG_CRD, unread),
      listKind(FRONTEND_CONFIG_CRD, unread),
      listKind(MANAGED_CERTIFICATE_CRD, unread),
    ]);
  return {
    ingresses,
    backendConfigs,
    frontendConfigs,
    managedCertificates,
    unread,
  };
}

export const INGRESS_SOURCES_KEY = ["gke-ingress", "sources"] as const;

export function useIngressSources() {
  return useQuery({
    queryKey: INGRESS_SOURCES_KEY,
    queryFn: fetchIngressSources,
    staleTime: ROUTING_STALE,
  });
}

/** The same Services and endpoints every other routing page reads. */
export const useBacking = useBackingLists;
