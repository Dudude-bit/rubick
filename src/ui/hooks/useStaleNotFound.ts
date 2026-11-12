import { useState } from "react";
import { skipToken, useQuery } from "@tanstack/react-query";

import type { Scoped } from "@/generated/types";
import { ERROR_CODES, errorCode } from "@/lib/error-utils";
import { queryKeys } from "@/lib/query-keys";

/**
 * Whether the NotFound an object's read holds is not this page's or peek's
 * answer about it: one answered before the surface opened while its own read
 * is on its way, or one the watch on its name has seen the object under
 * since. An object made again under its name is the same surface's object
 * reappearing; Sam's big-pull page, reopened after kubectl apply, said "This
 * Deployment no longer exists" for a frame from the deletion before it.
 */
export function useStaleNotFound(
  kind: string,
  namespace: string | null | undefined,
  name: string | undefined,
  read: { error: unknown; errorUpdatedAt: number; isFetching: boolean }
): boolean {
  const [openedAt] = useState(Date.now);
  const watched = useQuery<Scoped<unknown>>({
    queryKey: queryKeys.objectWatch(kind, namespace, name),
    queryFn: skipToken,
  });
  const listed = watched.data?.rows.length ?? 0;
  const listedAt = watched.dataUpdatedAt;
  if (!read.error || errorCode(read.error) !== ERROR_CODES.NOT_FOUND)
    return false;
  if (read.isFetching && read.errorUpdatedAt < openedAt) return true;
  return listed > 0 && listedAt > read.errorUpdatedAt;
}
