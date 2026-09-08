/**
 * Resource list page factory.
 *
 * Most resource list pages share the same structure: pull `currentNamespace`
 * from the cluster store, define columns + quick actions, wire up
 * `<ResourceList>` with the right `queryKey`, fetcher, and delete config.
 * This collapses that into one config object — ~80 LOC to ~15 LOC per page.
 * `ConfigMapList.tsx` is a typical use.
 */

import { useCallback, useMemo, useState } from "react";
import { useNavigate, type NavigateFunction } from "react-router-dom";
import { Trash2, Eye } from "lucide-react";
import type { ColumnDef } from "@/components/ui/table-features";

import { ResourceList } from "./ResourceList";
import {
  useNamespaceScope,
  type NamespaceScope,
} from "@/hooks/useNamespaceScope";
import { listAcrossScope, scopeCacheKey } from "@/lib/namespace-scope";
import { useToast } from "@/components/ui/use-toast";
import { queryKeys } from "@/lib/query-keys";
import { getResourceDetailUrl } from "@/lib/navigation-utils";
import { STALE_TIMES } from "@/lib/refresh";
import { getResourceRowId } from "@/lib/table-utils";
import { deliveryScopeOf } from "@/lib/delivery";
import type { ResourceKind } from "@/lib/resource-registry";
import type { QuickAction } from "@/components/ui/quick-actions";
import { useResourceWatch } from "@/hooks/useResourceWatch";
import { useT, type T as Translator } from "@/i18n/useT";

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
   * namespace selection — a set, not a name: "in prod, staging" and "in 4
   * namespaces" are both scopes a reader can be in, and a line built from one
   * namespace calls all of them "all namespaces". The translator comes with
   * it because this config is a module-level table, where no hook can be
   * called.
   */
  description?:
    string | ((deps: { scope: NamespaceScope; t: Translator }) => string);
  /** Search key (column accessor) for the in-page search box. */
  searchKey?: string;
  /**
   * Optional watch subscription factory. When supplied, the page subscribes to
   * backend `resource-event` updates and the polling `refresh` rate is
   * switched off — the cache is kept fresh by incremental setQueryData updates
   * instead. Receives the resolved namespace (`null` for cluster-scoped pages
   * or "all namespaces") and returns a stream id from the matching
   * `subscribe_*_watch` Tauri command.
   */
  watch?: (params: { namespace: string | null }) => Promise<string>;
}

export function createResourceListPage<T extends ListableResource>(
  config: ResourceListPageConfig<T>
) {
  const ListPage = function ResourceListPage() {
    const t = useT();
    const scope = useNamespaceScope();
    const navigate = useNavigate();
    const isCluster = config.scope === "cluster";
    // The single namespace a watch subscribes to. A watch runs only for a
    // selection of none or one; several is read per namespace and polled.
    const watchNamespace = isCluster
      ? null
      : scope.scope.length === 1
        ? scope.scope[0]
        : null;
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
    // A watch is one cluster-wide or one single-namespace stream. A selection
    // of several is polled per namespace instead (see `listAcrossScope`): a
    // cluster-wide watch needs rights this user may lack and would stream
    // namespaces they did not ask for.
    const watchEnabled = !!watchFactory && (isCluster || !scope.several);
    const subscribe = useCallback(
      () => watchFactory!({ namespace: watchNamespace }),
      [watchFactory, watchNamespace]
    );
    const queryKey = useMemo(
      () => queryKeys.resources(config.resourceType, cacheKey),
      [cacheKey]
    );
    // Rebuilt each render, which React Query is fine with — it keys on
    // `queryKey`, and `cacheKey` moves with the selection.
    const queryFn = isCluster
      ? () => config.fetcher({ namespace: null })
      : listAcrossScope(scope.scope, (namespace) =>
          config.fetcher({ namespace })
        );

    // When the backend's watcher fails N times in a row (typical cause: the
    // kubeconfig user lacks the `watch` verb on this kind), fall back to
    // periodic refresh so the list doesn't appear frozen. The toast warns
    // once; the watcher keeps retrying and a recovered stream resets the flag.
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
      enabled: watchEnabled,
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
            ? config.description({ scope, t })
            : config.description
        }
        searchKey={config.searchKey}
        queryKey={queryKey}
        getRowId={getResourceRowId}
        queryFn={queryFn}
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
                invalidateQueryKeys: [queryKey],
                resourceType: config.resourceType,
              }
            : undefined
        }
        delivery={deliveryScopeOf(config.resourceType)}
        staleTime={STALE_TIMES.resourceList}
        refresh={watchEnabled && !watchFailed ? false : undefined}
        live={watchEnabled && !watchFailed}
        resyncing={resyncing}
      />
    );
  };
  ListPage.displayName = `${config.resourceType}List`;
  return ListPage;
}
