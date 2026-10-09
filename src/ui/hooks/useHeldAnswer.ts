import { useEffect, useMemo, useRef } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";

import type { ResourceConnections } from "@/generated/types";
import type { ConnectionsQuery, ConnectionsRead } from "@/hooks/useConnections";
import { useHeldNotFound } from "@/hooks/useHeldRead";
import { useReadUid } from "@/hooks/useReadUid";
import { isResourceNotFoundError } from "@/hooks/useResourceDetail";
import { speaksFor, waitsOnList, type SeenOf } from "@/lib/service-health";

/** How long after a read a second one is fresh rather than shared with it. */
const FRESH_READ_MS = 300;

export interface HeldAnswer {
  /** The answer, where it can speak for the object on screen. */
  current: ResourceConnections | undefined;
  /** An answer about this name that cannot: another object's, older than what a watch under it has seen, or a NotFound beside an object its page holds. */
  stale: boolean;
  /**
   * The neighbourhood as every reader of the object draws it, its status,
   * its trace, its tabs and its report alike: an answer that cannot speak
   * for it is one still being read, never a verdict.
   */
  read: ConnectionsRead;
}

/**
 * A neighbourhood as every verdict of its object reads it, held to what the
 * watches under the Services it names have seen (`seen`). Where `follow` is
 * set an answer that cannot speak for it is read again: at once where it is
 * another object's, which is wrong in every reader of it, and once the read
 * it shared has aged out where it is only older than what a watch has seen.
 */
export function useHeldAnswer(
  kind: string,
  name: string | undefined,
  namespace: string | null | undefined,
  query: ConnectionsQuery,
  key: QueryKey,
  seen: SeenOf,
  follow: boolean
): HeldAnswer {
  const client = useQueryClient();
  const { data, error, dataUpdatedAt, isPending, refetch } = query;
  const uid = useReadUid(kind, namespace, name);
  const notFound = isResourceNotFoundError(error);
  const notFoundHeld = useHeldNotFound(
    kind,
    namespace,
    name,
    query,
    key,
    follow
  );
  const current =
    data &&
    name &&
    !notFound &&
    speaksFor({ data, at: dataUpdatedAt }, { name, uid }, seen)
      ? data
      : undefined;
  const stale = notFound
    ? notFoundHeld
    : !!data && !current && data.subject.name === name;

  const another = !!uid && !!data?.subjectUid && data.subjectUid !== uid;
  // Held only until a pod watch has listed: its list answers it, not a read.
  const listing = !notFound && !another && !!data && waitsOnList(data, seen);
  const asked = useRef<unknown>(null);
  useEffect(() => {
    if (!follow || !stale || notFound || listing || asked.current === data)
      return;
    asked.current = data;
    if (another) void client.resetQueries({ queryKey: key, exact: true });
    else
      setTimeout(
        () => void client.invalidateQueries({ queryKey: key, exact: true }),
        FRESH_READ_MS
      );
  }, [follow, stale, listing, notFound, data, another, client, key]);

  const shownError = stale ? null : error;
  const pending = !current && (isPending || stale);
  const read = useMemo<ConnectionsRead>(
    () => ({
      data: current,
      error: shownError,
      isPending: pending,
      refetch,
    }),
    [current, shownError, pending, refetch]
  );

  return { current, stale, read };
}
