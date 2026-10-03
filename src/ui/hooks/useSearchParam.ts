import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";

/**
 * One query parameter as state. In the address rather than a `useState`, so a
 * link can hand a page its filter — a node on a routing map sends
 * `?tab=routes&q=<host>` — and a reload or a copied address keeps it.
 */
export function useSearchParam(
  key: string,
  fallback = ""
): [string, (next: string) => void] {
  const [params, setParams] = useSearchParams();
  const value = params.get(key) ?? fallback;
  const set = useCallback(
    (next: string) =>
      setParams(
        (previous) => {
          const updated = new URLSearchParams(previous);
          if (next.trim() === "" || next === fallback) updated.delete(key);
          else updated.set(key, next);
          return updated;
        },
        { replace: true }
      ),
    [key, fallback, setParams]
  );
  return [value, set];
}
