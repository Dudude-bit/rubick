import { useEffect, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import type { ResourceConnections } from "@/generated/types";
import {
  useConnectionsKey,
  type ConnectionsQuery,
  type ConnectionsRead,
} from "@/hooks/useConnections";
import { useServiceWatch } from "@/hooks/usePodWatch";
import { useHeldNotFound } from "@/hooks/useHeldRead";
import { useReadSelector, useReadUid } from "@/hooks/useReadUid";
import { isResourceNotFoundError } from "@/hooks/useResourceDetail";
import { ResourceType } from "@/lib/resource-registry";
import { speaksFor, waitsOnList, type SeenOf } from "@/lib/service-health";

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
  const { data, error, dataUpdatedAt, isPending, refetch } = query;
  const facts = data?.subject.facts;
  const uid = useReadUid(ResourceType.Service, namespace, name);
  // The Service's own read names its selector before any answer does, so its
  // pods are being listed by the time the first answer about them lands.
  const readSelector = useReadSelector(ResourceType.Service, namespace, name);
  const watched = useServiceWatch(
    namespace,
    name,
    {
      uid: uid ?? data?.subjectUid ?? undefined,
      selector:
        readSelector === undefined
          ? facts?.kind === "service"
            ? facts.selector
            : null
          : readSelector,
    },
    [key],
    follow
  );
  const seen = useMemo<SeenOf>(
    () => (service) =>
      service.kind === ResourceType.Service &&
      service.name === name &&
      (service.namespace ?? null) === (namespace ?? null)
        ? watched
        : undefined,
    [watched, name, namespace]
  );
  const notFound = isResourceNotFoundError(error);
  const notFoundHeld = useHeldNotFound(
    ResourceType.Service,
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
  // Held only until the pod watch has listed: its list answers it, not a read.
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
