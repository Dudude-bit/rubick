import type { UseQueryResult } from "@tanstack/react-query";

import { errorToShow } from "@/lib/error-utils";

/** A read and its answer, or why there is none: never a default. */
export type Known<V> =
  | { known: true; value: V }
  | { known: false; why: string | null };

export function knownOf<V>(
  query: Pick<UseQueryResult<V>, "data" | "error">
): Known<V> {
  if (query.data !== undefined) return { known: true, value: query.data };
  return {
    known: false,
    why: query.error ? errorToShow(query.error) : null,
  };
}
