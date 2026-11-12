import { useCallback } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";

import type { AppSearch } from "@/lib/app-search";

/** The address's query, typed; outside a cluster route every key is absent. */
export function useAppSearch(): AppSearch {
  return useSearch({ strict: false }) as AppSearch;
}

/**
 * One key of the query. A reader of the whole query is drawn again when any
 * key changes, so a filter writing `?q=` per keystroke redrew every name link
 * in a list and the shell around it.
 */
export function useAppSearchValue<K extends keyof AppSearch>(
  key: K | undefined
): AppSearch[K] | undefined {
  return useSearch({
    strict: false,
    select: (search: AppSearch) => (key ? search[key] : undefined),
  } as never) as AppSearch[K] | undefined;
}

/**
 * Writes part of the query in place, keeping the rest of it and every scroll
 * box where it is: the router's restore put each back where it was before.
 */
export function useSetSearch(): (
  patch: Partial<AppSearch>,
  options?: { replace?: boolean }
) => void {
  const navigate = useNavigate();
  return useCallback(
    (patch, options) =>
      void navigate({
        to: ".",
        search: (prev: AppSearch) => {
          const next: AppSearch = { ...prev, ...patch };
          for (const key of Object.keys(next) as Array<keyof AppSearch>)
            if (next[key] === undefined || next[key] === "") delete next[key];
          return next;
        },
        replace: options?.replace ?? true,
        resetScroll: false,
      } as Parameters<typeof navigate>[0]),
    [navigate]
  );
}

/**
 * One query parameter as state. In the address rather than a `useState`, so a
 * link can hand a page its filter — a node on a routing map sends
 * `?tab=routes&q=<host>` — and a reload or a copied address keeps it.
 */
export function useSearchParam(
  key: keyof AppSearch,
  fallback = ""
): [string, (next: string) => void] {
  const value = useAppSearchValue(key) ?? fallback;
  const setSearch = useSetSearch();
  const set = useCallback(
    (next: string) =>
      setSearch({
        [key]: next.trim() === "" || next === fallback ? undefined : next,
      }),
    [key, fallback, setSearch]
  );
  return [value, set];
}
