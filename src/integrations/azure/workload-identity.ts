/**
 * Which pods can become which Azure identity — read the way AKS does it now.
 *
 * The rest of this vendor is built on aad-pod-identity's three CRDs, and that
 * product is gone: the open-source project was deprecated in October 2022 and
 * archived in September 2023, and the managed AKS add-on was supported only
 * through September 2025. On a cluster built since, all three kinds are
 * absent — so the app looked at a modern AKS cluster, found nothing, and
 * correctly reported nothing, while the identities were right there.
 *
 * Its replacement has **no CRDs at all**, which is why nothing here reads
 * one. Microsoft Entra Workload ID is two pieces of ordinary metadata:
 *
 * - a `ServiceAccount` annotated `azure.workload.identity/client-id` with the
 *   client id of a user-assigned managed identity
 * - a pod (usually via its workload's template) labelled
 *   `azure.workload.identity/use: "true"`, which is what makes the webhook
 *   project a token for it
 *
 * Both halves are required and each is silent without the other, which is the
 * whole reason this is worth drawing. A labelled pod on a ServiceAccount with
 * no annotation gets a projected token for no identity, and every call it
 * makes to Azure fails with a 401 that has no Kubernetes symptom at all —
 * exactly the silence the aad-pod-identity dangling-binding check existed to
 * break.
 *
 * ## Read from the pods, and what that costs
 *
 * There is no `list_service_accounts` command and no `ServiceAccountInfo`
 * type, so the walk starts at the labelled pods and reads the manifest of
 * each distinct ServiceAccount they name — a bounded handful of `get`s rather
 * than a cluster-wide list.
 *
 * The consequence is stated rather than hidden: **a ServiceAccount carrying
 * the annotation with no labelled pod is not found this way.** That is the
 * harmless half of the pair — an identity nobody uses grants nothing to
 * nobody — and the dangerous half, a pod that will get 401s, is exactly what
 * starting from the pods finds first.
 */

import { load } from "js-yaml";

import { commands } from "@/lib/commands";
import type { PodInfo } from "@/generated/types";

export const CLIENT_ID_ANNOTATION = "azure.workload.identity/client-id";
export const TENANT_ID_ANNOTATION = "azure.workload.identity/tenant-id";
export const USE_LABEL = "azure.workload.identity/use";

/** A ServiceAccount that names an Azure identity. */
export interface FederatedAccount {
  name: string;
  namespace: string;
  clientId: string;
  tenantId: string | null;
  /** Pods that carry the label, so the webhook projects a token for them. */
  pods: Array<{ name: string; namespace: string }>;
}

export type IdentityFinding = {
  kind: "no-identity";
  severity: "err";
  pod: { name: string; namespace: string };
  account: string;
};

export interface WorkloadIdentity {
  accounts: FederatedAccount[];
  findings: IdentityFinding[];
}

const usesIdentity = (pod: PodInfo): boolean =>
  pod.labels[USE_LABEL] === "true";

/** The two annotations a ServiceAccount carries, from its own manifest. */
async function federationOf(
  namespace: string,
  name: string
): Promise<{ clientId: string; tenantId: string | null } | null> {
  try {
    const manifest = await commands.getManifest(
      "ServiceAccount",
      "v1",
      name,
      namespace
    );
    const parsed = load(manifest) as
      { metadata?: { annotations?: Record<string, string> } } | undefined;
    const annotations = parsed?.metadata?.annotations ?? {};
    const clientId = annotations[CLIENT_ID_ANNOTATION];
    if (!clientId) return null;
    return { clientId, tenantId: annotations[TENANT_ID_ANNOTATION] || null };
  } catch {
    // A ServiceAccount this token cannot read is not one that grants no
    // identity, so nothing is claimed about it either way.
    return null;
  }
}

export async function workloadIdentity(
  pods: PodInfo[]
): Promise<WorkloadIdentity> {
  const labelled = pods.filter(usesIdentity);
  const wanted = [
    ...new Set(
      // A pod naming no ServiceAccount runs as `default`, which is what the
      // webhook looks at too.
      labelled.map(
        (pod) => `${pod.namespace}/${pod.serviceAccountName || "default"}`
      )
    ),
  ];

  const federation = new Map(
    await Promise.all(
      wanted.map(async (at) => {
        const [namespace, name] = at.split("/");
        return [at, await federationOf(namespace, name)] as const;
      })
    )
  );

  const podsFor = new Map<string, Array<{ name: string; namespace: string }>>();
  const findings: IdentityFinding[] = [];

  for (const pod of labelled) {
    const account = pod.serviceAccountName || "default";
    const at = `${pod.namespace}/${account}`;
    if (!federation.get(at)) {
      findings.push({
        kind: "no-identity",
        severity: "err",
        pod: { name: pod.name, namespace: pod.namespace },
        account,
      });
      continue;
    }
    podsFor.set(at, [
      ...(podsFor.get(at) ?? []),
      { name: pod.name, namespace: pod.namespace },
    ]);
  }

  const accounts = [...federation.entries()].flatMap(
    ([at, found]): FederatedAccount[] => {
      if (!found) return [];
      const [namespace, name] = at.split("/");
      return [
        {
          name,
          namespace,
          clientId: found.clientId,
          tenantId: found.tenantId,
          pods: podsFor.get(at) ?? [],
        },
      ];
    }
  );

  return {
    accounts: accounts.sort(
      (left, right) =>
        right.pods.length - left.pods.length ||
        `${left.namespace}/${left.name}`.localeCompare(
          `${right.namespace}/${right.name}`
        )
    ),
    findings,
  };
}
