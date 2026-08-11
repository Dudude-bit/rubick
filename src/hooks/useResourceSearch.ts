import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { commands } from "@/lib/commands";
import type {
  SearchContextStatus,
  SearchFailureKind,
  SearchTarget,
} from "@/generated/types";

/** Shortest query the backend accepts. Mirrors `MIN_QUERY_LEN`. */
export const MIN_SEARCH_LENGTH = 2;

/** Default keystroke debounce. Matches what the palette used before. */
const DEFAULT_DEBOUNCE_MS = 250;

/** Separator for list-shaped dependencies; illegal in context names. */
const SEP = "\u0000";

/** One matching resource. Mirrors the backend `SearchHit`. */
export interface SearchHit {
  context: string;
  kind: string;
  name: string;
  namespace: string | null;
}

/** `search-hits` event payload. */
interface SearchHitsEvent {
  search_id: string;
  context: string;
  hits: SearchHit[];
}

/** `search-status` event payload. */
interface SearchStatusEvent {
  search_id: string;
  context: string;
  status: SearchContextStatus;
  reason: SearchFailureKind | null;
  message: string | null;
  matched: number;
  truncated: boolean;
}

/** One cluster's row: where it is, and why, if it went nowhere. */
export interface ClusterSearchState {
  context: string;
  status: SearchContextStatus;
  reason: SearchFailureKind | null;
  message: string | null;
  matched: number;
  truncated: boolean;
}

export interface UseResourceSearchOptions {
  query: string;
  /** Contexts to search. Empty = the current context only. */
  contexts?: string[];
  /** Search every context in the kubeconfig. Overrides `contexts`. */
  allContexts?: boolean;
  /** Namespace scope applied to every searched cluster. */
  namespace?: string | null;
  /**
   * Allow the backend to open a connection to a cluster that has none.
   * Leave false while the reader is typing: querying a cold cluster
   * runs its credential plugin, which can prompt. Set it on an
   * explicit gesture — picking the cluster, or pressing Enter.
   */
  connect?: boolean;
  kinds?: string[];
  limitPerContext?: number;
  enabled?: boolean;
  debounceMs?: number;
  /**
   * Bump to run the same request again. A retry after a cluster failed
   * asks an identical question, so nothing else in the key changes and
   * without this the effect would correctly decide there is nothing to do.
   */
  attempt?: number;
}

export interface ResourceSearchResult {
  hits: SearchHit[];
  /** Every requested cluster, in request order. */
  clusters: ClusterSearchState[];
  /** True while at least one cluster is still working. */
  isSearching: boolean;
  /** The search itself could not start (bad query, no cluster, …). */
  error: string | null;
}

const IDLE: ResourceSearchResult = {
  hits: [],
  clusters: [],
  isSearching: false,
  error: null,
};

function fromTarget(target: SearchTarget): ClusterSearchState {
  return {
    context: target.context,
    status: target.status,
    reason: target.reason,
    message: target.message,
    matched: 0,
    truncated: false,
  };
}

function isTerminal(status: SearchContextStatus): boolean {
  return status === "done" || status === "failed" || status === "skipped";
}

/**
 * Runs a debounced resource search across one, several, or all
 * clusters and streams the results back as each cluster answers.
 *
 * Two guarantees the consumer can rely on:
 * - A cluster is never silently absent. Every requested context shows
 *   up in `clusters` with a status, so "this cluster failed" and "this
 *   cluster matched nothing" are never the same empty list.
 * - A superseded query is cancelled, not just ignored: the previous
 *   search is cancelled on the backend before the next one starts.
 *
 * Same deferred-start handshake as `useResourceWatch` — the backend
 * fan-out is gated until `listen()` has resolved, so the first cluster
 * to answer cannot emit into the void.
 */
export function useResourceSearch({
  query,
  contexts,
  allContexts = false,
  namespace = null,
  connect = false,
  kinds,
  limitPerContext,
  enabled = true,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  attempt = 0,
}: UseResourceSearchOptions): ResourceSearchResult {
  // The key the state belongs to, and the set of clusters it is about.
  // Keeping them inside state lets the hook answer for a query it has
  // not run yet without resetting state from inside the effect (and
  // briefly showing the previous query's results under the new one).
  const [state, setState] = useState<
    ResourceSearchResult & { key: string; scope: string }
  >({ ...IDLE, key: "", scope: "" });

  // Consumers build these arrays inline, so the effect depends on
  // their contents rather than their identity — and rebuilds the
  // arrays from these keys, so there is nothing to keep in sync.
  const contextsKey = (contexts ?? []).join(SEP);
  const kindsKey = (kinds ?? []).join(SEP);

  const trimmed = query.trim();
  const active = enabled && trimmed.length >= MIN_SEARCH_LENGTH;

  /** Which clusters are being asked, regardless of what they are asked. */
  const scope = [contextsKey, String(allContexts)].join(SEP);

  const key = active
    ? [
        trimmed,
        contextsKey,
        kindsKey,
        String(allContexts),
        namespace ?? "",
        String(connect),
        String(attempt),
      ].join(SEP)
    : "";

  useEffect(() => {
    if (!active) return;

    let disposed = false;
    let searchId: string | null = null;
    const unlisteners: Array<() => void> = [];

    const stop = () => {
      disposed = true;
      while (unlisteners.length > 0) unlisteners.pop()?.();
      if (searchId) {
        const id = searchId;
        searchId = null;
        // Fire and forget: the backend also supersedes an older search
        // when a new one starts, so a lost cancel cannot leak a fan-out.
        commands.cancelResourceSearch(id).catch(() => {});
      }
    };

    const timer = window.setTimeout(async () => {
      try {
        const handle = await commands.startResourceSearch({
          query: trimmed,
          contexts: contextsKey ? contextsKey.split(SEP) : [],
          allContexts,
          namespace: namespace ?? undefined,
          kinds: kindsKey ? kindsKey.split(SEP) : undefined,
          connect,
          limitPerContext: limitPerContext ?? undefined,
        });
        if (disposed) {
          await commands.cancelResourceSearch(handle.searchId).catch(() => {});
          return;
        }
        searchId = handle.searchId;

        const clusters = handle.targets.map(fromTarget);
        setState({
          key,
          scope,
          hits: [],
          clusters,
          isSearching: clusters.some((c) => !isTerminal(c.status)),
          error: null,
        });

        const [offHits, offStatus] = await Promise.all([
          listen<SearchHitsEvent>("search-hits", (event) => {
            if (event.payload.search_id !== searchId) return;
            setState((prev) => ({
              ...prev,
              hits: [...prev.hits, ...event.payload.hits],
            }));
          }),
          listen<SearchStatusEvent>("search-status", (event) => {
            const payload = event.payload;
            if (payload.search_id !== searchId) return;
            setState((prev) => {
              const clusters = prev.clusters.map((cluster) =>
                cluster.context === payload.context
                  ? {
                      context: payload.context,
                      status: payload.status,
                      reason: payload.reason,
                      message: payload.message,
                      matched: payload.matched,
                      truncated: payload.truncated,
                    }
                  : cluster
              );
              return {
                ...prev,
                clusters,
                isSearching: clusters.some((c) => !isTerminal(c.status)),
              };
            });
          }),
        ]);

        if (disposed) {
          offHits();
          offStatus();
          return;
        }
        unlisteners.push(offHits, offStatus);

        // Listeners installed — release the backend's gate.
        await commands.resourceSearchSubscribed(handle.searchId);
      } catch (error) {
        if (disposed) return;
        setState({
          key,
          scope,
          hits: [],
          clusters: [],
          isSearching: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, debounceMs);

    return () => {
      window.clearTimeout(timer);
      stop();
    };
  }, [
    active,
    key,
    trimmed,
    contextsKey,
    kindsKey,
    allContexts,
    namespace,
    connect,
    limitPerContext,
    debounceMs,
    attempt,
    scope,
  ]);

  return useMemo(() => {
    if (state.key !== key) {
      // Debouncing, or a stale answer to a query that has moved on. The
      // hits belong to the old query and go; the roster does not, and
      // dropping it would flash "no clusters answered" over a fan-out
      // that is still standing — once per keystroke.
      const carried =
        state.scope === scope
          ? state.clusters.map((cluster) =>
              // A cluster nobody connected is not about to be searched
              // either, so it keeps saying so.
              cluster.status === "skipped"
                ? cluster
                : {
                    ...cluster,
                    status: "searching" as const,
                    matched: 0,
                    truncated: false,
                  }
            )
          : [];
      return { hits: [], clusters: carried, isSearching: active, error: null };
    }
    const { key: _key, scope: _scope, ...result } = state;
    return result;
  }, [state, key, active, scope]);
}
