import { useEffect, useMemo, useRef } from "react";
import {
  useQueryClient,
  type QueryKey,
  type UseQueryResult,
} from "@tanstack/react-query";

import { useReadThereAt } from "@/hooks/useReadUid";
import { isResourceNotFoundError } from "@/hooks/useResourceDetail";
import { queryKeys } from "@/lib/query-keys";

type Asked<T> = Pick<
  UseQueryResult<T>,
  "data" | "error" | "errorUpdatedAt" | "isPending" | "refetch"
>;

/** A read as its page draws it. */
export type HeldRead<T> = Pick<
  UseQueryResult<T>,
  "data" | "error" | "isPending" | "refetch"
>;

/**
 * Whether a read about an object its page or peek holds answered NotFound,
 * which is then one of two reads behind the other: this one, asked before the
 * object was created, or the page's own, from before it was deleted. Either
 * is asked again where `follow` is set: this read at once where it is the
 * older, the object where the NotFound is newer, the page's own answer to
 * whether it is gone.
 */
export function useHeldNotFound(
  kind: string,
  namespace: string | null | undefined,
  name: string | undefined,
  read: Pick<Asked<unknown>, "error" | "errorUpdatedAt">,
  key: QueryKey,
  follow = true
): boolean {
  const client = useQueryClient();
  const held = useReadThereAt(kind, namespace, name);
  const back = isResourceNotFoundError(read.error) && held > 0;
  const created = read.errorUpdatedAt < held;
  const asked = useRef<string | null>(null);
  const seen = `${created}/${read.errorUpdatedAt}`;
  const again = created ? key : queryKeys.detail(kind, namespace, name);
  useEffect(() => {
    if (!follow || !back || asked.current === seen) return;
    asked.current = seen;
    void client.invalidateQueries({ queryKey: again, exact: true });
  });
  return back;
}

/**
 * A read about the object a page holds, drawn as still reading where it
 * answered NotFound beside it, and asked again (see {@link useHeldNotFound}).
 * Sam's big-pull Deployment page said "Could not read what connects to this:
 * Resource not found" beside the Deployment it had just read as Ready.
 */
export function useHeldRead<T>(
  kind: string,
  namespace: string | null | undefined,
  name: string | undefined,
  query: Asked<T>,
  key: QueryKey
): HeldRead<T> {
  const back = useHeldNotFound(kind, namespace, name, query, key);
  const { data, error, isPending, refetch } = query;
  return useMemo(
    () =>
      back
        ? { data: undefined, error: null, isPending: true, refetch }
        : { data, error, isPending, refetch },
    [back, data, error, isPending, refetch]
  ) as HeldRead<T>;
}
