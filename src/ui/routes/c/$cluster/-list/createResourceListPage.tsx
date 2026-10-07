/**
 * Resource list page factory.
 *
 * Most resource list pages share the same structure: pull `currentNamespace`
 * from the cluster store, define columns + quick actions, wire up
 * `<ResourceList>` with the right `queryKey`, fetcher, and delete config.
 * This collapses that into one config object — ~80 LOC to ~15 LOC per page.
 * `ConfigMapList.tsx` is a typical use.
 */

import {
  Fragment,
  useCallback,
  useMemo,
  type ComponentType,
  type ReactNode,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import { Trash2, Eye } from "lucide-react";
import type { ColumnDef } from "@/components/ui/table-features";

import { ResourceList } from "./ResourceList";
import { useNamespaceScope } from "@/hooks/useNamespaceScope";
import { scopeCacheKey } from "@/lib/namespace-scope";
import type { Scoped } from "@/generated/types";
import { queryKeys } from "@/lib/query-keys";
import { hrefOf, objectLink } from "@/lib/links";
import { STALE_TIMES } from "@/lib/refresh";
import { getResourceRowId } from "@/lib/table-utils";
import { deliveryScopeOf } from "@/lib/delivery";
import { narrowingHelps } from "@/lib/resource-registry";
import type { ResourceKind } from "@/lib/resource-registry";
import type { QuickAction } from "@/components/ui/quick-actions";
import { useWatchedList } from "@/hooks/useWatchedList";
import { useT } from "@/i18n/useT";

/** A resource that can show up in a list page. */
type ListableResource = { name: string; namespace?: string | null };

type Navigate = ReturnType<typeof useNavigate>;

export interface ResourceListPageConfig<T extends ListableResource> {
  /** Kubernetes resource type — used for query keys + detail URLs. */
  resourceType: ResourceKind;
  /** Page title (also used as the empty-state label by default). */
  title: string;
  /**
   * Read the list: the `list_*_in` command for a namespaced kind, given the
   * selection (`null` for the whole cluster, and always for a cluster-scoped
   * page); a cluster-scoped kind's list wrapped in `whole`.
   */
  fetcher: (params: { scope: string[] | null }) => Promise<Scoped<T>>;
  /**
   * Optional delete function. When provided a Trash2 quick action and the
   * confirm dialog wiring activate automatically.
   */
  deleter?: (item: T) => Promise<unknown>;
  /** Build column definitions. Receives navigate so columns can link. */
  columns: (deps: { navigate: Navigate }) => ColumnDef<T>[];
  /** Extra quick actions, inserted between the default View and Delete. */
  extraActions?: (deps: { navigate: Navigate }) => QuickAction<T>[];
  /**
   * Cluster-scoped pages set `scope: "cluster"` so the fetcher receives
   * `namespace: null` regardless of the user's current namespace.
   */
  scope?: "namespaced" | "cluster";
  /** Override the empty-state label (defaults to `title`). */
  emptyStateLabel?: string;
  /**
   * Optional watch subscription factory. When supplied, the page subscribes to
   * backend `resource-event` updates and the polling `refresh` rate is
   * switched off — the cache is kept fresh by incremental setQueryData updates
   * instead. Receives the selection as `fetcher` does and returns a stream id
   * from the matching `subscribe_*_watch` Tauri command.
   */
  watch?: (params: { scope: string[] | null }) => Promise<string>;
  /**
   * Rendered around the list, for a page whose cells read one answer for
   * every row through a context rather than one read per row.
   */
  around?: ComponentType<{ children: ReactNode }>;
}

export function createResourceListPage<T extends ListableResource>(
  config: ResourceListPageConfig<T>
) {
  const linkOf = (row: ListableResource) =>
    objectLink({
      kind: config.resourceType,
      name: row.name,
      namespace: row.namespace,
    })!;
  const detail = queryKeys.rowDetail(config.resourceType);

  const ListPage = function ResourceListPage() {
    const t = useT();
    const scope = useNamespaceScope();
    const navigate = useNavigate();
    const isCluster = config.scope === "cluster";
    const wire = isCluster ? null : scope.wire;
    // The cache key rides on the whole selection, not one namespace, so two
    // different multi-namespace scopes never read each other's rows.
    const cacheKey = isCluster ? null : scopeCacheKey(scope.scope);

    const columns = useMemo(() => config.columns({ navigate }), [navigate]);

    const quickActions = useMemo(
      () =>
        (setDeleteTarget: (item: T) => void): QuickAction<T>[] => {
          const actions: QuickAction<T>[] = [
            {
              icon: Eye,
              label: t("action", "viewDetails"),
              onClick: (item) => navigate(linkOf(item)),
            },
            ...(config.extraActions?.({ navigate }) ?? []),
          ];

          if (config.deleter) {
            actions.push({
              icon: Trash2,
              label: t("action", "delete"),
              onClick: (item) => setDeleteTarget(item),
              variant: "destructive",
            });
          }

          return actions;
        },
      [navigate, t]
    );

    const watchFactory = config.watch;
    const subscribe = useCallback(
      () => watchFactory!({ scope: wire }),
      [watchFactory, wire]
    );
    const queryKey = useMemo(
      () => queryKeys.resources(config.resourceType, cacheKey),
      [cacheKey]
    );
    // Rebuilt each render, which React Query is fine with — it keys on
    // `queryKey`, and `cacheKey` moves with the selection.
    const queryFn = () => config.fetcher({ scope: wire });

    const { live, refresh, resyncing } = useWatchedList<T>({
      enabled: !!watchFactory,
      subscribe,
      queryKey,
      detail,
      reportFailure: config.title,
    });

    const deleter = config.deleter;
    const Around = config.around ?? Fragment;
    return (
      <Around>
        <ResourceList<T>
          title={config.title}
          queryKey={queryKey}
          getRowId={getResourceRowId}
          queryFn={queryFn}
          columns={columns}
          quickActions={quickActions}
          emptyStateLabel={config.emptyStateLabel ?? config.title}
          narrowingHelps={narrowingHelps(config.resourceType)}
          getRowHref={(row) => hrefOf(linkOf(row))}
          deleteConfig={
            deleter
              ? {
                  mutationFn: async (item) => {
                    await deleter(item);
                  },
                  invalidateQueryKeys: [queryKey],
                  resourceType: config.resourceType,
                }
              : undefined
          }
          delivery={deliveryScopeOf(config.resourceType)}
          staleTime={STALE_TIMES.resourceList}
          refresh={refresh}
          live={live}
          resyncing={resyncing}
        />
      </Around>
    );
  };
  ListPage.displayName = `${config.resourceType}List`;
  return ListPage;
}
