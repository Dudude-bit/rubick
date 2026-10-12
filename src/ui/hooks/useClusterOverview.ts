import { useCallback, useEffect, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { commands } from "@/lib/commands";
import { listenEvent } from "@/lib/events";
import { useSurfaceVisible } from "@/lib/surface-visibility";
import { useWindowActivity } from "@/lib/window-activity";
import { normalizeTauriError } from "@/lib/error-utils";
import { ofSameCluster } from "@/lib/previous-answer";
import { queryKeys } from "@/lib/query-keys";
import { useRefusedOn } from "@/lib/refusals";
import { STALE_TIMES } from "@/lib/refresh";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { readSoon } from "@/hooks/useResourceWatch";
import { useWatchedList } from "@/hooks/useWatchedList";
import { useClusterStore } from "@/stores/clusterStore";
import type {
  ClusterOverview,
  DeploymentInfo,
  ResourceCounts,
} from "@/generated/types";

/**
 * Whether this connection was refused the whole cluster's overview. A
 * reader that only decorates with its counts does not ask again: each ask
 * of a one-namespace token was refused, every ten seconds.
 */
export function useWholeClusterRefused(): boolean {
  const attempt = useClusterStore((s) => s.connectionAttemptId);
  return useRefusedOn(attempt, "getClusterOverview", [null]);
}

/**
 * One overview for `scope`, as the store spells it: empty is the whole
 * cluster. The backend adds several namespaces up itself, reading what is
 * the cluster's once, and refuses an empty list rather than widening it, so
 * "every namespace" is the one value sent as `null`.
 */
export async function readOverview(
  scope: readonly string[]
): Promise<ClusterOverview> {
  try {
    return await commands.getClusterOverview(
      scope.length > 0 ? [...scope] : null
    );
  } catch (err) {
    throw new Error(normalizeTauriError(err), { cause: err });
  }
}

/**
 * The cluster overview query, shared by everything that reads it.
 *
 * The scope is the cache key, so the sidebar counts, the overview page and
 * the window chrome all read one response per scope rather than issuing the
 * same request three times every ten seconds.
 *
 * `scope` is the namespaces to ask about, empty for the whole cluster. It is
 * a scope somebody names, not the window's — the namespace picker wants every
 * namespace's pod count however narrowly the window is scoped, which is why
 * this hook does not read the selection itself. {@link useScopedOverview} is
 * the one that follows it.
 */
export function useClusterOverview(scope: readonly string[], enabled = true) {
  const currentContext = useClusterStore((s) => s.currentContext);
  const isConnected = useClusterStore((s) => s.isConnected);

  return useLiveQuery({
    queryKey: queryKeys.clusterOverview(currentContext, scope),
    queryFn: () => readOverview(scope),
    enabled: isConnected && enabled,
    staleTime: STALE_TIMES.overview,
    // Previous, but only of this cluster: `keepPreviousData` answered the
    // new context's key with the old context's totals, which is how the rail
    // kept `Pods 51` beside a cluster that refuses to list pods. And not
    // into a scope of several namespaces: those are the old selection's
    // totals under the new selection's label, and the skeleton is one read
    // away.
    placeholderData:
      scope.length > 1
        ? undefined
        : ofSameCluster<ClusterOverview>(currentContext),
    refresh: "overview",
    changesAt: (overview) => overview.nextChangeAt,
  });
}

/**
 * The overview of what this window is looking at: one request whatever the
 * scope, answered from the backend's watch-fed stores when they are healthy
 * (`src/tauri/src/overview/mod.rs`) and by listing when they are not. The
 * answer says which in `servedFrom`.
 */
export function useScopedOverview() {
  return useClusterOverview(useClusterStore((s) => s.namespaceScope));
}

/**
 * The count each of the overview's stores holds, by the kind it watches, as
 * `src/contracts/overview-watches.json` lists them: live while the overview is
 * followed. The Warning events are not the events count, which is counted.
 */
export const WATCHED_COUNTS = {
  Pod: "pods",
  Node: "nodes",
  Deployment: "deployments",
  StatefulSet: "statefulSets",
  DaemonSet: "daemonSets",
  Job: "jobs",
  Event: null,
} as const satisfies Record<string, keyof ResourceCounts | null>;

/** Whether `overview` is read again on its stores' changes: served from them, and seen. */
export function useOverviewFollowed(
  overview: ClusterOverview | undefined
): boolean {
  return useOverviewSeen() && overview?.servedFrom === "watch";
}

function useOverviewSeen(): boolean {
  const context = useClusterStore((s) => s.currentContext);
  const surface = useSurfaceVisible();
  const shown = useWindowActivity((s) => s.visible);
  return surface && shown && !!context;
}

/**
 * Whether the overview on screen is read again within a second of a change
 * the backend's watch-fed stores took in its scope, rather than on the
 * ten-second poll alone: Sam's read "41 of 62 pods ready" six seconds after
 * kubectl was back at 40. Only while it is served from those stores, the one
 * read cheap enough to repeat that often, and only while it is seen.
 *
 * Called once, by the shell, so the sidebar and status bar counts follow on
 * every page and not only on the Overview: Sam's sidebar kept "Deployments 7"
 * for 9 s after the Deployment's page said it was gone.
 */
export function useFollowedOverview(
  overview: ClusterOverview | undefined
): boolean {
  const client = useQueryClient();
  const context = useClusterStore((s) => s.currentContext);
  const scope = useClusterStore((s) => s.namespaceScope);
  const seen = useOverviewSeen();
  const following = useOverviewFollowed(overview);
  useDeploymentsFollowed(
    seen && overview?.servedFrom === "list" ? overview : undefined
  );
  useEffect(() => {
    if (!following) return;
    const key = queryKeys.clusterOverview(context, scope);
    let left = false;
    let leave: (() => void) | undefined;
    void listenEvent("overview-changed", ({ payload }) => {
      if (payload.context !== context) return;
      const inScope =
        scope.length === 0 ||
        payload.cluster ||
        payload.namespaces.some((namespace) => scope.includes(namespace));
      if (inScope) readSoon(client, key, 0);
    }).then((unlisten) => {
      if (left) unlisten();
      else leave = unlisten;
    });
    return () => {
      left = true;
      leave?.();
    };
  }, [following, context, scope, client]);
  return following;
}

/**
 * Where the overview's pods went unread and its Deployments were not, the
 * namespaces to watch those Deployments in: `null` for the whole cluster,
 * `undefined` for nowhere.
 */
export function blindDeployments(
  overview: ClusterOverview | undefined,
  scope: readonly string[]
): string[] | null | undefined {
  if (!overview?.deployments) return undefined;
  const where = (kind: string) =>
    overview.unread
      .filter((entry) => entry.kind === kind)
      .map((entry) => entry.namespace);
  const pods = where("Pod");
  const deployments = where("Deployment");
  if (pods.includes(null)) {
    if (deployments.length > 0) return undefined;
    return scope.length > 0 ? [...scope] : null;
  }
  const names = [...new Set(pods)].filter(
    (ns): ns is string => ns !== null && !deployments.includes(ns)
  );
  return names.length > 0 ? names.sort() : undefined;
}

/**
 * A Deployment whose pods went unread is only what its controller says, and
 * ledger's said Available for three seconds of each crash loop: an overview
 * listed in that window stayed green on the poll while the Deployments list,
 * on its watch, had long said Unavailable. So where the pods are unread the
 * overview follows the Deployments' own watch and reads again on a change.
 */
function useDeploymentsFollowed(overview: ClusterOverview | undefined) {
  const client = useQueryClient();
  const context = useClusterStore((s) => s.currentContext);
  const scope = useClusterStore((s) => s.namespaceScope);
  const where = JSON.stringify(blindDeployments(overview, scope) ?? false);
  const blind = useMemo(
    () => JSON.parse(where) as string[] | null | false,
    [where]
  );
  const queryKey = useMemo(
    () => queryKeys.overviewDeployments(context, blind || null),
    [context, blind]
  );
  const subscribe = useCallback(
    () => commands.subscribeDeploymentWatch(blind || null),
    [blind]
  );
  const settling = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (settling.current) clearTimeout(settling.current);
    },
    []
  );
  // A status update comes in a burst; a read that left inside it is behind.
  const onChange = useCallback(() => {
    if (settling.current) clearTimeout(settling.current);
    settling.current = setTimeout(() => {
      settling.current = null;
      void client.invalidateQueries({
        queryKey: queryKeys.clusterOverview(context, scope),
        exact: true,
      });
    }, SETTLE_MS);
  }, [client, context, scope]);
  useWatchedList<DeploymentInfo>({
    enabled: blind !== false,
    subscribe,
    queryKey,
    detail: noDetail,
    reportFailure: ignoreFailure,
    recount: false,
    onChange,
  });
}

const SETTLE_MS = 250;
const noDetail = () => [];
const ignoreFailure = () => {};
