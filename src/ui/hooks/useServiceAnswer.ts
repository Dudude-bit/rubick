import { useEffect, useRef } from "react";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";

import type { ResourceConnections, Scoped } from "@/generated/types";
import {
  useConnectionsKey,
  type ConnectionsQuery,
} from "@/hooks/useConnections";
import { useServiceWatch } from "@/hooks/usePodWatch";
import { useReadUid } from "@/hooks/useReadUid";
import { isResourceNotFoundError } from "@/hooks/useResourceDetail";
import { queryKeys } from "@/lib/query-keys";
import { ResourceType } from "@/lib/resource-registry";
import { speaksFor } from "@/lib/service-health";

/** How long after a read a second one is fresh rather than shared with it. */
const FRESH_READ_MS = 300;

export interface ServiceAnswer {
  /** The answer, where it can speak for the Service on screen. */
  current: ResourceConnections | undefined;
  /** An answer about this name that cannot: another Service's, or older than what its watch has seen. */
  stale: boolean;
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
  const { data, error, dataUpdatedAt } = query;
  const facts = data?.subject.facts;
  const selector = facts?.kind === "service" ? facts.selector : null;
  useServiceWatch(namespace, follow ? name : undefined, selector, [key]);
  const uid = useReadUid(ResourceType.Service, namespace, name);
  const pods = useQuery<Scoped<unknown>>({
    queryKey: queryKeys.serviceWatch("pods", namespace, name, selector),
    queryFn: skipToken,
  });
  const watched = pods.data
    ? { pods: pods.data.rows.length, at: pods.dataUpdatedAt }
    : undefined;
  const gone = isResourceNotFoundError(error);
  const current =
    data &&
    name &&
    !gone &&
    speaksFor({ data, at: dataUpdatedAt }, { name, uid }, watched)
      ? data
      : undefined;
  const stale = !!data && !gone && !current && data.subject.name === name;

  const asked = useRef<unknown>(null);
  useEffect(() => {
    if (!follow || !stale || asked.current === data) return;
    asked.current = data;
    if (uid && data.subjectUid && data.subjectUid !== uid)
      void client.resetQueries({ queryKey: key, exact: true });
    else
      setTimeout(
        () => void client.invalidateQueries({ queryKey: key, exact: true }),
        FRESH_READ_MS
      );
  }, [follow, stale, data, uid, client, key]);

  return { current, stale };
}
