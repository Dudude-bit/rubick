import { useQuery } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import { normalizeTauriError } from "@/lib/error-utils";
import { useClusterStore } from "@/stores/clusterStore";
import type { CustomResourceInfo, DeploymentInfo } from "@/generated/types";

export const GROUP = "scylla.scylladb.com";
export const CLUSTERS_CRD = `scyllaclusters.${GROUP}`;
export const NODE_CONFIGS_CRD = `nodeconfigs.${GROUP}`;

const OPERATOR_SELECTOR = "app.kubernetes.io/name=scylla-operator";
const MANAGER_SELECTOR = "app.kubernetes.io/name=scylla-manager";

export const SCYLLA_STALE = 30_000;
export const CLUSTERS_KEY = ["scylla", "clusters"] as const;

export type Read<T> = { ok: true; items: T[] } | { ok: false; reason: string };

async function read<T>(fetch: () => Promise<T[]>): Promise<Read<T>> {
  try {
    return { ok: true, items: await fetch() };
  } catch (error) {
    return { ok: false, reason: normalizeTauriError(error) };
  }
}

export function fetchClusters(): Promise<CustomResourceInfo[]> {
  return commands.listCustomResources(CLUSTERS_CRD, null, null, null);
}

export function useClusters() {
  const context = useClusterStore((state) => state.currentContext);
  return useQuery({
    queryKey: [context, ...CLUSTERS_KEY],
    queryFn: fetchClusters,
    staleTime: SCYLLA_STALE,
  });
}

export function useNodeConfigs() {
  const context = useClusterStore((state) => state.currentContext);
  return useQuery({
    queryKey: [context, "scylla", "nodeconfigs"],
    queryFn: () =>
      read(() =>
        commands.listCustomResources(NODE_CONFIGS_CRD, null, null, null)
      ),
    staleTime: SCYLLA_STALE,
  });
}

export interface Controller {
  name: string;
  namespace: string;
  ready: number;
  desired: number;
  image: string | null;
}

export interface OperatorInfo {
  operator: Controller | null;
  /** ScyllaDB Manager: without it `spec.repairs` and `spec.backups` are ignored. */
  manager: Controller | null;
  version: string | null;
  canPatchClusters: boolean | null;
  checkedAt: number;
}

function controllerOf(
  deployment: DeploymentInfo | undefined
): Controller | null {
  if (!deployment) return null;
  return {
    name: deployment.name,
    namespace: deployment.namespace,
    ready: deployment.replicas.ready,
    desired: deployment.replicas.desired,
    image: deployment.containers[0]?.image ?? null,
  };
}

function versionOf(image: string | null): string | null {
  if (!image) return null;
  const tag = image.split("@")[0].split(":").pop() ?? "";
  return /^v?\d/.test(tag) ? tag.replace(/^v/, "") : null;
}

const byLabel = (labelSelector: string) =>
  commands
    .listDeployments({
      namespace: null,
      labelSelector,
      fieldSelector: null,
      limit: null,
    })
    .catch((): DeploymentInfo[] => []);

export function useOperator() {
  const context = useClusterStore((state) => state.currentContext);
  return useQuery({
    queryKey: [context, "scylla", "operator"],
    queryFn: async (): Promise<OperatorInfo> => {
      const [operators, managers, access] = await Promise.all([
        byLabel(OPERATOR_SELECTOR),
        byLabel(MANAGER_SELECTOR),
        commands
          .checkAccess([
            {
              group: GROUP,
              resource: "scyllaclusters",
              verb: "patch",
              namespace: null,
            },
          ])
          .catch(() => null),
      ]);
      const operator = controllerOf(operators[0]);
      return {
        operator,
        manager: controllerOf(managers[0]),
        version: versionOf(operator?.image ?? null),
        canPatchClusters: access?.[0]?.allowed ?? null,
        checkedAt: Date.now(),
      };
    },
    staleTime: SCYLLA_STALE,
  });
}
