import type { AggregationInfo, BindingInfo, Scoped } from "@/generated/types";
import { useLiveQueries, useLiveQuery } from "@/hooks/useLiveQuery";
import { commands } from "@/lib/commands";
import { errorCode, errorToShow } from "@/lib/error-utils";
import { queryKeys } from "@/lib/query-keys";
import { useClusterStore } from "@/stores/clusterStore";
import {
  aggregatorsOf,
  rulesOf,
  type Aggregators,
  type RbacTarget,
  type Rule,
} from "./rbac";

/** A binding list, or one namespace of it, that could not be read. */
export interface Gap {
  kind: BindingKind;
  /** `null` for a read across the whole cluster. */
  namespace: string | null;
  error: unknown;
}

export interface BindingLists {
  loading: boolean;
  bindings: BindingInfo[];
  /** Empty only when every list asked for was read in full. */
  gaps: Gap[];
  retry: () => void;
}

export type BindingKind = "RoleBinding" | "ClusterRoleBinding";

/**
 * RoleBindings in `namespaces` (`null` for every one) and, when asked, the
 * ClusterRoleBindings. What could not be read is a gap, never an absence.
 */
export function useBindingLists(
  namespaces: string[] | null,
  withClusterBindings: boolean
): BindingLists {
  const isConnected = useClusterStore((state) => state.isConnected);
  const roleBindings = useLiveQuery<Scoped<BindingInfo>>({
    queryKey: queryKeys.roleBindings(namespaces),
    queryFn: () => commands.listRoleBindingsIn(namespaces),
    enabled: isConnected,
    refresh: "steady",
  });
  const clusterBindings = useLiveQuery<BindingInfo[]>({
    queryKey: queryKeys.clusterRoleBindings(),
    queryFn: () => commands.listClusterRoleBindings(),
    enabled: isConnected && withClusterBindings,
    refresh: "steady",
  });

  const gaps: Gap[] = [];
  if (roleBindings.error && !roleBindings.data)
    gaps.push({
      kind: "RoleBinding",
      namespace: namespaces ? namespaces.join(", ") : null,
      error: roleBindings.error,
    });
  for (const unread of roleBindings.data?.unread ?? [])
    gaps.push({
      kind: "RoleBinding",
      namespace: unread.namespace,
      error: unread,
    });
  if (withClusterBindings && clusterBindings.error && !clusterBindings.data)
    gaps.push({
      kind: "ClusterRoleBinding",
      namespace: null,
      error: clusterBindings.error,
    });

  return {
    loading:
      roleBindings.isLoading ||
      (withClusterBindings && clusterBindings.isLoading),
    bindings: [
      ...(withClusterBindings ? (clusterBindings.data ?? []) : []),
      ...(roleBindings.data?.rows ?? []),
    ],
    gaps,
    retry: () => {
      void roleBindings.refetch();
      if (withClusterBindings) void clusterBindings.refetch();
    },
  };
}

export type RoleReading =
  | { state: "read"; rules: Rule[] }
  | { state: "missing" }
  | { state: "unread"; error: { code: string; message: string } };

async function readRole(target: RbacTarget): Promise<RoleReading> {
  try {
    const role = await commands.getServedObject(
      target.group,
      target.plural,
      target.name,
      target.namespace
    );
    return { state: "read", rules: rulesOf(role as Record<string, unknown>) };
  } catch (error) {
    if (errorCode(error) === "NOT_FOUND") return { state: "missing" };
    return {
      state: "unread",
      error: { code: errorCode(error), message: errorToShow(error) },
    };
  }
}

/** Each role's rules, in the order asked, `undefined` until it answers. */
export function useRoleReadings(targets: RbacTarget[]): {
  readings: Array<RoleReading | undefined>;
  retry: () => void;
} {
  const isConnected = useClusterStore((state) => state.isConnected);
  const roles = useLiveQueries<RoleReading>({
    queries: targets.map((target) => ({
      queryKey: queryKeys.roleReading(
        target.kind,
        target.namespace,
        target.name
      ),
      queryFn: () => readRole(target),
      enabled: isConnected,
    })),
    refresh: "steady",
  });
  return { readings: roles.data, retry: roles.refetch };
}

/** Whether other ClusterRoles gather a role: read, still being read, or not readable. */
export type AggregationReading = (
  | { state: "reading" }
  | ({ state: "read" } & Aggregators)
  | { state: "unread"; error: unknown }
) & { retry: () => void };

const NOT_AGGREGATED: Aggregators = { through: [], unknown: [] };

/**
 * The ClusterRoles a ClusterRole's rules are aggregated into. A list of
 * ClusterRoles that could not be read is "unread", never "none": the role
 * would read as granted to nobody while everyone bound to `edit` holds it.
 * `null` asks nothing: only a ClusterRole is aggregated.
 */
export function useAggregators(clusterRole: string | null): AggregationReading {
  const isConnected = useClusterStore((state) => state.isConnected);
  const { data, error, refetch } = useLiveQuery<AggregationInfo[]>({
    queryKey: queryKeys.clusterRoleAggregation(),
    queryFn: () => commands.listClusterRoleAggregation(),
    enabled: isConnected && clusterRole !== null,
    refresh: "steady",
  });
  const retry = () => void refetch();
  if (clusterRole === null) return { state: "read", ...NOT_AGGREGATED, retry };
  if (data)
    return { state: "read", ...aggregatorsOf(data, clusterRole), retry };
  return error
    ? { state: "unread", error, retry }
    : { state: "reading", retry };
}
