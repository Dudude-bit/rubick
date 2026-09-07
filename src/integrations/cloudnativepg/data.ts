import { useQuery } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import { normalizeTauriError } from "@/lib/error-utils";
import { useClusterStore } from "@/stores/clusterStore";
import type { CustomResourceInfo, DeploymentInfo } from "@/generated/types";

export const GROUP = "postgresql.cnpg.io";
export const CLUSTERS_CRD = `clusters.${GROUP}`;
export const BACKUPS_CRD = `backups.${GROUP}`;
export const SCHEDULED_BACKUPS_CRD = `scheduledbackups.${GROUP}`;
export const POOLERS_CRD = `poolers.${GROUP}`;
export const DATABASES_CRD = `databases.${GROUP}`;

/** The operator labels its own Deployment; the namespace is the installer's choice. */
const CONTROLLER_SELECTOR = "app.kubernetes.io/name=cloudnative-pg";

export const CNPG_STALE = 30_000;
export const CLUSTERS_KEY = ["cloudnativepg", "clusters"] as const;

/**
 * A list, or the reason there is none. A kind that could not be read is
 * not a kind with nothing in it: "no backups" on the back of a 403 is the
 * sentence this page must never print.
 */
export type Read<T> = { ok: true; items: T[] } | { ok: false; reason: string };

async function read<T>(fetch: () => Promise<T[]>): Promise<Read<T>> {
  try {
    return { ok: true, items: await fetch() };
  } catch (error) {
    return { ok: false, reason: normalizeTauriError(error) };
  }
}

const listAll = (crd: string) =>
  commands.listCustomResources(crd, null, null, null);

export function fetchClusters(): Promise<CustomResourceInfo[]> {
  return listAll(CLUSTERS_CRD);
}

export function useClusters() {
  const context = useClusterStore((state) => state.currentContext);
  return useQuery({
    queryKey: [context, ...CLUSTERS_KEY],
    queryFn: fetchClusters,
    staleTime: CNPG_STALE,
  });
}

/** The three companions of a cluster, each honest about not being read. */
export interface Companions {
  backups: Read<CustomResourceInfo>;
  scheduled: Read<CustomResourceInfo>;
  poolers: Read<CustomResourceInfo>;
}

export function useCompanions() {
  const context = useClusterStore((state) => state.currentContext);
  return useQuery({
    queryKey: [context, "cloudnativepg", "companions"],
    queryFn: async (): Promise<Companions> => {
      const [backups, scheduled, poolers] = await Promise.all([
        read(() => listAll(BACKUPS_CRD)),
        read(() => listAll(SCHEDULED_BACKUPS_CRD)),
        read(() => listAll(POOLERS_CRD)),
      ]);
      return { backups, scheduled, poolers };
    },
    staleTime: CNPG_STALE,
  });
}

export interface OperatorInfo {
  /** `null` when no Deployment carries the operator's label. */
  controller: {
    name: string;
    namespace: string;
    ready: number;
    desired: number;
    image: string | null;
  } | null;
  /** From the image tag; the CRDs' label is the fallback the catalog uses. */
  version: string | null;
  /** Whether `patch clusters` and `create backups` are allowed; `null` = the cluster would not say. */
  canPatchClusters: boolean | null;
  canCreateBackups: boolean | null;
  checkedAt: number;
}

function versionOf(image: string | null): string | null {
  if (!image) return null;
  const tag = image.split("@")[0].split(":").pop() ?? "";
  return /^v?\d/.test(tag) ? tag.replace(/^v/, "") : null;
}

export function useOperator() {
  const context = useClusterStore((state) => state.currentContext);
  return useQuery({
    queryKey: [context, "cloudnativepg", "operator"],
    queryFn: async (): Promise<OperatorInfo> => {
      const [deployments, access] = await Promise.all([
        commands
          .listDeployments({
            namespace: null,
            labelSelector: CONTROLLER_SELECTOR,
            fieldSelector: null,
            limit: null,
          })
          .catch((): DeploymentInfo[] => []),
        commands
          .checkAccess([
            {
              group: GROUP,
              resource: "clusters",
              verb: "patch",
              namespace: null,
            },
            {
              group: GROUP,
              resource: "backups",
              verb: "create",
              namespace: null,
            },
          ])
          .catch(() => null),
      ]);
      const deployment = deployments[0] ?? null;
      return {
        controller: deployment
          ? {
              name: deployment.name,
              namespace: deployment.namespace,
              ready: deployment.replicas.ready,
              desired: deployment.replicas.desired,
              image: deployment.containers[0]?.image ?? null,
            }
          : null,
        version: versionOf(deployment?.containers[0]?.image ?? null),
        canPatchClusters: access?.[0]?.allowed ?? null,
        canCreateBackups: access?.[1]?.allowed ?? null,
        checkedAt: Date.now(),
      };
    },
    staleTime: CNPG_STALE,
  });
}
