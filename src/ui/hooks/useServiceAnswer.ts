import { useEffect, useMemo, useRef } from "react";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";

import type { ResourceConnections, Scoped } from "@/generated/types";
import {
  useConnectionsKey,
  type ConnectionsQuery,
  type ConnectionsRead,
} from "@/hooks/useConnections";
import { useServiceWatch } from "@/hooks/usePodWatch";
import { useReadThereAt, useReadUid } from "@/hooks/useReadUid";
import { isResourceNotFoundError } from "@/hooks/useResourceDetail";
import { queryKeys } from "@/lib/query-keys";
import { ResourceType } from "@/lib/resource-registry";
import { speaksFor } from "@/lib/service-health";

/** How long after a read a second one is fresh rather than shared with it. */
const FRESH_READ_MS = 300;

export interface ServiceAnswer {
  /** The answer, where it can speak for the Service on screen. */
  current: ResourceConnections | undefined;
  /** An answer about this name that cannot: another Service's, older than what its watch has seen, or a NotFound beside a Service its page holds. */
  stale: boolean;
  /**
   * The neighbourhood as every reader of the Service draws it, its status,
   * its trace, its tabs and its report alike: an answer that cannot speak
   * for it is one still being read, never a verdict.
   */
  read: ConnectionsRead;
}

/**
 * A Service's neighbourhood as its page and every verdict of it read it.
 * Where `follow` is set its pods and slices are watched while it is on
 * screen, each change reading `query` again, and an answer that cannot speak
 * for it is read again: at once where it is another Service's, which is wrong
 * in every reader of it, and once the read it shared has aged out where it is
 * only older than the pod its watch has seen.
 */
export function useServiceAnswer(
  name: string | undefined,
  namespace: string | null | undefined,
  query: ConnectionsQuery,
  follow: boolean
): ServiceAnswer {
  const client = useQueryClient();
  const key = useConnectionsKey(ResourceType.Service, name, namespace);
  const { data, error, dataUpdatedAt, errorUpdatedAt, isPending, refetch } =
    query;
  const facts = data?.subject.facts;
  const selector = facts?.kind === "service" ? facts.selector : null;
  useServiceWatch(namespace, follow ? name : undefined, selector, [key]);
  const uid = useReadUid(ResourceType.Service, namespace, name);
  const held = useReadThereAt(ResourceType.Service, namespace, name);
  const pods = useQuery<Scoped<unknown>>({
    queryKey: queryKeys.serviceWatch("pods", namespace, name, selector),
    queryFn: skipToken,
  });
  const watched = pods.data
    ? { pods: pods.data.rows.length, at: pods.dataUpdatedAt }
    : undefined;
  const notFound = isResourceNotFoundError(error);
  const current =
    data &&
    name &&
    !notFound &&
    speaksFor({ data, at: dataUpdatedAt }, { name, uid }, watched)
      ? data
      : undefined;
  // A NotFound beside a Service its page holds is one of the two reads behind
  // the other: the neighbourhood asked before it was created, or the page's
  // own read from before it was deleted. Either is read again, not drawn.
  const stale = notFound
    ? held > 0
    : !!data && !current && data.subject.name === name;

  const asked = useRef<unknown>(null);
  useEffect(() => {
    const created = errorUpdatedAt < held;
    const seen = notFound ? `${created}/${errorUpdatedAt}` : data;
    if (!follow || !stale || asked.current === seen) return;
    asked.current = seen;
    if (notFound)
      void client.invalidateQueries({
        queryKey: created
          ? key
          : queryKeys.detail(ResourceType.Service, namespace, name),
        exact: true,
      });
    else if (uid && data?.subjectUid && data.subjectUid !== uid)
      void client.resetQueries({ queryKey: key, exact: true });
    else
      setTimeout(
        () => void client.invalidateQueries({ queryKey: key, exact: true }),
        FRESH_READ_MS
      );
  }, [
    follow,
    stale,
    notFound,
    errorUpdatedAt,
    held,
    data,
    uid,
    client,
    key,
    namespace,
    name,
  ]);

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
