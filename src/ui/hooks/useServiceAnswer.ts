import { useEffect, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import type { ResourceConnections } from "@/generated/types";
import {
  useConnectionsKey,
  type ConnectionsQuery,
  type ConnectionsRead,
} from "@/hooks/useConnections";
import { useServiceWatch } from "@/hooks/usePodWatch";
import {
  useReadSelector,
  useReadThereAt,
  useReadUid,
} from "@/hooks/useReadUid";
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
  const uid = useReadUid(ResourceType.Service, namespace, name);
  const held = useReadThereAt(ResourceType.Service, namespace, name);
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

  const another = !!uid && !!data?.subjectUid && data.subjectUid !== uid;
  // Held only until the pod watch has listed: its list answers it, not a read.
  const listing = !notFound && !another && watched === "listing";
  const asked = useRef<unknown>(null);
  useEffect(() => {
    const created = errorUpdatedAt < held;
    const seen = notFound ? `${created}/${errorUpdatedAt}` : data;
    if (!follow || !stale || listing || asked.current === seen) return;
    asked.current = seen;
    if (notFound)
      void client.invalidateQueries({
        queryKey: created
          ? key
          : queryKeys.detail(ResourceType.Service, namespace, name),
        exact: true,
      });
    else if (another) void client.resetQueries({ queryKey: key, exact: true });
    else
      setTimeout(
        () => void client.invalidateQueries({ queryKey: key, exact: true }),
        FRESH_READ_MS
      );
  }, [
    follow,
    stale,
    listing,
    notFound,
    errorUpdatedAt,
    held,
    data,
    another,
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
