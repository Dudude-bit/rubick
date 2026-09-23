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
import { ERROR_CODES, errorCode, errorToShow } from "@/lib/error-utils";
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
  /** Whether aad-pod-identity's kinds are served here; `null` where one of
   *  them could not be read and none was found. */
  legacyInstalled: boolean | null;
  workload: WorkloadIdentity;
  /** False where the labelled pods could not be listed: then "no pod asks
   *  for an identity" is not something this page knows. */
  podsKnown: boolean;
  /** Reads that failed for a reason other than the kind not being served. */
  unread: Array<{ what: string; reason: string }>;
}

async function listKind(
  crd: string,
  unread: AksPicture["unread"]
): Promise<CustomResourceInfo[]> {
  try {
    return await commands.listCustomResources(crd, null, null, null);
  } catch (error) {
    // A kind this API server does not serve is none of that kind, which for
    // a retired add-on is the expected answer. Anything else — a refusal
    // above all — is not: it is a list nobody read.
    if (errorCode(error) !== ERROR_CODES.NOT_FOUND) {
      unread.push({ what: crd, reason: errorToShow(error) });
    }
    return [];
  }
}

export async function fetchAksPicture(): Promise<AksPicture> {
  const unread: AksPicture["unread"] = [];
  let podsKnown = true;
  const [identities, bindings, prohibited, pods] = await Promise.all([
    listKind(AZURE_IDENTITY_CRD, unread),
    listKind(AZURE_IDENTITY_BINDING_CRD, unread),
    listKind(PROHIBITED_TARGET_CRD, unread),
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
      .catch((error: unknown) => {
        podsKnown = false;
        unread.push({ what: "Pod", reason: errorToShow(error) });
        return [];
      }),
  ]);

  const legacyFound = identities.length > 0 || bindings.length > 0;
  return {
    identities,
    bindings,
    prohibited,
    legacyInstalled:
      legacyFound || !unread.some((read) => read.what !== "Pod")
        ? legacyFound
        : null,
    workload: await workloadIdentity(pods),
    podsKnown,
    unread,
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
