import { useMemo } from "react";

import {
  useConnections,
  useConnectionsKey,
  type ConnectionsQuery,
} from "@/hooks/useConnections";
import { useHeldAnswer, type HeldAnswer } from "@/hooks/useHeldAnswer";
import { useServiceWatch } from "@/hooks/usePodWatch";
import { useReadSelector, useReadUid } from "@/hooks/useReadUid";
import { ResourceType } from "@/lib/resource-registry";
import { publishedFor } from "@/lib/published";
import { podsUnreadOf, type SeenOf } from "@/lib/service-health";

export type ServiceAnswer = HeldAnswer;

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
  const key = useConnectionsKey(ResourceType.Service, name, namespace);
  const facts = query.data?.subject.facts;
  const uid = useReadUid(ResourceType.Service, namespace, name);
  // The Service's own read names its selector before any answer does, so its
  // pods are being listed by the time the first answer about them lands.
  const readSelector = useReadSelector(ResourceType.Service, namespace, name);
  const watched = useServiceWatch(
    namespace,
    name,
    {
      uid: uid ?? query.data?.subjectUid ?? undefined,
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
  return useHeldAnswer(
    ResourceType.Service,
    name,
    namespace,
    query,
    key,
    seen,
    follow
  );
}

/** Whether a Service's pods were not read to say why none of its addresses is ready, from the answer its verdict on the same surface reads. */
export function useServicePodsUnread(
  name: string,
  namespace: string | null
): boolean {
  const query = useConnections(ResourceType.Service, name, namespace);
  const { data } = useServiceAnswer(name, namespace, query, false).read;
  return useMemo(
    () => podsUnreadOf(data && publishedFor(data, data.subject)),
    [data]
  );
}
