import { useQuery } from "@tanstack/react-query";

import { useLiveQuery } from "@/hooks/useLiveQuery";

import { askAccess, type Asked } from "@/lib/access";
import { commands } from "@/lib/commands";
import { errorToShow } from "@/lib/error-utils";
import { useClusterStore } from "@/stores/clusterStore";
import type { CustomResourceInfo, DeploymentInfo } from "@/generated/types";

export const GROUP = "postgresql.cnpg.io";
export const CLUSTERS_CRD = `clusters.${GROUP}`;
export const BACKUPS_CRD = `backups.${GROUP}`;
export const SCHEDULED_BACKUPS_CRD = `scheduledbackups.${GROUP}`;
export const POOLERS_CRD = `poolers.${GROUP}`;

/** The operator labels its own Deployment; the namespace is the installer's choice. */
const CONTROLLER_SELECTOR = "app.kubernetes.io/name=cloudnative-pg";

export const CNPG_STALE = 30_000;

/**
 * A Cluster's phase, its primary and its archiving condition all turn over
 * on the operator's clock, not on a deploy — this page is watched during a
 * switchover. Plain `useQuery` with a stale time refetched only on a
 * remount, so the page sat on its first answer for as long as it was open
 * and "checked for you" just counted upwards.
 */
const CNPG_REFRESH = "resourceList" as const;
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
    return { ok: false, reason: errorToShow(error) };
  }
}

const listAll = (crd: string) =>
  commands.listCustomResources(crd, null, null, null);

export function fetchClusters(): Promise<CustomResourceInfo[]> {
  return listAll(CLUSTERS_CRD);
}

export function useClusters() {
  const context = useClusterStore((state) => state.currentContext);
  return useLiveQuery({
    refresh: CNPG_REFRESH,
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
  return useLiveQuery({
    refresh: CNPG_REFRESH,
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

export interface Controller {
  name: string;
  namespace: string;
  ready: number;
  desired: number;
  image: string | null;
}

export interface OperatorInfo {
  /** `null` when no Deployment carries the operator's label. */
  controller: Controller | null;
  /**
   * Whether `controller` is an answer. `false` says the Deployment list was
   * refused or failed — and a reader who may see CNPG's Clusters but not the
   * cluster's Deployments is an ordinary RBAC user, for whom "no Deployment
   * carries the operator's label" was a confident lie about a read that
   * never happened.
   */
  controllerKnown: boolean;
  /** The cluster's own words for why, when it would not say. */
  controllerReason: string | null;
  /** From the image tag; the CRDs' label is the fallback the catalog uses. */
  version: string | null;
  /**
   * Cluster-wide `patch clusters` / `create backups`; `null` = the cluster
   * would not say. A `false` here is not "you may not act" — see `patchOn`.
   */
  canPatchClusters: boolean | null;
  canCreateBackups: boolean | null;
  /** `patch`, of each Cluster by name; `create backups`, per namespace. */
  patchOn: Allowed;
  createIn: Allowed;
  checkedAt: number;
}

function versionOf(image: string | null): string | null {
  if (!image) return null;
  // The tag is what follows the LAST colon *after* the last slash. A
  // registry may carry a port — `registry.internal:5000/cnpg/postgresql` —
  // and splitting the whole reference on ":" then reported 5000 as the
  // version of PostgreSQL.
  const ref = image.split("@")[0];
  const lastSlash = ref.lastIndexOf("/");
  const namePart = ref.slice(lastSlash + 1);
  const colon = namePart.lastIndexOf(":");
  const tag = colon === -1 ? "" : namePart.slice(colon + 1);
  return /^v?\d/.test(tag) ? tag.replace(/^v/, "") : null;
}

/**
 * Whether the reader may act, asked of each Cluster they have — plus
 * cluster-wide.
 *
 * A `SelfSubjectAccessReview` with no namespace asks "in every namespace",
 * and one with no name asks "whatever it is called": a reader granted
 * `patch clusters` in their own namespace, or on one named Cluster, answers
 * no to those. Asked that way, every action on every cluster came up
 * disabled with "the cluster refuses this", which is a different sentence
 * from the truth and the opposite of useful.
 */
type Allowed = Map<string, boolean | null>;

interface Named {
  namespace: string;
  name: string;
}

const keyOf = (cluster: Named) => `${cluster.namespace}/${cluster.name}`;

/**
 * What the reader may do to one Cluster. `null` where the review would not
 * say or was not asked about it: the cluster-wide answer is not this one's.
 */
export function allowedOn(operator: OperatorInfo | undefined, cluster: Named) {
  return {
    patchClusters: operator?.patchOn.get(keyOf(cluster)) ?? null,
    createBackups: operator?.createIn.get(cluster.namespace) ?? null,
  };
}

export function useOperator(clusters: readonly Named[] = []) {
  const context = useClusterStore((state) => state.currentContext);
  const keys = [...new Set(clusters.map(keyOf))].sort();
  return useQuery({
    queryKey: [context, "cloudnativepg", "operator", keys.join(",")],
    queryFn: async (): Promise<OperatorInfo> => {
      const named = keys.map((key) => {
        const [namespace, name] = key.split("/");
        return { namespace, name };
      });
      const namespaces = [...new Set(named.map((one) => one.namespace))];
      const patch = {
        group: GROUP,
        resource: "clusters",
        verb: "patch",
      } as const;
      // A create carries no name to match.
      const create = {
        group: GROUP,
        resource: "backups",
        verb: "create",
        name: null,
      } as const;
      const asked: Asked[] = [
        // Cluster-wide first, so the Operator tab still has one answer to
        // state: every Cluster, and so no name.
        { ...patch, namespace: null, name: null },
        { ...create, namespace: null },
        ...named.map((one) => ({ ...patch, ...one })),
        ...namespaces.map((namespace) => ({ ...create, namespace })),
      ];
      const [deployments, access] = await Promise.all([
        read<DeploymentInfo>(() =>
          commands.listDeployments({
            namespace: null,
            labelSelector: CONTROLLER_SELECTOR,
            fieldSelector: null,
            limit: null,
          })
        ),
        askAccess(asked).catch(() => null),
      ]);
      const answered = (from: number, keys: string[]): Allowed =>
        new Map(keys.map((key, at) => [key, access?.[from + at] ?? null]));
      const deployment = deployments.ok ? (deployments.items[0] ?? null) : null;
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
        controllerKnown: deployments.ok,
        controllerReason: deployments.ok ? null : deployments.reason,
        version: versionOf(deployment?.containers[0]?.image ?? null),
        canPatchClusters: access?.[0] ?? null,
        canCreateBackups: access?.[1] ?? null,
        patchOn: answered(2, keys),
        createIn: answered(2 + keys.length, namespaces),
        checkedAt: Date.now(),
      };
    },
    staleTime: CNPG_STALE,
  });
}
