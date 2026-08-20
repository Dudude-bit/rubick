/**
 * Resource list page factory.
 *
 * Most resource list pages share the same structure: pull `currentNamespace`
 * from the cluster store, define columns + quick actions, wire up
 * `<ResourceList>` with the right `queryKey`, fetcher, and delete config.
 *
 * `createResourceListPage` collapses that boilerplate into a single config
 * object. A typical list page goes from ~80 LOC to ~15 LOC.
 *
 * Example:
 * ```tsx
 * export const ConfigMapList = createResourceListPage<ConfigMapInfo>({
 *   resourceType: ResourceType.ConfigMap,
 *   title: "ConfigMaps",
 *   fetcher: ({ namespace }) =>
 *     commands.listConfigmaps({
 *       namespace,
 *       labelSelector: null,
 *       fieldSelector: null,
 *       limit: null,
 *     }),
 *   deleter: (item) => commands.deleteConfigmap(item.name, item.namespace),
 *   columns: () => [...],
 * });
 * ```
 */

import { useCallback, useMemo, useState } from "react";
import { useNavigate, type NavigateFunction } from "react-router-dom";
import { Trash2, Eye } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";

import { ResourceList } from "./ResourceList";
import {
  useNamespaceScope,
  type NamespaceScope,
} from "@/hooks/useNamespaceScope";
import { useClusterStore } from "@/stores/clusterStore";
import { useToast } from "@/components/ui/use-toast";
import { queryKeys } from "@/lib/query-keys";
import { getResourceDetailUrl } from "@/lib/navigation-utils";
import { STALE_TIMES } from "@/lib/refresh";
import { getResourceRowId } from "@/lib/table-utils";
import { deliveryScopeOf } from "@/lib/delivery";
import type { ResourceKind } from "@/lib/resource-registry";
import type { QuickAction } from "@/components/ui/quick-actions";
import { useResourceWatch } from "@/hooks/useResourceWatch";
import { useT } from "@/i18n/useT";

/** A resource that can show up in a list page. */
type ListableResource = { name: string; namespace?: string | null };

export interface ResourceListPageConfig<T extends ListableResource> {
  /** Kubernetes resource type — used for query keys + detail URLs. */
  resourceType: ResourceKind;
  /** Page title (also used as the empty-state label by default). */
  title: string;
  /** Async fetch the list. `namespace` is `null` for cluster-scoped pages. */
  fetcher: (params: { namespace: string | null }) => Promise<T[]>;
  /**
   * Optional delete function. When provided a Trash2 quick action and the
   * confirm dialog wiring activate automatically.
   */
  deleter?: (item: T) => Promise<unknown>;
  /** Build column definitions. Receives navigate so columns can link. */
  columns: (deps: { navigate: NavigateFunction }) => ColumnDef<T>[];
  /** Extra quick actions, inserted between the default View and Delete. */
  extraActions?: (deps: { navigate: NavigateFunction }) => QuickAction<T>[];
  /**
   * Cluster-scoped pages set `scope: "cluster"` so the fetcher receives
   * `namespace: null` regardless of the user's current namespace.
   */
  scope?: "namespaced" | "cluster";
  /** Override the empty-state label (defaults to `title`). */
  emptyStateLabel?: string;
  /**
   * Optional description rendered under the title. The function form gets the
   * namespace selection — which is a set, not a name: "in prod, staging" and
   * "in 4 namespaces" are both scopes a reader can be in, and a line built
   * from one namespace calls all of them "all namespaces".
   */
  description?: string | ((deps: { scope: NamespaceScope }) => string);
  /** Search key (column accessor) for the in-page search box. */
  searchKey?: string;
  /**
   * Optional watch subscription factory. When supplied, the page
   * subscribes to backend `resource-event` updates and the polling
   * `refresh` rate is switched off — the cache is kept fresh by
   * incremental setQueryData updates instead. Receives the resolved
   * namespace (`null` for cluster-scoped pages or "all namespaces")
   * and returns a stream id from the matching `subscribe_*_watch`
   * Tauri command.
   */
  watch?: (params: { namespace: string | null }) => Promise<string>;
}

export function createResourceListPage<T extends ListableResource>(
  config: ResourceListPageConfig<T>
) {
  const ListPage = function ResourceListPage() {
    const t = useT();
    const currentNamespace = useClusterStore((s) => s.currentNamespace);
    const scope = useNamespaceScope();
    const navigate = useNavigate();
    const namespace = config.scope === "cluster" ? null : currentNamespace;

    const columns = useMemo(() => config.columns({ navigate }), [navigate]);

    const quickActions = useMemo(
      () =>
        (setDeleteTarget: (item: T) => void): QuickAction<T>[] => {
          const actions: QuickAction<T>[] = [
            {
              icon: Eye,
              label: t("action", "viewDetails"),
              onClick: (item) =>
                navigate(
                  getResourceDetailUrl(
                    config.resourceType,
                    item.name,
                    item.namespace
                  )
                ),
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
      () => watchFactory!({ namespace }),
      [watchFactory, namespace]
    );
    const queryKey = useMemo(
      () => queryKeys.resources(config.resourceType, namespace),
      [namespace]
    );

    // When the backend's watcher fails N times in a row (typical
    // cause: kubeconfig user lacks the `watch` verb on this kind),
    // fall back to periodic refresh so the list doesn't appear
    // frozen. The toast warns the user once; the watcher keeps
    // retrying in the background and a recovered stream resets the
    // failed flag.
    const { toast } = useToast();
    const [watchFailed, setWatchFailed] = useState(false);
    const handleWatchError = useCallback(
      (err: string) => {
        if (watchFailed) return;
        setWatchFailed(true);
        toast({
          title: t("action", "realtimeUnavailable"),
          description: t("action", "fallingBackToPolling", {
            title: config.title,
            error: err,
          }),
        });
      },
      [t, toast, watchFailed]
    );

    const { resyncing } = useResourceWatch<T>({
      enabled: !!watchFactory,
      subscribe,
      queryKey,
      onError: handleWatchError,
      onRecovered: useCallback(() => setWatchFailed(false), []),
    });

    const deleter = config.deleter;
    return (
      <ResourceList<T>
        title={config.title}
        description={
          typeof config.description === "function"
            ? config.description({ scope })
            : config.description
        }
        searchKey={config.searchKey}
        queryKey={queryKeys.resources(config.resourceType, namespace)}
        getRowId={getResourceRowId}
        queryFn={() => config.fetcher({ namespace })}
        columns={columns}
        quickActions={quickActions}
        emptyStateLabel={config.emptyStateLabel ?? config.title}
        getRowHref={(row) =>
          getResourceDetailUrl(config.resourceType, row.name, row.namespace)
        }
        deleteConfig={
          deleter
            ? {
                mutationFn: async (item) => {
                  await deleter(item);
                },
                invalidateQueryKeys: [
                  queryKeys.resources(config.resourceType, namespace),
                ],
                resourceType: config.resourceType,
              }
            : undefined
        }
        delivery={deliveryScopeOf(config.resourceType)}
        staleTime={STALE_TIMES.resourceList}
        refresh={watchFactory && !watchFailed ? false : undefined}
        live={!!watchFactory && !watchFailed}
        resyncing={resyncing}
      />
    );
  };
  ListPage.displayName = `${config.resourceType}List`;
  return ListPage;
}
