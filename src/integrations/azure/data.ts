/**
 * What the AKS add-ons page reads.
 *
 * Both halves at once, because the page's job is to say which of the two
 * identity mechanisms this cluster is actually on. aad-pod-identity's kinds
 * are absent on any cluster built since its add-on went out of support in
 * September 2025; Workload ID has no kinds at all and is read from pods and
 * their ServiceAccounts. A page that read only the first would report a
 * modern AKS cluster as having no identities, which is how this vendor came
 * to describe a retired product.
 */

import { useQuery } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import { useClusterStore } from "@/stores/clusterStore";
import type { CustomResourceInfo } from "@/generated/types";
import { ROUTING_STALE } from "../ingress";
import {
  AZURE_IDENTITY_BINDING_CRD,
  AZURE_IDENTITY_CRD,
  PROHIBITED_TARGET_CRD,
} from "./model";
import {
  USE_LABEL,
  workloadIdentity,
  type WorkloadIdentity,
} from "./workload-identity";

export interface AksPicture {
  /** The retired add-on's objects, where a cluster still has them. */
  identities: CustomResourceInfo[];
  bindings: CustomResourceInfo[];
  prohibited: CustomResourceInfo[];
  /** Whether aad-pod-identity's kinds are served here at all. */
  legacyInstalled: boolean;
  workload: WorkloadIdentity;
}

const listKind = (crd: string) =>
  commands
    .listCustomResources(crd, null, null, null)
    // A kind this API server does not serve is none of that kind, which for
    // a retired add-on is the expected answer rather than a failure.
    .catch((): CustomResourceInfo[] => []);

export async function fetchAksPicture(): Promise<AksPicture> {
  const [identities, bindings, prohibited, pods] = await Promise.all([
    listKind(AZURE_IDENTITY_CRD),
    listKind(AZURE_IDENTITY_BINDING_CRD),
    listKind(PROHIBITED_TARGET_CRD),
    // Only the pods that opted in. The label is what makes the webhook act,
    // so it is also what bounds this read to the handful that matter.
    commands
      .listPods({
        namespace: null,
        labelSelector: `${USE_LABEL}=true`,
        fieldSelector: null,
        limit: null,
        statusFilter: null,
        selector: null,
        nodeName: null,
      })
      .catch(() => []),
  ]);

  return {
    identities,
    bindings,
    prohibited,
    legacyInstalled: identities.length > 0 || bindings.length > 0,
    workload: await workloadIdentity(pods),
  };
}

export const AKS_PICTURE_KEY = ["aks-addons", "picture"] as const;

export function useAksPicture() {
  const context = useClusterStore((state) => state.currentContext);
  return useQuery({
    queryKey: [context, ...AKS_PICTURE_KEY],
    queryFn: fetchAksPicture,
    staleTime: ROUTING_STALE,
  });
}

/** The sidebar's number: identities this cluster can actually hand out. */
export function countIdentities(picture: AksPicture): number {
  return picture.workload.accounts.length + picture.identities.length;
}
