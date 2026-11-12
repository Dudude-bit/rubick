import type { UseQueryResult } from "@tanstack/react-query";

import { errorCode, errorToShow } from "@/lib/error-utils";

/**
 * A read and its answer, or why there is none: never a default. `code` is
 * the failure's own, which tells a refusal from a fault; absent, nobody
 * says it was refused.
 */
export type Known<V> =
  | { known: true; value: V }
  | { known: false; why: string | null; code?: string };

export function knownOf<V>(
  query: Pick<UseQueryResult<V>, "data" | "error">
): Known<V> {
  if (query.data !== undefined) return { known: true, value: query.data };
  return query.error
    ? {
        known: false,
        why: errorToShow(query.error),
        code: errorCode(query.error),
      }
    : { known: false, why: null };
}
