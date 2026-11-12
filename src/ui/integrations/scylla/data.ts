import { useQuery } from "@tanstack/react-query";

import { useLiveQuery } from "@/hooks/useLiveQuery";

import { askAccess, type Asked } from "@/lib/access";
import { commands } from "@/lib/commands";
import { errorToShow } from "@/lib/error-utils";
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
    return { ok: false, reason: errorToShow(error) };
  }
}

export function fetchClusters(): Promise<CustomResourceInfo[]> {
  return commands.listCustomResources(CLUSTERS_CRD, null, null, null);
}

export function useClusters() {
  const context = useClusterStore((state) => state.currentContext);
  return useLiveQuery({
    // A ScyllaCluster's racks and conditions turn over on the operator's
    // clock. `useQuery` with a stale time refetches only on a remount, so
    // this page sat on its first answer for as long as it was open.
    refresh: "resourceList",
    queryKey: [context, ...CLUSTERS_KEY],
    queryFn: fetchClusters,
    staleTime: SCYLLA_STALE,
  });
}

export function useNodeConfigs() {
  const context = useClusterStore((state) => state.currentContext);
  return useLiveQuery({
    refresh: "resourceList",
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
  /**
   * Whether `operator` is an answer. `false` says the Deployment list was
   * refused or failed — not that no operator is running.
   */
  operatorKnown: boolean;
  operatorReason: string | null;
  /** ScyllaDB Manager: without it `spec.repairs` and `spec.backups` are ignored. */
  manager: Controller | null;
  managerKnown: boolean;
  managerReason: string | null;
  version: string | null;
  /** Cluster-wide; a `false` here is not "you may not act" — see `patchOn`. */
  canPatchClusters: boolean | null;
  /** The same verb, of each ScyllaCluster by name. */
  patchOn: Map<string, boolean | null>;
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
  // The tag is what follows the last colon *after* the last slash: a
  // registry may carry a port — `registry.internal:5000/scylla-operator` —
  // and splitting the whole reference reported 5000 as the version.
  const ref = image.split("@")[0];
  const namePart = ref.slice(ref.lastIndexOf("/") + 1);
  const colon = namePart.lastIndexOf(":");
  const tag = colon === -1 ? "" : namePart.slice(colon + 1);
  return /^v?\d/.test(tag) ? tag.replace(/^v/, "") : null;
}

const byLabel = (labelSelector: string) =>
  read<DeploymentInfo>(() =>
    commands.listDeployments({
      namespace: null,
      labelSelector,
      fieldSelector: null,
      limit: null,
    })
  );

/**
 * Whether the reader may patch, asked of each ScyllaCluster they have.
 *
 * A `SelfSubjectAccessReview` with no namespace asks "in every namespace",
 * and one with no name asks "whatever it is called": a grant in one
 * namespace, or on one named cluster, answers no to those — and every knob
 * on their own cluster then came up disabled saying the cluster refuses it.
 */
interface Named {
  namespace: string;
  name: string;
}

const keyOf = (cluster: Named) => `${cluster.namespace}/${cluster.name}`;

/**
 * Whether the reader may patch one ScyllaCluster. `null` where the review
 * would not say or was not asked about it: the cluster-wide answer is not
 * this one's.
 */
export function patchAllowedOn(
  operator: OperatorInfo | undefined,
  cluster: Named
): boolean | null {
  return operator?.patchOn.get(keyOf(cluster)) ?? null;
}

export function useOperator(clusters: readonly Named[] = []) {
  const context = useClusterStore((state) => state.currentContext);
  const keys = [...new Set(clusters.map(keyOf))].sort();
  return useQuery({
    queryKey: [context, "scylla", "operator", keys.join(",")],
    queryFn: async (): Promise<OperatorInfo> => {
      const patch = {
        group: GROUP,
        resource: "scyllaclusters",
        verb: "patch",
      } as const;
      const asked: Asked[] = [
        // Cluster-wide first, for the Operator tab: every one, so no name.
        { ...patch, namespace: null, name: null },
        ...keys.map((key) => {
          const [namespace, name] = key.split("/");
          return { ...patch, namespace, name };
        }),
      ];
      const [operators, managers, access] = await Promise.all([
        byLabel(OPERATOR_SELECTOR),
        byLabel(MANAGER_SELECTOR),
        askAccess(asked).catch(() => null),
      ]);
      const operator = operators.ok ? controllerOf(operators.items[0]) : null;
      return {
        operator,
        // Whether that is an answer. A reader who may see the Scylla CRs but
        // not the cluster's Deployments — an ordinary namespace-scoped RBAC
        // user — was told the operator is not installed and that Manager is
        // absent, about reads nobody got.
        operatorKnown: operators.ok,
        operatorReason: operators.ok ? null : operators.reason,
        manager: managers.ok ? controllerOf(managers.items[0]) : null,
        managerKnown: managers.ok,
        managerReason: managers.ok ? null : managers.reason,
        version: versionOf(operator?.image ?? null),
        canPatchClusters: access?.[0] ?? null,
        patchOn: new Map(
          keys.map((key, at) => [key, access?.[1 + at] ?? null])
        ),
        checkedAt: Date.now(),
      };
    },
    staleTime: SCYLLA_STALE,
  });
}
